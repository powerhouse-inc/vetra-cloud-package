# Plans on releases in the console (2026-11-14)

## Problem

An App that publishes releases (connected repository, `vetra-publish`) still meets the old
licensing model first in the console:

1. the Artifacts and Templates tabs (services, packages, artifact channels);
2. a "plan" that is a licensing term pointing at a template;
3. only under that term, "Run on instances", which creates the real plan
   (`createPlan`: access, size, target release).

Step 1 is meaningless for such an App: since releases phase 2, every instance runs the
release's host image (spec 2026-11-11, section 6: "Platform Connect/Switchboard services,
template packages and channels are gone: the image carries the app"). Step 2 asks for a
template the new model never reads.

A second need came up with Stackfolio: a **shared** plan where every holder signs in to one
instance but sees only their own data (their own portfolio). A spike on 2026-11-14 showed that
Powerhouse already isolates this server-side (below).

## Scope

- **vetra.to:** for Apps with a repository, the console shows only the new model. One "New
  plan" dialog creates the licensing term and the plan together.
- **vetra-cloud-package:** one new plan field, `ownData`, for shared plans.
- **Not in scope:** removing the old model's code or tables in the backend (releases phase 3,
  slice 10); Sektar's switch-over (slice 9); Stackfolio's own changes (below, "Dependencies").
  Licensing-only Apps (Vetra Studio products, no repository) keep their current tabs.

## Spike: own data on a shared instance

Stackfolio 1.0.0 in a container on Postgres with `DOCUMENT_PERMISSIONS_ENABLED=true`,
`DEFAULT_PROTECTION=true`, one admin and two users (self-signed test identities,
`SKIP_CREDENTIAL_VERIFICATION` for the test only). Each user created a drive with a portfolio.

| The second user tries the first user's data | Result |
|---|---|
| read the portfolio or drive (`document`) | FORBIDDEN |
| write the portfolio (`setPortfolioDetails`) | FORBIDDEN |
| list drives, search portfolios (`findDocuments`) | own only |
| list the drive's nodes (`driveNodes`) | empty |
| Stackfolio's `portfolioApi.holdings(driveId)` | FORBIDDEN (owner gets data) |
| MCP `getDrives`, `getDrive`, `getDocument`, `getDocuments`, `addActions` | own only / FORBIDDEN |
| the host's shared drive `powerhouse` | FORBIDDEN |

The admin sees everything. Not tested: Connect in a browser with a real Renown sign-in, sync
endpoints, attachments. Seen at boot on Powerhouse 6.2.3-dev.96: "The readable-documents read
model could not start; index subgraphs serve only admins until it does" (the portfolio API still
answered its owner).

## Design

### 1. Tabs (vetra.to)

For an App with a repository, `LICENSING_TABS` loses `artifacts` and `templates`. Plans,
Holders and Invite codes stay. Licensing-only Apps (`LICENSING_ONLY_TABS`) are unchanged.
A URL with `?tab=templates` or `?tab=artifacts` on such an App opens Plans.

### 2. Plans tab (vetra.to)

One list, newest first:

- **Plans** (`appPlans`), each row: name, `shared` or `own instance`, size, holders, invite
  codes, target release with "x.y.z available" and **Roll out**, instance count, **Settings**
  (policy, update window, warm pool), Retire. Shared plans with `ownData` say "each holder sees
  only their own data". No template line.
- **Terms without a plan** (old model, e.g. Sektar's `sektar-cloud`): name, kind, holders,
  invite codes, and "Not on releases yet: these holders run on their old environments." No
  template line, no button. They move with the switch-over (slice 9).
- The **Team plan** card stays at the top, unchanged.

**New plan** opens the dialog below. It is disabled, with the reason as its tooltip and a line
under the header, when:

- the App has no release yet: "Publish a release first: a plan runs a release.";
- the App has environments on the old model (`createPlan` refuses them): "This App's licensed
  environments move to plans with the switch-over; new plans come after it."

The Overview's getting-started step "Create a plan" opens this dialog's tab as today.

### 3. New plan dialog (vetra.to)

| Field | Default | Rules |
|---|---|---|
| Name | — | required; the plan ID (term kind and plan slug) is derived as today (`kindFromLabel`), editable |
| Access | Own instance | `own` or `shared`, with the hints `ACCESS_HINT` already has |
| Each holder sees only their own data | on | shared only; explained: "Holders share one instance; each one's documents are private to them. You (admin) see all." |
| Size | M | `APP_PLAN_SIZES` |
| Release | newest release | releases only, never builds |
| Valid for (days) | empty (no end) | as today |
| How people get it | Invite code | invite code, you (publisher grant), or both, as today |

**Shared needs the gate.** When Access is shared and the chosen release's `powerhouseVersion`
is below the gate's minimum, the Save button is disabled and the dialog says: "Shared plans
need a release built on Powerhouse 6.2.3-dev.105 or later; 1.0.0 uses 6.2.3-dev.96." The
minimum comes from the backend (new field below), never from the console.

**Save** runs, in order:

1. `addTerm({appId, kind, label: name, validityDays, issuers})`, without a template;
2. `publishTerm(appId, termId)`;
3. `createPlan({appId, kind, access, slug: kind, name, size, targetVersion, ownData})`.

If a step fails, the dialog stays open, names the step ("The plan's term was created, but
creating the plan failed: …") and Save resumes after the last step that succeeded: an existing
DRAFT or ACTIVE term of that kind with no holders is reused, never created twice. Closing after
a partial failure leaves a term without a plan, which the list shows (section 2) with a
**Finish** button that reopens the dialog at step 3.

### 4. `ownData` on shared plans (vetra-cloud-package)

- **Table:** `plans.own_data boolean not null default false` (migration in
  `db/migrations.ts`, like `ensureAppsProductionEnvNullable`).
- **API:** `CreatePlanInput.ownData: Boolean` (shared plans only; `BAD_USER_INPUT` "Own data is
  for shared plans" on an own plan) and `AppPlan.ownData: Boolean!`. Not in `UpdatePlanInput`:
  it is fixed at creation. Turning it on later would leave every document created before
  unprotected (`DEFAULT_PROTECTION` applies to new documents only), so a plan that needs it
  is a new plan.
- **Settings:** where the reconciler adds the gate (`withGate`, `instances/reconciler.ts`), a
  shared instance of a plan with `own_data` also gets `DOCUMENT_PERMISSIONS_ENABLED=true` and
  `DEFAULT_PROTECTION=true`. They are part of the settings revision, so the existing delivery
  applies them. A publisher's own setting of either name on scope `plan` or `all` is
  overridden on such an instance (Vetra's wins), and the Settings tab says so.
- **Gate minimum:** `vetraAppsGate { minPowerhouse: String }` (query; null when the gate is
  off) so the console can explain the shared rule from section 3.
- **Audit:** `createPlan` already writes an audit entry; it now includes `ownData`.

### 5. Dependencies (Stackfolio, separate work)

For a shared plan with own data to be usable, Stackfolio needs:

1. a release on Powerhouse 6.2.3-dev.105 or later (the gate);
2. each holder gets their own drive: today the host seeds one shared drive `powerhouse` and
   Connect, as a remote client, opens it, but a holder may not read it. Either Connect creates
   the holder's drive on first sign-in, or it shows "Create your portfolio"
   (`connect.drives.allowAddDrive` is already true);
3. a browser test with real sign-ins of two holders.

## Error handling

- Every refusal of `addTerm`, `publishTerm` or `createPlan` is shown with the step and the
  backend's message (`describeAppsError`).
- The Plans tab shows plans and terms independently: if `appPlans` fails, terms still list, and
  the other way round, each with Retry.

## Testing

- **vetra.to (vitest, Testing Library):**
  - tabs: an App with a repository has no Artifacts or Templates tab; a licensing-only App
    still has them; `?tab=templates` falls back to Plans;
  - New plan disabled without a release and for an App with old environments, with the reasons;
  - the dialog: own data shown only for shared; shared refused below the gate minimum;
  - Save calls addTerm, publishTerm, createPlan in order with the right inputs; a failure at
    step 3 keeps the dialog open, and Save then calls only createPlan;
  - a term without a plan is listed with "Not on releases yet", or with Finish when it has no
    holders.
- **vetra-cloud-package (vitest, PGlite):** `ownData` stored and returned; refused on own plans;
  a shared instance of an `ownData` plan gets both settings, one without it does not; a
  publisher setting of the same name is overridden; the migration on an existing database.
- **Staging:** create a shared plan with own data for a test App on a dev.105 release; the
  instance's pod has both variables; redeem two invite codes and repeat the spike's checks.

## Rollout

1. vetra-cloud-package: `ownData` and `vetraAppsGate.minPowerhouse`; publish, pin on staging,
   smoke-check, then prod.
2. vetra.to: tabs, Plans tab and dialog; staging, then prod.

The backend change is additive (a boolean column with a default, a new optional input
field, a new query), so the console of today keeps working against it.
