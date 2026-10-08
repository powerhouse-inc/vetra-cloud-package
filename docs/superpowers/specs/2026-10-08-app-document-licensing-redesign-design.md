# App document licensing redesign

**Date:** 2026-10-08
**Status:** design, awaiting review
**Supersedes:** the `app-license-type` model and the licence-type parts of
`2026-10-06-license-driven-provisioning-design.md` and
`2026-10-07-licensing-product-model.md` (Gap 2 is resolved here). The
apps-as-documents migration in `2026-10-07-apps-as-document-models-design.md`
still stands; this spec adds to the document it introduces.
**Repos:** `vetra-cloud-package` (this repo), `vetra.io`, `renown-package`.
Achra is out of scope.

## Why

Licensing landed as three loosely connected things: an app (a table row, now
mirrored to a `vetra-app` document), one `app-license-type` document per tier
holding its own template, and one `app-owner-license` document per licence. A
publisher's app is spread over many documents that only reference each other by
id, the forms are detached from the app, and two of the product's real shapes —
many owners on one shared environment, and one owner with several environments —
cannot be expressed.

The target picture is one app document, owned by the publisher, holding
everything that describes the app and what it sells. Environments stay their own
documents. Issued licences stay their own documents.

## Personas

- **Publisher** — the app developer who builds and sells the app. Owns the
  `vetra-app` document and its App Environment (the `PRODUCTION`-linked
  environment).
- **Owner** — someone who bought a subscription or redeemed an invite code.
  Holds an `app-owner-license`. Depending on the template, the owner either gets
  an account on the publisher's App Environment, or gets their own Owner/Users
  Environment with themselves as admin.
- **User** — someone the owner invites into an environment. Managed inside the
  environment itself (Connect/Switchboard auth, Renown); Vetra does not model
  users.

## The matrix

| | Single environment | Multi environment |
|---|---|---|
| **Single owner** | SHARED template on the App Environment; one licence | DEDICATED template; one licence, one environment |
| **Multi owner** | SHARED template; many licences, one environment (pfnuer) | DEDICATED template; one environment per licence (Knowledge Vault) |

Single vs multi environment is decided **per template**, so one app can sell a
shared free tier and a dedicated pro tier.

## Document models

### `powerhouse/vetra-app` — extended

Existing fields (details, repository, identity, `productionEnvironmentId`,
previews, artifacts) are unchanged. Two lists are added:

```graphql
type VetraAppState {
  # ...existing fields...
  templates: [VetraAppEnvironmentTemplate!]!
  terms: [VetraAppLicenseTerm!]!
}

"""What an owner gets. The target of the handler's applyTemplate."""
type VetraAppEnvironmentTemplate {
  id: OID!
  name: String
  mode: TemplateInstanceMode!
  """SHARED only: the environment owners get an account on. Null means the App Environment."""
  sharedEnvironment: PHID
  """DEDICATED only: what is provisioned per licence."""
  services: [TemplateService!]!
  packages: [TemplatePackage!]!
  size: String
  baseDomain: String
  packageRegistry: URL
}

enum TemplateInstanceMode { SHARED  DEDICATED }

"""A licence kind the app hands out, e.g. 2026-free-tier, local-first-conf-2026."""
type VetraAppLicenseTerm {
  id: OID!
  """Unique within the app. What a licence carries."""
  kind: String!
  label: String
  templateId: OID
  validityDays: Int
  """Which issuers may issue this kind."""
  issuers: [LicenseIssuerKind!]!
  status: LicenseTermStatus!
}

enum LicenseTermStatus { DRAFT  ACTIVE  RETIRED }
enum LicenseIssuerKind { INVITE_CODE  PUBLISHER_GRANT  ACHRA_SUBSCRIPTION }
```

`TemplateService` and `TemplatePackage` move over from `app-license-type`
unchanged (artifact name + channel, as built yesterday).

New operations, module `licensing`:
`ADD_TEMPLATE`, `SET_TEMPLATE_DETAILS` (name, mode, sharedEnvironment, size,
baseDomain, packageRegistry), `ADD_TEMPLATE_SERVICE`, `REMOVE_TEMPLATE_SERVICE`,
`ADD_TEMPLATE_PACKAGE`, `REMOVE_TEMPLATE_PACKAGE`, `DELETE_TEMPLATE`,
`ADD_TERM`, `SET_TERM_DETAILS` (kind, label, templateId, validityDays, issuers),
`PUBLISH_TERM`, `RETIRE_TERM`.

Reducer rules:

- `kind` is unique within the app → `DuplicateKindError`.
- A term's `templateId` must exist → `TemplateNotFoundError`.
- `PUBLISH_TERM` requires a `templateId` and at least one issuer →
  `TermIncompleteError`.
- `DELETE_TEMPLATE` refuses while any term references it →
  `TemplateInUseError`.
- A SHARED template carries no services or packages → `SharedTemplateServicesError`
  on `ADD_TEMPLATE_SERVICE` / `ADD_TEMPLATE_PACKAGE`; switching a template to
  SHARED while it has services is refused the same way.
- A published term's `kind` cannot change (licences carry it) →
  `KindImmutableError`.
- `RETIRE_TERM` blocks new licences; existing licences run until they end.

Grace periods are not a field. A grace period is its own term
(`2026-starter-tier-30d-grace`) that the ending licence is replaced by.

### `powerhouse/app-owner-license` — reshaped to the diagram

```graphql
type AppOwnerLicenseState {
  issuer: LicenseIssuerKind
  """Renown DID of the owner. Replaces the EthereumAddress field."""
  user: String
  """The vetra-app document."""
  app: PHID
  """The environment this licence is bound to (shared or provisioned)."""
  stage: PHID
  """Term kind. Replaces the licenseType PHID."""
  kind: String
  """Issuer-specific JSON: invite code, grant actor, subscription id."""
  details: String
  issued: DateTime
  start: DateTime
  end: DateTime
  status: LicenseStatus!
  replacedBy: PHID
  revokedReason: String
}
```

Lifecycle operations are unchanged (`ISSUE_LICENSE`, `ACTIVATE_LICENSE`,
`EXPIRE_LICENSE`, `REVOKE_LICENSE`, `REPLACE_LICENSE`) plus `SET_STAGE`.
`issuedBy` moves into `details`.

### `powerhouse/vetra-cloud-environment` — unchanged

### `powerhouse/app-license-type` — removed after migration

## Issuers

All issuers end in one `issueLicense(app, user, kind, issuer, details)`, which:

1. loads the app document and checks `terms[kind]` exists, is `ACTIVE`, and lists
   this issuer (`TermNotIssuable` otherwise);
2. creates the licence document (system-signed, as today);
3. writes the `app_license_grants` provenance row — the keeper still ignores any
   licence without one;
4. if the owner asked to upgrade an existing licence, replaces it (see
   Upgrades).

| Issuer | Trigger | Check |
|---|---|---|
| `InviteCodeIssuer` | `redeemInviteCode(code)` by a logged-in DID | code active, not expired, under its use cap; its term allows `INVITE_CODE` |
| `PublisherGrantIssuer` | `issueGrant` from the publisher dashboard (exists) | caller owns the app; user on the allow list; term allows `PUBLISHER_GRANT` |
| Achra subscription | — | out of scope; the enum value exists so licences match the diagram |

### Invite codes absorb `vetra-access-codes`

`vetra-access-codes` was the precursor of the invite-code issuer. Its tables move
under licensing and gain `app_id` and `kind`; a code issues one term of one app.
Codes stay in tables, not documents: they are redeemable secrets, and some carry
an encrypted Claude key.

```
invite_codes        + app_id, + kind   (code, label, active, expires_at, max_uses,
                                         anthropic_key_ciphertext, created_at)
invite_redemptions  + license_id       (code, user_did, redeemed_at, access_expires)
```

Vetra Studio early access becomes a `vetra-app` published by Powerhouse with a
term `studio-early-access-30d` (validityDays 30, issuers `[INVITE_CODE]`). The
`VetraAccessCodes` API and subgraph are deleted in the same change; the
`ADMINS`-gated admin becomes ordinary publisher management of the studio app.

The studio pool keeps its warm-pool claim path — studios are not
template-provisioned. Its gate becomes "the caller holds an `ACTIVE` licence for
the vetra-studio app", and Claude-key injection reads the ciphertext from the
code behind that licence (`details.code`).

## The handler

`AppLicenseHandler` is the existing ProvisioningKeeper made generic: licence →
`app.terms[kind]` → `app.templates[templateId]` → by mode.

### Environments are keyed on the licence chain

One environment per licence chain, not per (app, user) and not per template.
`app_user_environments` is re-keyed to `environment_id` and records the current
licence and the chain's root licence.

- **New licence** (first purchase, or "buy another Knowledge Vault for a
  different project") → new environment. The owner names the project; it becomes
  the environment label.
- **Upgrade / downgrade** (free → pro) → `REPLACE_LICENSE`; the new licence
  inherits `stage`, and the handler re-applies the new template to the same
  environment in place.
- **Grace** → the ending licence is replaced by the grace-term licence, same
  mechanism, environment kept.

### DEDICATED

Upsert the environment from the template, set the owner, set `stage` on the
licence. Re-apply when the rendered template hash changes (as today). The
environment owner is the licence `user`'s address; the DID must be `did:pkh`, any
other method is refused at issue time (`UnsupportedDidError`).

### SHARED

Provision nothing. Set `stage` to `sharedEnvironment ?? app.productionEnvironmentId`.
The publisher's app decides access by asking `vetraLicensing.hasLicense(app, did)`.
Ending a licence never touches the shared environment.

### Offboarding (DEDICATED, licence ended without replacement)

| When | What |
|---|---|
| end − 7 days, end − 1 day | warning: licence expiring |
| end (EXPIRED / REVOKED) | warning: shutdown in 14 days |
| end + 14 days | environment `STOPPED` (data kept); warning: deletion in ~3 months |
| end + 83 days | final warning |
| end + 90 days | environment destroyed |

Re-licensing the same chain before deletion reactivates the stopped environment
instead of provisioning a new one. `app_user_environments` gains `stopped_at` and
`delete_after`. Warnings are surfaced as vetra.io banners and through the
existing notifications; email is out of scope.

### Template edits

Editing a template re-applies to every environment on it, so a bad edit reaches
all holders. This is accepted for now and called out in the publisher UI ("affects
N environments"); staged rollout is a follow-up.

## APIs

**`vetraPublisher`** (owner-authenticated, as today):

- remove the license-type mutations; add term and template CRUD mirroring the
  reducer operations above;
- invite codes for an owned app: `createInviteCode`, `deactivateInviteCode`,
  `inviteCodes(appId)` with redemption counts;
- allow list: `addToAllowList`, `removeFromAllowList`, `allowList(appId)`;
- `issueGrant`, `revokeLicense`, `licenses`, `environments` stay;
- `replaceGrant(licenseId, kind)` — publisher upgrades/downgrades a holder in
  place.

Until Achra exists, a licence changes hands only through these two paths: the
publisher grants or replaces, or the owner redeems a code (optionally as an
upgrade of a licence they hold). Self-service paid upgrade and "buy another"
arrive with the Achra subscription issuer and reuse the same `issueLicense` +
replace mechanism.

**`vetraLicensing`** (owner and app identities):

- `redeemInviteCode(code, label, upgrades?: licenseId)` — issues and returns the
  licence; with `upgrades`, the new licence replaces that one (same environment);
- `myLicenses` — the caller's licences with environment, status, warnings;
- `cancelLicense(licenseId)` — owner ends their own licence (`REVOKED`, reason
  `cancelled by owner`); starts the offboarding timeline;
- `hasLicense(appId, did)` — for SHARED apps checking access;
- `reportUserStat` — see Renown below.

## Renown: App Profile and user stats (`renown-package`)

Two new models:

- **`powerhouse/renown-app-profile`** — the app's public identity: app DID
  (`vetra-app.identity.did` already points at it), name, tagline, logo, website,
  publisher DID. Listed under the publisher's Renown profile.
- **`powerhouse/renown-user-stats`** — one document per user DID:
  `stats: [{ id, appDid, metric, value, updatedAt }]`. Apps report the **current
  value**, not deltas, so retries and duplicates are harmless and no event log
  grows. Reputation is the per-app metrics; Renown shows a cross-app total. Only
  the app's own DID may write metrics for that app, checked against the bearer's
  credential.

### Vetra relay

Owner/Users environments do **not** get the app's identity key — that would let
any environment write stats as the app for any user. Instead each provisioned
environment gets a per-environment reporting token in its secrets at provisioning.
The environment calls `vetraLicensing.reportUserStat(userDid, metric, value)`;
Vetra resolves environment → licence → app and forwards to Renown signed as the
app. Usage-to-billing will plug into the same relay later (out of scope).

## Migration

Staging first, then main. DB migrations are forward-only. One idempotent startup
step, like the app backfill:

1. Each `app-license-type` document → one template + one term in its app's
   document (`kind`, `label`, `validityDays`, services, packages kept; issuers
   `[PUBLISHER_GRANT]`; status mapped). Then the documents are deleted.
2. Each `app-owner-license` document: `licenseType` → `kind`; `user` address →
   `did:pkh:eip155:1:<addr>`; `issuedBy` → `details`; `stage` from
   `app_user_environments`.
3. `app_user_environments` re-keyed to `environment_id`, with `license_id`,
   `root_license_id`, `stopped_at`, `delete_after`.
4. Create the vetra-studio app document and its term; move `invite_codes` /
   `invite_redemptions` under licensing with `app_id` / `kind`; every live
   redemption becomes an `ACTIVE` licence (`start = redeemed_at`,
   `end = access_expires`); delete `subgraphs/vetra-access-codes` and the studio
   pool's import of it.

## vetra.io

Today an app lives in two places: `/user/apps/[id]` (overview, deployments,
settings via `modules/apps`) and `/user/publisher` ("Licensing", `modules/publisher`,
with its own app picker and its own `myApps`). Neither links to the other — the UI
mirror of the document split this spec removes. The redesign follows the model:
one place per app for the publisher, one place for what an owner holds.

### Publisher: one app page

`/user/apps/[id]` absorbs `modules/publisher`. The "Licensing" nav item,
`/user/publisher` (redirects to the app list) and the app picker go away; the
"app not ACTIVE" alert becomes a banner on the app page. Licensing tabs show only
to the app's owner.

| Tab | Content | From |
|---|---|---|
| Overview | URLs, App Environment, previews | existing |
| Deployments | as today | existing |
| Artifacts | published versions and channel pointers | the tier editor's artifact picker |
| Templates | list + editor: SHARED/DEDICATED switch, shared environment, services and packages with artifact/channel dropdowns, size; "affects N environments" before saving | `tier-detail.tsx` |
| Plans | terms: kind, label, template dropdown, validity, issuer checkboxes, publish/retire | Tiers tab |
| Holders | licences with status filters; grant (allow list managed here), replace (upgrade/downgrade), revoke; each row links its environment | Holders + Environments tabs |
| Invite codes | create (term, max uses, expiry, optional Claude key), deactivate, redemption counts, copyable `/redeem/<code>` link | new; replaces the `ADMINS` access-code admin |
| Settings | existing | existing |

`modules/publisher` hooks and components move under `modules/apps` (or stay a
module rendered by the app page); its typed `PublisherApiError` handling stays.

### Owner: subscriptions

- New nav item **Subscriptions**, `/user/subscriptions`: my licences grouped by
  app — kind, validity, status, offboarding banners (expiring, stops on, deleted
  on), *Open* (my environment for DEDICATED, the app URL for SHARED), *Cancel*.
- **`/redeem/<code>`** — shareable; validates the code, Renown login, then
  "new environment (name the project)" or "upgrade my existing licence" when the
  owner already holds one for that app. Replaces the code-entry step of the gate.
- Paid *Upgrade* / *Buy another* wait for Achra.

### Environments

Environments provisioned from a licence show the app name and offboarding state
and link back to the subscription. Creation and edits keep using the reactor
document controllers.

### Gate

`modules/invites` and `EarlyAccessGate` are replaced by a licence check for the
`vetra-studio` app (`hasLicense`). It gates **Studio and creating/publishing
apps** — the Vetra builder product. Subscriptions, owner environments and
`/redeem` need only a Renown login, so a Knowledge Vault buyer never needs a Vetra
code. Without the licence, gated pages show "redeem a code" pointing at
`/redeem`.

Studio creation: `use-studio-products` reads `hasAttachedKey` from the studio
licence; `applyInviteCodeSecret` becomes a licensing call resolving the key from
`details.code`; the warm-pool claim path is unchanged.

### Conventions

Unchanged stack: shadcn/Radix, react-hook-form + zod, TanStack Query via
`useAuthedQuery`, sonner toasts, typed API errors. Unit tests (vitest) per tab and
for the redeem flow; a Playwright pass over publisher (template → plan → code) and
owner (redeem → subscription → environment) journeys. vetra.io changes land on
staging first, then main.

## Error handling

- Reducer errors are named per operation (listed above); tests assert on the
  operation's `error`, never `toThrow`.
- `issueLicense` fails before creating a document when the term is not issuable,
  the code is invalid, or the DID method is unsupported — no orphan documents.
- A licence without a provenance row is held by the keeper (unchanged).
- A licence whose kind no longer resolves (term deleted out of band) is held and
  logged, never treated as "release".
- The relay refuses a stat from an environment whose licence is not `ACTIVE`.

## Testing

- vetra-app reducers: every error above; a scenario test building templates and
  terms end to end; ≥95% coverage.
- app-owner-license reducers: `SET_STAGE`, replace inheriting stage.
- Handler: the four matrix cells; upgrade re-templates in place; second purchase
  creates a second environment; SHARED never provisions or releases; offboarding
  timeline with a fake clock, including re-licensing a stopped environment.
- Issuers: each check, including cap and expiry on codes and term issuers.
- Migration: run twice without duplicates; licence-type → term/template fidelity;
  redemptions → licences.
- Studio pool: gate and key injection via the licence.
- Renown: only the app DID can write its metrics; current-value reports are
  idempotent.

## Out of scope

Achra (subscription issuer, reviews, App Profile listing, billing), owner-invited
users and seat limits, email delivery of warnings, staged template rollout,
builder teams.

## Implementation plans

One per repo: `vetra-cloud-package` (models, issuers, handler, APIs, migration,
relay), `vetra.io` (dashboard, owner pages, gate), `renown-package` (two models,
reporting API). vetra.io depends on the cloud-package API; the relay depends on
Renown's reporting API.
