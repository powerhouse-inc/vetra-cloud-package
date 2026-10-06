# License-driven environment provisioning — slice 1

**Date:** 2026-10-06
**Status:** draft, for review
**Scope:** the first of four slices (see *Decomposition* at the end)

## Intent

A user holds a *licence*; a licence produces a *running environment*. Nothing else
grants an environment, and nothing else takes one away.

Today an environment is created by a hard-coded action list in two places
(`subgraphs/vetra-apps/service.ts:589-601` for production, `:1232-1249` for previews,
and again in `subgraphs/vetra-studio-pool/create-env.ts:44-101`). There is no
declarative "create an environment from a description" API anywhere in the repo.
Building one, and driving it from licence state, is this slice.

Success for this slice is narrow and testable: **in staging, issuing a licence by hand
produces an environment from a template; running the reconciler again changes nothing;
expiring or revoking the licence stops it.**

## Decisions already taken

| Decision | Resolution |
|---|---|
| Who runs the handler | The publisher, in their app environment, from a Vetra-generated template |
| Who owns the machinery | Vetra: the models, the issuer mechanisms, the lifecycle clock, the licence types, `applyTemplate` |
| Managing vs. handling | Managing licences is Vetra's; handling them is the publisher's. These are different things |
| React vs. reconcile | Reconcile. Desired state computed from current licence status, diffed against reality |
| Tier contents | The publisher's call. Vetra surfaces cost and enforces a cap; it does not constrain what a tier contains |
| MVP quadrant | Multi-Owner, Multi-Environment — one environment per subscriber |

## Decisions taken in this spec (overturnable at review)

1. **Two new document models, not three.** The environment template lives *inside*
   the licence type rather than as its own model. A shared template referenced by
   several types is the obvious slice-3 refinement; duplicating a small template
   across two or three types is cheaper than a third model at ~800 hand-written
   lines plus tests at the 95% branch-coverage floor.
2. **`PublisherGrantIssuer` is the only issuer in slice 1.** It has no external
   dependency. Invite codes already work as early-access gating
   (`subgraphs/vetra-access-codes/`) and generalising them is a migration with its
   own risk; the achra issuer needs achra-side work. Both are slice 2.
3. **The handler is a keeper on a timer, not an operation processor.** The diagram
   draws `AppLicenseHandler` reacting to `LICENSE_*` events. A timer-driven
   reconciler is strictly better here: it has no replay semantics to get wrong, it
   self-heals after any missed event, and it already has two working precedents in
   this repo. An event subscription is added purely to shorten latency, exactly as
   `vetra-studio-pool` does (keeper at `keeper.ts:34-55`, plus a deletion
   subscription at `index.ts:137-145`).
4. **A minimal per-app environment cap ships in slice 1**, though full cost
   surfacing is slice 3. Provisioning driven by three issuers with no ceiling is the
   risk flagged in the evaluation; the check is one comparison and belongs with the
   first provisioning path, not after it.

## Out of scope for slice 1

achra integration and the subscription issuer; invite-code issuance; publisher-facing
UI; per-tier cost display; template variables and ranges; the knowledge vault package
itself; billing and usage metering; stage promotion.

## Conventions this spec follows

From the project's `CLAUDE.md`, because they constrain the schemas above and are easy to
get wrong:

- **Both models are authored through `reactor-mcp`, not by hand.** The `.json` spec is the
  source of truth; everything under `gen/` is generated and must never be edited. Changing
  a reducer means doing it in *both* places — the MCP action and the file in `src/`.
- **Almost every field is nullable.** A user must be able to create an empty document, so
  `!` appears only where there is a logical default: the status enums and the two
  collections (`[T!]!` — no nulls inside, empty array by default).
- Objects inside arrays carry `id: OID!`. `PHID` is only for pointing at *other*
  documents, which is why `app`, `licenseType`, `stage` and `replacedBy` are `PHID` while
  `TemplateService.id` is `OID`.
- Reducers are pure and synchronous. No `Date.now()`, no `crypto.randomUUID()` — every
  timestamp and id arrives in the action input. This is why `ISSUE_LICENSE` takes
  `issued`, `start` and `end` rather than computing them from `validityDays`: the *caller*
  resolves the type's duration into dates.
- Every rejection is a named error added via `ADD_OPERATION_ERROR` (`NotLicenseOwnerError`,
  `LicenseTypeRetiredError`, `InvalidStatusTransitionError`, …), not `throw new Error`.
  Each one is a branch that needs its own test.
- Input types are named `<OperationName>Input` exactly, or codegen breaks.

## The model

### `powerhouse/app-license-type`

What a kind of grant *is*. Created by the publisher, read by the handler.

Extension `.lict`.

```graphql
type AppLicenseTypeState {
  app: PHID
  kind: String               # stable identifier, e.g. "2026-free-tier"
  label: String
  validityDays: Int          # null = open-ended
  template: EnvironmentTemplate
  status: LicenseTypeStatus! # DRAFT | ACTIVE | RETIRED, initial DRAFT
}

type EnvironmentTemplate {
  services: [TemplateService!]!
  packages: [TemplatePackage!]!
  size: String               # key into CLINT_RESOURCE_MAP; null for browser-only
  baseDomain: String
  packageRegistry: URL
}

type TemplateService {
  id: OID!
  type: TemplateServiceType! # CONNECT | SWITCHBOARD | CLINT
  prefix: String
}

type TemplatePackage {
  id: OID!
  packageName: String
  version: String
}
```

`kind` stays a string, but it is now the *type's own name*, not something a handler
switches on. The licence points at the type by `PHID`; the handler resolves and
applies. Adding the 2027 pro tier is creating a document.

Vintaging works unchanged: `2026-free-tier` and `2027-free-tier` are two documents,
and `RETIRED` stops new issuance without disturbing existing holders.

### `powerhouse/app-owner-license`

One grant to one user.

Extension `.lic`.

```graphql
type AppOwnerLicenseState {
  app: PHID
  licenseType: PHID
  user: EthereumAddress      # the holder
  issuer: LicenseIssuerKind  # INVITE_CODE | PUBLISHER_GRANT | ACHRA_SUBSCRIPTION
  issuedBy: EthereumAddress  # which identity actually issued it
  stage: PHID                # nullable in slice 1; stages are not modelled yet
  details: String            # JSON-encoded, see note below
  issued: DateTime
  start: DateTime
  end: DateTime              # null = open-ended
  status: LicenseStatus!     # ISSUED | ACTIVE | EXPIRED | REVOKED | REPLACED, initial ISSUED
  replacedBy: PHID
  revokedReason: String
}
```

Three departures from the diagram, all forced or deliberate:

- **`AID` does not exist.** There is no such scalar in this repo — the available set is
  `String`, `Int`, `Float`, `Boolean`, `OID`, `PHID`, `OLabel`, the `Amount_*` family,
  `EthereumAddress`, `EmailAddress`, `Date`, `DateTime`, `URL`, `Currency`. The holder is
  therefore `EthereumAddress`, matching `owner: EthereumAddress` on
  `vetra-cloud-environment`. Note the codebase is already inconsistent here: the
  environment keys on a raw address while `invite_redemptions.user_did` keys on a DID
  string built as `did:pkh:{networkId}:{chainId}:{address}`. The subgraph side keys on
  the DID; the reducer normalises to a lowercased address. See open question 5.
- **`Json` does not exist either**, so `details` is a JSON-encoded `String`. This is the
  same untyped escape hatch as `runtimeConfig`, and it carries the same caveat: nothing
  validates it. It is acceptable only because nothing in slice 1 reads it — it is an
  audit payload, never a control input. If the handler ever branches on `details`, it
  needs a schema first.

- `issuer` is split into `issuer` (which mechanism) and `issuedBy` (which identity).
  A publisher grant can be handed out in bulk; "who did this" is the audit question
  that matters, and the mechanism alone cannot answer it.
- `stages: PHID!` is named plural, typed singular and non-null. Slice 1 makes it
  `stage: PHID`, nullable, because stages are not modelled yet and an achra
  subscription licence has no obvious stage to point at. Revisit in slice 2.

Actions: `ISSUE_LICENSE`, `ACTIVATE_LICENSE`, `EXPIRE_LICENSE`, `REVOKE_LICENSE`,
`REPLACE_LICENSE`.

`ISSUE_LICENSE`, `REVOKE_LICENSE` and `REPLACE_LICENSE` are publisher-callable.
`ACTIVATE_LICENSE` and `EXPIRE_LICENSE` are the clock's alone — a publisher who wants a
licence gone revokes it rather than expiring it, so that the reason is recorded and the
two paths stay distinguishable in an audit.

Every transition is guarded: `InvalidStatusTransitionError` rejects anything that is not
`ISSUED → ACTIVE | REVOKED`, `ACTIVE → EXPIRED | REVOKED | REPLACED`. `EXPIRED`,
`REVOKED` and `REPLACED` are terminal; a user who should get access again receives a new
licence.

## `applyTemplate` — the API the handler calls

Four operations on the Vetra switchboard, in a new `vetra-licensing` subgraph. All
authenticated as the App identity (see *Authorization*), all scoped to one app.

```graphql
appLicenses(appId: PHID!, status: LicenseStatus): [AppOwnerLicense!]!
appLicenseTypes(appId: PHID!): [AppLicenseType!]!
appUserEnvironments(appId: PHID!): [AppUserEnvironment!]!

applyEnvironmentTemplate(input: ApplyTemplateInput!): AppUserEnvironment!
releaseEnvironment(input: ReleaseInput!): Boolean!
```

**`applyEnvironmentTemplate` is an upsert, keyed on `(appId, user)`.** This is the
single most important property in the design: it is what lets the handler call it on
every tick without guarding anything. Given an app, a user and a licence type it
ensures exactly one environment exists for that pair, matching that template, and
returns it. Called twice with the same arguments, the second call is a no-op.

Implementation: a `app_user_environments` table in the subgraph's own namespace
(`app_id`, `user_aid`, `environment_id`, `license_id`, `template_hash`, timestamps),
primary key `(app_id, user_aid)`, upserted with `onConflict(...).doUpdateSet(...)` —
the pattern already used at `processors/vetra-cloud-environment/processor.ts:155-159`.
`template_hash` is how an existing environment is recognised as stale when its type's
template changes.

Internally it renders the template into the action list that already exists and runs it
through the richer of the two gateways — `EnvGateway` in
`subgraphs/vetra-apps/envs.ts:13-27`, which detects reducer rejections. The studio
pool's `ReactorLike.execute` silently swallows them and must not be used here.

`releaseEnvironment` drives the environment to `STOPPED`. It does not destroy. Archival
and destruction stay with the existing housekeeping ladder.

### The cap

`applyEnvironmentTemplate` refuses with `APP_ENVIRONMENT_CAP_REACHED` when the app
already holds `max_environments` environments and the call would create a new one.
Updating an existing one is always allowed, so a cap can never strand a user who
already has an environment. The limit is a column on the app with a configured default.

## The generated handler

`ph generate license-handler` emits a subgraph into the publisher's package: a keeper,
a pure plan function, and tests. The default body is the whole of it:

```ts
export function computeLicensePlan(
  licenses: ActiveLicense[],
  environments: AppUserEnvironment[],
): LicensePlan {
  const desired = new Map(licenses.map((l) => [l.user, l]));
  const toApply = [...desired.values()];
  const toRelease = environments
    .filter((e) => !desired.has(e.user))
    .map((e) => e.environmentId);
  return { toApply, toRelease };
}
```

Pure, synchronous and separately tested, mirroring `computePoolPlan` at
`subgraphs/vetra-studio-pool/reconcile.ts:64-99`.

The keeper copies `HousekeepingKeeper` (`subgraphs/vetra-housekeeping/keeper.ts:177-193`)
rather than `PoolKeeper`, because it has the re-entrancy guard `PoolKeeper` lacks, and
its config defaults `DRY_RUN` to **true** — a handler that logs its plan before it is
trusted to act is the right default for code a publisher just generated.

A publisher who needs more than "every active licence gets its type's template" edits
this file. Most never will.

**Note on codegen.** `ph generate processor --type` is a closed
`oneOf(["analytics", "relationalDb"])` with no custom-template mechanism, and a
reconciler is not an operation processor anyway. This is a new generator alongside the
existing ones, not an extension of that enum.

## The lifecycle clock

A `LicenseKeeper` in the `vetra-licensing` subgraph, Vetra-side, same shape:

```ts
computeLicenseTransitions(licenses, now) -> { toActivate, toExpire }
```

`ISSUED → ACTIVE` when `start <= now`. `ACTIVE → EXPIRED` when `end != null && end <= now`.
`REVOKED` and `REPLACED` are explicit, never inferred.

Timestamps are stored and compared as ISO-8601 strings, normalised on write. The
access-code tables store timestamps as `varchar` and compare them lexically, which
works only because every value happens to be normalised — `normalizeExpiresAt` at
`subgraphs/vetra-access-codes/db/codes.ts:379-384` is the load-bearing part. Here
normalisation is in the reducer, not at the edge.

## Authorization

The caller is an App identity. `App.identityDid` already exists on `feat/vetra-apps`,
with a Renown delegation, a 365-day expiry and a sweeper that moves an App to
`PENDING_IDENTITY` when it lapses.

Every operation resolves the caller's DID to the App whose `identity_did` matches, and
scopes to that `appId`. A caller may never name another app's id. The existing admin
gate (`shared/admins.ts`, one global boolean from a comma-separated `ADMINS` env var)
is not sufficient and is not used here.

A licence may only be issued for an app the caller owns, and only against a licence
type belonging to that same app.

## Replay and idempotency

Three independent guarantees, because one is not enough:

1. The handler is timer-driven, so it has no replay semantics at all.
2. `applyEnvironmentTemplate` is an upsert on `(appId, user)`, so repeated calls
   converge.
3. Where an event subscription is added for latency, the subscription only *triggers*
   a reconcile; it never carries the decision.

Nothing in this design reads `context.ordinal`, and nothing needs a watermark. If a
future processor is added, `ProcessorRecord` supports `startFrom: "current"`, which the
current factory does not set.

## Testing

- `computeLicensePlan` and `computeLicenseTransitions`: pure-function tables covering
  every status, a licence with no end date, an expired licence whose environment is
  already stopped, and a user holding two licences.
- `applyEnvironmentTemplate` called twice: second call creates nothing.
- Template change: `template_hash` differs, existing environment is updated not
  duplicated.
- Cap reached: new user refused, existing user still updated.
- Authorization: an App identity naming another app's id is rejected.
- Document model reducers at the repo's 95% branch-coverage floor.

## Open questions

1. **Does a user hold one licence per app, or may they hold several?** The design
   assumes one active licence per `(app, user)`; `computeLicensePlan` would need a
   precedence rule otherwise.
2. **What happens to data when a licence is replaced by a smaller tier?** The
   lifecycle is expressible; the policy is not decided. Slice 1 applies the new
   template and does not inspect the data.
3. **Does a replacement licence inherit the old `end` date?** Affects mid-cycle tier
   changes.
4. **Where do stages fit?** `stage` is nullable here as a placeholder.
5. **Address or DID as the user key?** The repo does both — `vetra-cloud-environment`
   keys on a lowercased `EthereumAddress`, `invite_redemptions` keys on a
   `did:pkh:...` string. Slice 1 stores the address on the document and the DID in the
   subgraph table, normalising at the boundary. That works but it is one more place the
   two conventions can drift, and slice 2 brings in the invite-code issuer, which lives
   on the DID side. Worth settling before then.

## Decomposition

| Slice | Contents |
|---|---|
| **1 (this spec)** | The two models, `applyTemplate`, the generated handler, the clock, `PublisherGrantIssuer`, a minimal cap |
| 2 | Invite-code and achra subscription issuers; stages; licence precedence |
| 3 | Per-tier cost surfaced where the publisher defines a tier; full App-level resource budget |
| 4 | The knowledge vault package: its tiers, templates and publisher UX |
