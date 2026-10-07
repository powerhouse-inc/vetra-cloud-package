# Publisher dashboard — design

**Date:** 2026-10-07
**Status:** approved (conversational), implementation authorised "one shot"
**Builds on:** `2026-10-06-license-driven-provisioning-design.md`

## Intent

A publisher — concretely, the colleague who owns the Knowledge Vault — must be
able to onboard a paying customer without anyone running GraphQL by hand and
without operating any infrastructure of their own.

Agreed in conversation:

- **Scope:** define tiers, grant a licence, revoke a licence, see who holds what
  and which environments exist.
- **One surface:** the dashboard does everything, including tier authoring. The
  Connect editor for `app-license-type` (shipped 2026-10-07) remains as a raw
  document-editing path, not the product surface.
- **Boundary:** *"the reconciler should run in the cloud package. vetra.io only
  offers the ui."*

Success: the owner grants a licence to an address in the dashboard, and an
environment running `@powerhousedao/knowledge-note` appears for that holder
without further action.

## The constraint that shapes everything

The licensing API cannot be called by a person. `subgraphs/vetra-licensing/auth.ts`
derives the app id from `ctx.user.appKey`, an App's `did:key` that reactor-api
sets only when the bearer is an App delegation, and says so deliberately:

> The caller is an App identity presenting its did:key (`user.appKey`), never a
> person: a human wallet address is not an accepted identity here.

A browser session carries a wallet address, not an App delegation, so every
existing licensing field returns `UnauthenticatedError` to a human. The dashboard
therefore needs a **new, human-authenticated surface**; it is not a UI over the
existing one.

**The `appId` invariant becomes conditional.** Today no resolver anywhere takes
an `appId` argument, because an App must never be able to name another App's id.
A human may own several apps and must say which one. The invariant is therefore
restated, and both halves must hold:

- **Machine callers** never pass `appId`; it is always derived from `appKey`.
  This path is unchanged, byte for byte.
- **Human callers** pass `appId`, and it is authorised against
  `apps.owner_address` on every single call.

Nothing in the existing machine path is relaxed to serve the human path.

## Architecture

Three components, two repositories.

```
vetra.io (UI only)
  modules/publisher/*  ──HTTPS+Renown bearer──┐
                                              │
vetra-cloud-package (switchboard)             ▼
  subgraphs/vetra-licensing/
    publisher-auth.ts      resolveOwnerApp(ctx, appId) → owner or admin
    publisher-resolvers.ts the human surface (namespace: vetraPublisher)
    provisioning-keeper.ts server-side reconcile: licences → environments
```

### Component 1 — owner-authenticated surface

**`publisher-auth.ts`**

```ts
export interface OwnerAppRecord {
  id: string;
  status: string;
  owner_address: string;
}

export interface PublisherAuthDeps {
  findAppById(id: string): Promise<OwnerAppRecord | null>;
  listAppsForOwner(address: string): Promise<OwnerAppRecord[]>;
  isAdmin(address: string): boolean;
}

/** Authorises a human caller against one app they own. */
export async function resolveOwnerApp(
  deps: PublisherAuthDeps,
  ctx: AuthContext,
  appId: string,
): Promise<{ appId: string }>;
```

Rules, in order, each with its own error class:

1. No `ctx.user.address` → `UnauthenticatedError`.
2. App not found → `UnknownAppError`.
3. `app.owner_address !== address.toLowerCase()` **and** not a platform admin →
   `NotAppOwnerError`.
4. `app.status !== "ACTIVE"` → `AppIdentityInactiveError`.

Admins are the existing platform admins (`shared/admins.ts`, driven by the
`ADMINS` env var that `vetra-apps` already uses), so support can act on a
publisher's behalf without a second mechanism.

Rule 4 applies to owners too: licensing provisions real infrastructure, and an
app whose identity delegation has lapsed should not keep minting licences. This
mirrors the machine path rather than inventing a softer rule for humans.

**Schema** — a new top-level namespace, `vetraPublisher`, kept separate from
`vetraLicensing` so the two authentication models are never confused at a
glance.

Queries:

| Field | Args | Returns |
|---|---|---|
| `myApps` | — | `[PublisherApp!]!` — apps this wallet owns; the app picker |
| `licenseTypes` | `appId` | `[PublisherLicenseType!]!` |
| `licenses` | `appId`, `status` | `[PublisherLicense!]!` |
| `environments` | `appId` | `[AppUserEnvironment!]!` |

`myApps` takes no argument — it is derived from the wallet, and is the one field
that must not accept an app id.

Mutations (every one authorises first):

| Field | Args | Effect |
|---|---|---|
| `createLicenseType` | `appId`, `kind`, `label`, `validityDays` | creates the document, returns its id |
| `setLicenseTypeDetails` | `licenseTypeId`, details | |
| `setLicenseTypeTemplate` | `licenseTypeId`, `size`, `baseDomain`, `packageRegistry` | |
| `addLicenseTypeService` | `licenseTypeId`, `type`, `prefix` | |
| `addLicenseTypePackage` | `licenseTypeId`, `packageName`, `version` | |
| `publishLicenseType` | `licenseTypeId` | DRAFT → ACTIVE |
| `retireLicenseType` | `licenseTypeId` | ACTIVE → RETIRED |
| `issueGrant` | `appId`, `user`, `licenseTypeId` | wraps `issuePublisherGrant`; returns the licence id |

`issueGrant` passes an `isOnAllowList` that always returns true, as the existing
wiring does. That is correct here and not a gap being carried forward: the caller
has already been authorised as the owner of the app, and choosing who may hold a
licence to your own product is the publisher's prerogative. The allow list was
designed for a machine caller that had not proven ownership.
| `revokeLicense` | `licenseId`, `reason` | REVOKED |

For the fields keyed on a document id rather than an app id, authorisation reads
the document's own `app` field and authorises **that** app for the caller. A
licence type belonging to someone else's app is indistinguishable from one that
does not exist (`UnknownLicenseTypeError`), so the surface is not an oracle for
other publishers' document ids.

### Component 2 — provisioning keeper

A server-side reconciler in the cloud package, the same shape as `LicenseKeeper`:
`setInterval`, a re-entrancy guard, and `cfg.enabled` / `cfg.dryRun` defaulting
to off and dry.

Each tick:

1. Read every licence across all apps, with `app`, `user`, `licenseType` and
   `status` (today `reads.listLicenses()` returns only the clock fields, so this
   needs a richer read — `reads.allLicenses()`).
2. Group by app.
3. Per app, reuse the existing pure planner `computeLicensePlan` against the
   current `app_user_environments` rows.
4. Apply `applyEnvironmentTemplate` for each `toApply`, and `releaseEnvironment`
   for each `toRelease`, logging and continuing on individual failures so one bad
   licence cannot stall the fleet.

This is deliberately **not** an instance of `reference-handler/handler.ts`. That
file is the codegen template a publisher would run; keeping the server-side
reconciler separate leaves the template free to evolve as a template.

The keeper calls `applyEnvironmentTemplate` directly, so it does not pass through
`resolveCallerApp` — it is trusted server-side code with an app id it derived
itself, exactly as `LicenseKeeper` already acts without a caller.

### Component 3 — vetra.io UI

Pure presentation on the `staging` branch. It follows the existing cloud module
pattern exactly: token-taking fetchers in `modules/publisher/graphql.ts`, read
through `useAuthedQuery`, which injects the Renown bearer that becomes
`ctx.user.address` on the switchboard.

Route `app/publisher/`:

- an app picker, shown only when `myApps` returns more than one;
- **Tiers** — list, create, edit, add service, add package, publish, retire;
- **Holders** — licences with status, holder, tier and linked environment; a
  grant form; a revoke action behind a confirmation;
- **Environments** — the `app_user_environments` rows.

No licensing logic lives here. Every rule is enforced by the switchboard; the UI
only disables controls to match, the way the Connect editor mirrors
`publishLicenseTypeOperation`'s preconditions.

## The journey, end to end

1. Liberuum opens `/publisher`, signed in with Renown. `myApps` returns the
   Knowledge Vault app.
2. He creates a tier, adds a CONNECT service and the
   `@powerhousedao/knowledge-note` package, and publishes it.
3. He grants a licence to a customer's address. `issueGrant` creates an
   `app-owner-license` document, status `ISSUED`.
4. `LicenseKeeper` moves it `ISSUED → ACTIVE` on its next tick.
5. The provisioning keeper sees an active licence with no environment, calls
   `applyEnvironmentTemplate`, and an environment document is created and
   deployed through the existing gitops path.
6. The Holders tab shows the licence as active with its environment.
7. Revoking sets `REVOKED`; the provisioning keeper releases the environment on
   its next tick.

Steps 4 and 5 require `LICENSING_KEEPER_ENABLED=true` and
`LICENSING_DRY_RUN=false` in the staging tenant. Both default off, and turning
them on is a deployment change, not a code change.

## Known limitations, accepted

**Tiers are append-only.** `app-license-type` has `ADD_TEMPLATE_SERVICE` and
`ADD_TEMPLATE_PACKAGE` but no remove operations, so a service or package added
by mistake cannot be taken out — the tier has to be retired and replaced. The
dashboard will say so where a publisher would otherwise be surprised. Adding
remove operations is a document-model change and is out of scope here.

**CLINT is selectable but not provisionable.** The model's enum carries it while
the subgraph refuses it. The UI flags it rather than hiding it, as the Connect
editor already does.

**Publishing a RETIRED tier reactivates it.** `publishLicenseTypeOperation` does
not check the current status. Out of scope; recorded so it is not mistaken for a
dashboard bug.

**No entitlement on package install.** Licensing gates *environment
provisioning*, not catalogue access. Anyone can still `ph install` the package
from the registry. Connecting the two is a separate piece of design.

**Retiring a tier does not end service for existing holders.** The provisioning
keeper provisions from a RETIRED licence type, and `templateFor` on the machine
surface agrees. Retire means "no new grants"; the licence is the entitlement and
the type is only where the template comes from, so a holder with an active
licence keeps their environment and can have one created. Revoking the licence is
how an environment goes away. This overrode the spec during implementation and is
recorded here so that it is not "fixed" back: making a retired tier stop serving
would silently take down paying holders when a publisher merely tidied their tier
list.

**A holder with two active licences gets an arbitrary one.**
`computeLicensePlan` picks the lowest licence id, and ids are UUIDs, so granting a
Pro licence to someone who already holds a Free one silently does nothing about
half the time, with no error and no log, until the old licence expires or is
revoked. The mirror case can silently downgrade a holder. The 2026-10-06 spec
records this as Open question 1; the dashboard makes a second grant one-click
routine, so it belongs here too. It is deliberately not fixed in this branch:
choosing a precedence rule settles an open spec question, which belongs with the
UI work.

**The provisioning keeper trusts the app id declared by a document.** It groups
licences by the `app` field of the licence document and provisions under that app
with no caller proving ownership, so forged `app-license-type` and
`app-owner-license` documents naming a victim's app id would make the keeper
provision attacker-chosen packages into that app. This is not reachable through
this subgraph, and reachability otherwise depends on the reactor's document-write
ACLs, which are not verified from this repository. It is a threat-model item that
must be settled before anyone sets `LICENSING_KEEPER_ENABLED=true`, because this
branch escalates the trust from "an App identity must call a mutation" to "a
document alone creates infrastructure".

## Error handling

Backend errors carry a specific class and message and are surfaced verbatim by
the UI, which invents no error text of its own. The gate order on every field is:
authenticate, authorise, then — **on mutations only** — the licensing-disabled
check (`LicensingDisabledError`).

Reads stay available when licensing is disabled, exactly as on the machine
surface, so an operator can inspect a deployment that is switched off. That
means the dashboard renders tiers, holders and environments on a disabled
deployment while every button refuses with the disabled error, which is the
behaviour to design the UI for rather than a degraded state to hide.

The provisioning keeper never throws out of a tick: a failure on one app is
logged and the rest continue, and the next tick retries from the durable state.

## Testing

- **Unit** — `resolveOwnerApp` across owner, admin, non-owner, unknown app and
  inactive app; one case per error class.
- **Resolver** — every publisher field against a throwing-Proxy database,
  asserting that an unauthorised call touches neither the database nor the
  reactor, not merely that it threw.
- **Integration** — the provisioning keeper against a real in-process reactor and
  a real PGlite database, following
  `__tests__/provision-reactor.integration.test.ts`: a granted licence becomes an
  environment, a second tick is a no-op, and a revoked licence releases it.
- **Cross-publisher isolation** — an explicit test that publisher A cannot read
  or mutate publisher B's licence types, licences or environments. This is the
  security property of the whole design and gets its own test, not a line in
  another one.

Every test must fail if the behaviour it covers is removed; this branch has
already shipped four tests that could not fail.

## Slices

1. **Owner-authenticated read surface + dashboard read views.** `resolveOwnerApp`,
   `myApps`, `licenseTypes`, `licenses`, `environments`, and the vetra.io pages
   that render them. Delivers visibility and proves the auth model.
2. **Mutations.** Tier authoring, `issueGrant`, `revokeLicense`, and their UI.
   Delivers onboarding.
3. **Provisioning keeper.** Makes a grant produce an environment by itself.

Each slice leaves the system working and independently useful.
