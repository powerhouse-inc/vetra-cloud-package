# Releases phase 3, plan 2: audit log and release-manager role — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two things.
- Every plan change, settings change, role change, recorded release or build, and instance status change of an App goes into an **audit log**: who, what, when, from where (`console`, `api`, `policy`, `system`, `ci`). The log is kept one year and can be read page by page by anyone who may view the App.
- The App's owner (personal App) or the organisation's OWNER/ADMIN (org App) can name **release managers** per App. A release manager may do what spec section 10 gives them (plans and publisher settings now, rollouts with slice 3) without being an org admin or publisher.

**Architecture:**
- Two new tables in the vetra-apps namespace: `app_audit` (append-only, swept after 365 days) and `app_roles` (who holds `release_manager` on which App, under which owner).
- `loadAppForOwner(…, { need })` gains two levels: `"release"` (operators **or** release managers) and `"administer"` (personal owner, org OWNER/ADMIN, platform admins). `"view"` also admits a release manager. The checks live in `roles/access.ts` (`canRelease`, `isReleaseManager`, `allows`) and `shared/org-access.ts` (`canAdminister`).
- People's audit rows are written **in the same transaction** as the change they describe (plans, settings, roles), so a change is never left without its row. The actor is the caller's address. The source is `console` when the request's `Origin` is the console (`cfg.vetraAppUrl`), else `api`. It is stored on `Caller.source` by the GraphQL resolvers.
- Instance status changes are audited in **one place**: `instances/repo.ts` `updateInstance`, the only writer of `instances.status` (the reconciler, plan sync and branch deletion all go through it; `recordHealth` never writes status). Only a patch that carries `status` pays for it: a `SELECT … FOR UPDATE` of the old status, and an audit row only when it differs. Patches without `status` are unchanged: one `UPDATE`, as today.
- `ciReportRelease` writes `release.recorded` / `build.recorded` in the transaction that first stores the release row, so a retry of the same report adds nothing.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 10 (the permissions table; the audit log: every action, every release reported, every instance status change; who, what, when, from where; shown on the App page; kept 1 year);
- section 11 (the App page's Audit log);
- 14.5 ("support access … audited", which slice 7 writes into this log).

Slice scope and decision D7: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` (slice 2; gap 10; D7 = the role lives in Vetra per App, assigned by owner/org admins, not in Renown). Conventions: `2026-11-12-releases-phase-3-plan-1-plans-and-plan-instances.md`.

## Decisions to confirm (recommended default first; the plan is written with the default)

- **A1 Source `console` vs `api`.** `console` when the request's `Origin` header has the origin of `cfg.vetraAppUrl` (`VETRA_APP_URL`, production `https://vetra.io`), else `api`. Browsers set `Origin` themselves, so vetra.to needs no change. A non-browser client can fake it. The field is informational and never used for authorisation.
- **A2 Actors.** A person: their lowercased address. CI: the address CI acts for (`CiIdentity.address`, the publisher), with the GitHub login and run id in `detail`. `system` and (from slice 3) `policy` rows: the constant `vetra`.
- **A3 Settings audit carries no value at all**, plain or secret: only the name, scope, `secret`, and `replaced`. Reason: plain values are operator-only today (`appSettingsFor`), while the audit log is readable by anyone who may view the App (any org member).
- **A4 A release manager of an org App must still be a member of the org** (any role, org not disputed). Leaving the org ends the role in effect. On a personal App, any Renown address can be named.
- **A5 Roles lapse when the App changes hands.** Each grant records the owner it was given under (`owner_scope` = `org:<id>` or `user:<address>`). A grant from another owner is ignored and not listed. The new owner names release managers again.
- **A6 What a release manager may do now:** view the App (and its plans, instances, releases and audit), read and write publisher settings, and create, update, retarget and retire plans. Not: edit the App, deploy, roll back, delete, or name roles. Slice 3 gives them rollouts. Spec 10 keeps "Turn on the Team plan, add templates" for owner and org admins; slice 6 must use `need: "administer"` there.
- **A7 Paging and retention.** Default page 50, max 200, newest first, opaque cursor (`nextBefore`). 365 days, swept every 15 minutes, at most 5,000 rows per pass. Audit rows outlive a deleted App until the sweep removes them.
- **A8 What is audited from the reconciler:** only status **changes** (`from` ≠ `to`), including `removed`. Not instance creation (its first change, `pending → updating`, shows it), not health verdicts, not target moves (those are audited at the plan or the release). Builds are audited (one row per CI build).
- **A9 At most 50 role holders per App.**
- **A10 Known gap:** a release manager of a **personal** App does not see it in "My apps" (`myApps`). They reach it by link. A `myApps` change is a follow-up if wanted.
- **A11 Licensing's old-model actions** (`vetraReleases.promoteRelease` etc. on Sektar's licensed environments) are **not** written to `app_audit`: that model goes away in slice 10, and its tables already record `promoted_by`.

## What exists today (checked 2026-11-12 on `main` = 0.0.116)

- **Access** (`subgraphs/vetra-apps/service.ts`):
  - `loadAppForOwner(deps, caller, appId, opts)` (line ~315): `assertNotWorkload` (an App identity's token is refused), `getApp`, DELETED → NOT_FOUND, `syncAppOrg`, then `opts.need === "view" ? canView : canOperate` on `callerAccess(caller)` / `appResource(app)` (`org-ownership.ts`), else FORBIDDEN `"Not allowed to manage this App"`.
  - `AppAccessOptions { includeDeleted?; need?: "view" | "operate" }`.
  - `shared/org-access.ts`: `canOperate` (platform admin; personal owner; org OWNER/ADMIN, PUBLISHER in scope; a disputed org grants nothing), `canView` (any member), private `membershipOf` (a Renown failure is "no membership", logged). Org roles (`shared/renown-orgs.ts`): OWNER, ADMIN, PUBLISHER, MEMBER. Tests: `shared/org-access.test.ts` (`orgsWith`, `m(role)`, `user`, `admin`).
  - There is **no** per-App role and no "org admins only" check anywhere.
- **Caller** (`auth.ts`): `{ address (lowercased), chainId, appKey, isAdmin }`. `AppsContext.headers` holds the request headers. `resolvers.ts` has a local `requireCaller(ctx)` that also refuses CI bearers, and `guard(deps, name, run)`. `createResolvers(deps)` returns `{ Query, Mutation, … }`. `resolvers.test.ts` "SDL" asserts every Query/Mutation field has a resolver (it calls `createResolvers({} as never)`, so `deps` may only be read inside resolvers).
- **Plans** (`plans/service.ts`): `createPlan`, `updatePlanFor`, `setPlanTarget`, `retirePlan` call `loadAppForOwner` with the default `operate` (`loadPlan` for the last three). `appPlansFor` uses `need: "view"`. Writes go through `plans/repo.ts` (`insertPlan`, `updatePlan(db, id, patch, nowIso)`), which take any `Kysely<VetraAppsDB>`, a transaction included. A unique violation (`23505`) on insert becomes BAD_USER_INPUT. `retirePlan` returns early for a retired plan.
- **Settings** (`settings/service.ts`): `appSettingsFor`, `setAppSetting`, `deleteAppSetting` use the default `operate`. `setAppSetting` already writes inside `deps.db.transaction()` with the `apps` row locked (`forUpdate`). Logs carry names only, never values. `FROM_SCOPE` maps `all|branch|preview` to `ALL|BRANCH|PREVIEW`. `settings/repo.ts` `deleteAppSetting(db, appId, scope, name): Promise<boolean>`.
- **Instance writes** (`instances/repo.ts`): `updateInstance(db, id, patch, nowIso)` is the only writer of `status`:
  - the reconciler's `patch` (`instances/reconciler.ts` line ~273) and `markBranchDeleted` (line ~1211);
  - plan sync's `patch` (`plans/sync.ts` line ~164, only when `changed(row, p)`).
  - `recordHealth` writes health columns only. `insertInstance` creates rows with `status: "pending"`.
  - The reconciler already writes only on change: e.g. the error path re-reads and patches `failed` only `if (now.status !== "failed" || now.reason !== reason)`.
- **Releases** (`releases/service.ts` `ciReportRelease`): after the checks and the attestation, `insertRelease(deps.db, row)` returns `{ row, created }` (`ON CONFLICT DO NOTHING` + re-read), and `created` is false for a repeat. `run` is the verified claim run id. `CiIdentity { address, chainId, appDid, claim: VetraClaim | null }`, and `claim.actor` is the GitHub login.
- **Migrations** (`db/migrations.ts`): `up` ends with `ensurePlansTable`, `ensureInstancesPlanColumns`. Pattern: schema builder only (the tables live in a namespaced schema via `withSchema`), `ifNotExists`, `catch (err) { if (!isConcurrentIndexError(err)) throw err; }`. Timestamps are `varchar(64)` ISO strings, JSON is `text`.
- **Periodic jobs** (`index.ts`): `every(ms, name, run)` (no overlap, errors logged). `SWEEP_INTERVAL_MS` = 15 min (`watcher.ts`). Instance jobs only when `cfg.instances.enabled`.
- **Test harness** (`__tests__/harness.ts`):
  - `makeHarness(cfg?)`: PGlite with vetra-apps, observability and licensing tables.
  - `deps.now()` advances 1 ms per call (strictly increasing), `deps.newId()` = `id-N`.
  - `fakeOrgs()` with `join(orgId, address, role, scope?)`, `members` map keyed `"<org>|<address>"`, `publishers`.
  - Callers `owner` (OWNER, appKey USER_KEY), `stranger` (STRANGER), `admin` (platform admin), `member` (MEMBER); `ORG`, `APP_DID`.
  - `seedActiveApp(h)`. `testConfig({ plans: { enabled: true, stopAfterDays: 14 } })`. `testConfig().vetraAppUrl` = `"https://vetra.io"`.
  - An App moves into an org in tests with `h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null })` followed by `appForOwner(h.deps, admin, appId)` (`org-apps.test.ts` `moveToOrg`).
  - `instances-fixtures.ts` `seedRelease(h, appId, { version, run, kind? })`. Reconciler tests turn instances on with `apps.instances_enabled = true, registry_namespace = "acme"` and mark an environment ready with `h.envs.setStatus(envId, "READY")`.
- **Nothing audit-like to reuse:**
  - vetra-licensing's `licensing-ledger.ts` (`app_licensing_state`) is a tamper hash of app documents, not a who-did-what log.
  - `app_rollouts.promoted_by` and `app_license_grants.issued_by` are single columns.
  - `app_deployments` keeps `actor_github`/`actor_did` per deploy.
  - So `app_audit` is new and duplicates none of them.

## Model (as built here)

**`app_audit`**

| Column | Meaning |
|---|---|
| `id` | random UUID |
| `app_id` | the App |
| `at` | ISO time of the change (the same `nowIso` the change was written with) |
| `actor` | lowercased address, or `vetra` (system, policy) |
| `source` | `console` \| `api` \| `policy` \| `system` \| `ci` |
| `action` | one of `AUDIT_ACTIONS` (below) |
| `subject` | `plan:<planId>`, `setting:<SCOPE>/<NAME>`, `role:<address>`, `instance:<instanceId>`, `release:<version>` |
| `detail` | JSON object, string values cut at 500 characters; never a setting value or a secret |

Indexes: `(app_id, at, id)` for paging, `(at)` for the sweep.

| Action | Source | Detail |
|---|---|---|
| `plan.created` | console/api | `slug, name, kind, access, size, targetVersion` |
| `plan.updated` | console/api | `slug, changes: { name?: {from,to}, size?: {from,to} }` (only when something changed) |
| `plan.target_set` | console/api | `slug, from, to` (only when it changed) |
| `plan.retired` | console/api | `slug` (once) |
| `setting.set` | console/api | `name, scope, secret, replaced` |
| `setting.deleted` | console/api | `name, scope` (only when a row was deleted) |
| `role.granted` / `role.removed` | console/api | `address, role` (only on an actual change) |
| `instance.status` | system | `kind, name, from, to, reason, targetVersion, runningVersion, planId` |
| `release.recorded` / `build.recorded` | ci | `version, kind, branch, pr, commit, run, digest, githubActor, githubRun` |

**`app_roles`** — primary key `(app_id, address, role)`. `role = 'release_manager'` (the only one). `owner_scope` is the owner the grant was made under (`org:<orgId>` or `user:<address>`). `granted_by`, `granted_at`.

**Access levels** (`loadAppForOwner` `need`):

| need | Who |
|---|---|
| `view` | `canView` (platform admin, personal owner, any member of a non-disputed owning org) **or** an effective release manager |
| `operate` (default) | `canOperate`, unchanged |
| `release` | `canOperate` **or** an effective release manager |
| `administer` | platform admin, personal owner, org OWNER/ADMIN of a non-disputed org |

An **effective release manager**: an `app_roles` row for `(app, caller, release_manager)` whose `owner_scope` equals the App's current owner scope, and, for an org App, `canView` (still a member, org not disputed).

## Global Constraints

- Additive schema only, through idempotent, race-tolerant `ensure…` migrations in the schema builder (namespaced). No existing column or table changes.
- Existing callers keep exactly their rights. `need: "operate"` is unchanged. The new levels only **add** release managers (`view`, `release`) or are new (`administer`).
- People's audit rows are written in the same transaction as the change. A failed audit insert fails the change.
- No setting value (plain or secret), ciphertext or token ever reaches `app_audit` or a log line.
- The reconciler path: a patch without `status` issues exactly the one `UPDATE` it issues today. A status patch with an unchanged status writes no audit row. A steady state writes nothing (tested).
- Mutations that change plans or settings use `need: "release"`. `setAppRole`/`removeAppRole` use `need: "administer"`. `appAudit`, `appRoles`, `appAccess` use `need: "view"`.
- No new kill switch: the log and the role are inert until someone names a release manager, and auditing is cheap. The sweep always runs.
- Commits: one per task, conventional (`feat(audit): …`, `feat(roles): …`, `feat(plans): …`, `feat(settings): …`, `feat(instances): …`, `feat(releases): …`, `feat(apps): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-audit` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, and `npx vitest run subgraphs/vetra-apps shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4): check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.

## File structure

| File | Change |
|---|---|
| `shared/org-access.ts` | `canAdminister` |
| `subgraphs/vetra-apps/db/schema.ts` | `AuditSource`, `AppAuditTable`, `AppRoleName`, `AppRolesTable`; `VetraAppsDB.app_audit`, `.app_roles` |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureAppAuditTable`, `ensureAppRolesTable` in `up` |
| `subgraphs/vetra-apps/audit/repo.ts` (new) | `AUDIT_ACTIONS`, `AUDIT_SYSTEM_ACTOR`, `AuditEntry`, `recordAudit`, `listAudit`, `sweepAudit`, `boundDetail` |
| `subgraphs/vetra-apps/audit/service.ts` (new) | `callerSource`, `auditCaller`, cursor, `appAuditFor`, `sweepAuditOnce` |
| `subgraphs/vetra-apps/roles/repo.ts` (new) | `app_roles` reads and writes |
| `subgraphs/vetra-apps/roles/access.ts` (new) | `ownerScopeOf`, `isReleaseManager`, `canRelease`, `allows`, `AppNeed` |
| `subgraphs/vetra-apps/roles/service.ts` (new) | `appRolesFor`, `setAppRole`, `removeAppRole`, `appAccessFor` |
| `subgraphs/vetra-apps/auth.ts` | `CallerSource`, `Caller.source?` |
| `subgraphs/vetra-apps/service.ts` | `loadAppForOwner` uses `allows`; `AppAccessOptions.need: AppNeed` |
| `subgraphs/vetra-apps/plans/service.ts` | `need: "release"`; audit rows in transactions |
| `subgraphs/vetra-apps/settings/service.ts` | `need: "release"`; audit rows in transactions |
| `subgraphs/vetra-apps/instances/repo.ts` | `updateInstance` audits status changes; `instanceStatusEntry` |
| `subgraphs/vetra-apps/releases/service.ts` | insert + audit in one transaction |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | `AppAuditEntry`, `AppAuditPage`, `AppRole`, `AppAccess`; `appAudit`, `appRoles`, `appAccess`, `setAppRole`, `removeAppRole`; `Caller.source` for audited mutations |
| `subgraphs/vetra-apps/index.ts` | audit retention sweep |
| Tests | `shared/org-access.test.ts`, `subgraphs/vetra-apps/__tests__/migrations.test.ts`, `releases-report.test.ts` (extended); `audit-api.test.ts`, `roles-api.test.ts`, `plans-audit.test.ts`, `settings-audit.test.ts`, `audit-instances.test.ts`, `audit-graphql.test.ts` (new) |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-3-audit origin/main`. Never stash, and never touch the other worktrees of this repository (`git worktree list` shows them).
- [ ] **Step 2: Baseline.** `npx vitest run subgraphs/vetra-apps shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record failures that exist before any change in the PR description; do not fix them here.

---

### Task 1: `canAdminister` (org OWNER/ADMIN only)

**Files:**
- Modify: `shared/org-access.ts`
- Test: `shared/org-access.test.ts`

**Interfaces:**
- Produces: `canAdminister(orgs: MembershipReader | null, caller: AccessCaller, r: OwnedResource): Promise<boolean>`. Platform admin: true. Personal resource: the owner (any case). Org resource: false when `orgDisputed`, else membership role OWNER or ADMIN. A Renown failure is "no membership" (false).

- [ ] **Step 1: Write the failing test.** In `shared/org-access.test.ts` add `canAdminister` to the import from `./org-access.js`, and append:

```ts
describe("canAdminister", () => {
  it("personal: the owner and platform admins; org: OWNER and ADMIN only; never a disputed org; Renown down refuses", async () => {
    const personal = { owner: OWNER, ownerOrgId: null, appDid: APP };
    expect(await canAdminister(orgsWith(null), user(OWNER), personal)).toBe(true);
    expect(await canAdminister(orgsWith(null), user(BOB), personal)).toBe(false);
    expect(await canAdminister(orgsWith(null), admin, personal)).toBe(true);
    const org = { owner: OWNER, ownerOrgId: "org-1", appDid: APP };
    expect(await canAdminister(orgsWith(m("OWNER")), user(BOB), org)).toBe(true);
    expect(await canAdminister(orgsWith(m("ADMIN")), user(BOB), org)).toBe(true);
    expect(await canAdminister(orgsWith(m("PUBLISHER")), user(BOB), org)).toBe(false);
    expect(await canAdminister(orgsWith(m("MEMBER")), user(BOB), org)).toBe(false);
    expect(await canAdminister(orgsWith(null), user(OWNER), org)).toBe(false);
    expect(
      await canAdminister(orgsWith(m("OWNER")), user(BOB), { ...org, orgDisputed: true }),
    ).toBe(false);
    expect(
      await canAdminister(orgsWith(new RenownOrgsUnavailableError("down")), user(BOB), org),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run shared/org-access.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`canAdminister` is not exported).
- [ ] **Step 3: Implement.** In `shared/org-access.ts`, after `canView`:

```ts
/**
 * Who may name an App's release managers (releases phase 3 D7): platform
 * admins, the personal owner, and the owning org's OWNER/ADMIN. Publishers
 * operate an App but do not hand out rights to it.
 */
export async function canAdminister(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  r: OwnedResource,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (!r.ownerOrgId) return !!r.owner && r.owner.toLowerCase() === caller.address.toLowerCase();
  if (r.orgDisputed) return false;
  const m = await membershipOf(orgs, r.ownerOrgId, caller.address);
  return m?.role === "OWNER" || m?.role === "ADMIN";
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add shared/org-access.ts shared/org-access.test.ts && git commit -m "feat(roles): canAdminister (owner, org OWNER/ADMIN, platform admins)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: `app_audit` and `app_roles` tables, their repos

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`
- Create: `subgraphs/vetra-apps/audit/repo.ts`, `subgraphs/vetra-apps/roles/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Produces (schema): `AuditSource = "console" | "api" | "policy" | "system" | "ci"`; `AppAuditTable { id; app_id; at; actor; source: AuditSource; action; subject; detail }` (all `string` except `source`); `AppRoleName = "release_manager"`; `AppRolesTable { app_id; address; role: AppRoleName; owner_scope; granted_by; granted_at }`; `VetraAppsDB.app_audit`, `VetraAppsDB.app_roles`.
- Produces (migrations): `ensureAppAuditTable(db)`, `ensureAppRolesTable(db)`, both called at the end of `up`.
- Produces (`audit/repo.ts`):
  - `AUDIT_ACTIONS` (readonly tuple, the actions in the Model table), `AuditAction`;
  - `AUDIT_SYSTEM_ACTOR = "vetra"`, `AUDIT_DETAIL_STRING_MAX = 500`;
  - `AuditEntry { appId; at; actor; source: AuditSource; action: AuditAction; subject; detail?: Record<string, unknown> }`;
  - `AppAuditRow = Selectable<AppAuditTable>`;
  - `boundDetail(d?): string`;
  - `recordAudit(db, e: AuditEntry): Promise<AppAuditRow>`;
  - `AuditCursor { at; id }`;
  - `listAudit(db, appId, { limit, before?: AuditCursor | null }): Promise<AppAuditRow[]>` (newest first by `at`, then `id`);
  - `sweepAudit(db, cutoffIso, batch): Promise<number>`.
- Produces (`roles/repo.ts`): `AppRoleRow = Selectable<AppRolesTable>`; `getAppRole(db, appId, address, role)`; `listAppRoles(db, appId, ownerScope)` (by `granted_at`, `address`); `hasAppRole(db, appId, address, role, ownerScope): Promise<boolean>`; `upsertAppRole(db, row): Promise<AppRoleRow>`; `deleteAppRole(db, appId, address, role): Promise<boolean>`.

- [ ] **Step 1: Write the failing test.** In `migrations.test.ts` add `ensureAppAuditTable, ensureAppRolesTable` to the import from `../db/migrations.js`, add

```ts
import { listAudit, recordAudit, sweepAudit } from "../audit/repo.js";
import {
  deleteAppRole,
  getAppRole,
  hasAppRole,
  listAppRoles,
  upsertAppRole,
} from "../roles/repo.js";
import type { VetraAppsDB } from "../db/schema.js";
```

and append:

```ts
describe("app_audit and app_roles", () => {
  it("are created idempotently and concurrently in the namespace schema; audit pages newest first; the sweep deletes old rows only; roles keep their owner scope", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all(
        [1, 2, 3].flatMap(() => [ensureAppAuditTable(any), ensureAppRolesTable(any)]),
      );
      const db = any as unknown as Kysely<VetraAppsDB>;

      const entry = (at: string, appId = "app-1") => ({
        appId,
        at,
        actor: "0xaa",
        source: "api" as const,
        action: "plan.created" as const,
        subject: "plan:p1",
        detail: { note: "x".repeat(600) },
      });
      const old = await recordAudit(db, entry("2025-01-01T00:00:00.000Z"));
      expect((JSON.parse(old.detail) as { note: string }).note).toHaveLength(501);
      await recordAudit(db, entry("2026-11-12T00:00:00.000Z"));
      await recordAudit(db, entry("2026-11-12T00:00:01.000Z", "app-2"));
      const page = await listAudit(db, "app-1", { limit: 10 });
      expect(page.map((r) => r.at)).toEqual([
        "2026-11-12T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
      ]);
      expect(
        (await listAudit(db, "app-1", { limit: 10, before: { at: page[0].at, id: page[0].id } })).map(
          (r) => r.id,
        ),
      ).toEqual([old.id]);
      expect(await sweepAudit(db, "2026-01-01T00:00:00.000Z", 100)).toBe(1);
      expect(await listAudit(db, "app-1", { limit: 10 })).toHaveLength(1);

      const role = {
        app_id: "app-1",
        address: "0xbb",
        role: "release_manager" as const,
        owner_scope: "user:0xaa",
        granted_by: "0xaa",
        granted_at: "2026-11-12T00:00:00.000Z",
      };
      await upsertAppRole(db, role);
      await upsertAppRole(db, { ...role, owner_scope: "org:o1", granted_at: "2026-11-12T01:00:00.000Z" });
      expect(await listAppRoles(db, "app-1", "user:0xaa")).toEqual([]);
      expect((await listAppRoles(db, "app-1", "org:o1")).map((r) => r.address)).toEqual(["0xbb"]);
      expect(await hasAppRole(db, "app-1", "0xbb", "release_manager", "org:o1")).toBe(true);
      expect(await hasAppRole(db, "app-1", "0xbb", "release_manager", "user:0xaa")).toBe(false);
      expect(await getAppRole(db, "app-1", "0xbb", "release_manager")).toMatchObject({
        owner_scope: "org:o1",
      });
      expect(await deleteAppRole(db, "app-1", "0xbb", "release_manager")).toBe(true);
      expect(await deleteAppRole(db, "app-1", "0xbb", "release_manager")).toBe(false);
    } finally {
      await root.destroy();
    }
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (modules not found).
- [ ] **Step 3: Schema.** In `db/schema.ts`, after `PlansTable`:

```ts
/** Where an audited action came from (spec section 10). */
export type AuditSource = "console" | "api" | "policy" | "system" | "ci";

/** One audited action on an App (spec section 10): who, what, when, from where. Kept 365 days. */
export interface AppAuditTable {
  id: string;
  app_id: string;
  at: string;
  /** Lowercased address, or "vetra" for Vetra itself (system, policy). */
  actor: string;
  source: AuditSource;
  /** audit/repo.ts AUDIT_ACTIONS. */
  action: string;
  /** plan:<id> | setting:<SCOPE>/<NAME> | role:<address> | instance:<id> | release:<version> */
  subject: string;
  /** JSON object; never a setting value or secret. */
  detail: string;
}

/** Per-App roles Vetra keeps itself (releases phase 3 D7; Renown has no such role). */
export type AppRoleName = "release_manager";

export interface AppRolesTable {
  app_id: string;
  /** Lowercased address. */
  address: string;
  role: AppRoleName;
  /** The App's owner when granted: org:<orgId> | user:<address>. A grant under another owner has no effect. */
  owner_scope: string;
  granted_by: string;
  granted_at: string;
}
```

and in `VetraAppsDB`, after `plans: PlansTable;`:

```ts
  app_audit: AppAuditTable;
  app_roles: AppRolesTable;
```

- [ ] **Step 4: Migrations.** In `db/migrations.ts`, append to `up` after `await ensureInstancesPlanColumns(db);`:

```ts
  await ensureAppAuditTable(db);
  await ensureAppRolesTable(db);
```

and after `ensureInstancesPlanColumns`:

```ts
/** The audit log (releases phase 3 slice 2, spec section 10). Schema builder only (namespaced). */
export async function ensureAppAuditTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("app_audit")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("at", "varchar(64)", (c) => c.notNull())
      .addColumn("actor", "varchar(255)", (c) => c.notNull())
      .addColumn("source", "varchar(16)", (c) => c.notNull())
      .addColumn("action", "varchar(64)", (c) => c.notNull())
      .addColumn("subject", "varchar(512)", (c) => c.notNull())
      .addColumn("detail", "text", (c) => c.notNull())
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  for (const [name, columns] of [
    ["app_audit_app_at_idx", ["app_id", "at", "id"]],
    ["app_audit_at_idx", ["at"]],
  ] as const) {
    try {
      await db.schema
        .createIndex(name)
        .ifNotExists()
        .on("app_audit")
        .columns([...columns])
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  }
}

/** Per-App roles (release managers, releases phase 3 D7). Schema builder only (namespaced). */
export async function ensureAppRolesTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("app_roles")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("address", "varchar(255)", (c) => c.notNull())
      .addColumn("role", "varchar(32)", (c) => c.notNull())
      .addColumn("owner_scope", "varchar(320)", (c) => c.notNull())
      .addColumn("granted_by", "varchar(255)", (c) => c.notNull())
      .addColumn("granted_at", "varchar(64)", (c) => c.notNull())
      .addPrimaryKeyConstraint("app_roles_pk", ["app_id", "address", "role"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}
```

- [ ] **Step 5: `audit/repo.ts`.**

```ts
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { AppAuditTable, AuditSource, VetraAppsDB } from "../db/schema.js";

export type AppAuditRow = Selectable<AppAuditTable>;

/** Every action the audit log records (spec section 10). Later slices add theirs here. */
export const AUDIT_ACTIONS = [
  "plan.created",
  "plan.updated",
  "plan.target_set",
  "plan.retired",
  "setting.set",
  "setting.deleted",
  "role.granted",
  "role.removed",
  "instance.status",
  "release.recorded",
  "build.recorded",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The actor of rows Vetra writes itself (source system or policy). */
export const AUDIT_SYSTEM_ACTOR = "vetra";
/** Longer string values in a detail are cut (error messages, reasons). */
export const AUDIT_DETAIL_STRING_MAX = 500;

export interface AuditEntry {
  appId: string;
  /** When the change was written (ISO). */
  at: string;
  actor: string;
  source: AuditSource;
  action: AuditAction;
  subject: string;
  /** Never a setting value, secret, ciphertext or token. */
  detail?: Record<string, unknown>;
}

export function boundDetail(d: Record<string, unknown> = {}): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d))
    out[k] =
      typeof v === "string" && v.length > AUDIT_DETAIL_STRING_MAX
        ? `${v.slice(0, AUDIT_DETAIL_STRING_MAX)}…`
        : v;
  return JSON.stringify(out);
}

/** Appends one row. Pass the transaction of the change it describes. */
export async function recordAudit(
  db: Kysely<VetraAppsDB>,
  e: AuditEntry,
): Promise<AppAuditRow> {
  return db
    .insertInto("app_audit")
    .values({
      id: randomUUID(),
      app_id: e.appId,
      at: e.at,
      actor: e.actor,
      source: e.source,
      action: e.action,
      subject: e.subject.slice(0, 512),
      detail: boundDetail(e.detail),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A position in an App's log: rows strictly older than it come next. */
export interface AuditCursor {
  at: string;
  id: string;
}

export async function listAudit(
  db: Kysely<VetraAppsDB>,
  appId: string,
  o: { limit: number; before?: AuditCursor | null },
): Promise<AppAuditRow[]> {
  let q = db.selectFrom("app_audit").selectAll().where("app_id", "=", appId);
  const b = o.before;
  if (b)
    q = q.where((eb) =>
      eb.or([
        eb("at", "<", b.at),
        eb.and([eb("at", "=", b.at), eb("id", "<", b.id)]),
      ]),
    );
  return q.orderBy("at", "desc").orderBy("id", "desc").limit(o.limit).execute();
}

/** Deletes up to `batch` rows older than cutoffIso; returns how many. */
export async function sweepAudit(
  db: Kysely<VetraAppsDB>,
  cutoffIso: string,
  batch: number,
): Promise<number> {
  const r = await db
    .deleteFrom("app_audit")
    .where(
      "id",
      "in",
      db.selectFrom("app_audit").select("id").where("at", "<", cutoffIso).limit(batch),
    )
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
```

- [ ] **Step 6: `roles/repo.ts`.**

```ts
import type { Kysely, Selectable } from "kysely";
import type { AppRoleName, AppRolesTable, VetraAppsDB } from "../db/schema.js";

export type AppRoleRow = Selectable<AppRolesTable>;

export async function getAppRole(
  db: Kysely<VetraAppsDB>,
  appId: string,
  address: string,
  role: AppRoleName,
): Promise<AppRoleRow | null> {
  return (
    (await db
      .selectFrom("app_roles")
      .selectAll()
      .where("app_id", "=", appId)
      .where("address", "=", address)
      .where("role", "=", role)
      .executeTakeFirst()) ?? null
  );
}

/** The App's grants made under its current owner (ownerScope). */
export async function listAppRoles(
  db: Kysely<VetraAppsDB>,
  appId: string,
  ownerScope: string,
): Promise<AppRoleRow[]> {
  return db
    .selectFrom("app_roles")
    .selectAll()
    .where("app_id", "=", appId)
    .where("owner_scope", "=", ownerScope)
    .orderBy("granted_at", "asc")
    .orderBy("address", "asc")
    .execute();
}

export async function hasAppRole(
  db: Kysely<VetraAppsDB>,
  appId: string,
  address: string,
  role: AppRoleName,
  ownerScope: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("app_roles")
    .select("app_id")
    .where("app_id", "=", appId)
    .where("address", "=", address)
    .where("role", "=", role)
    .where("owner_scope", "=", ownerScope)
    .executeTakeFirst());
}

/** Grants, or re-grants under a new owner scope. */
export async function upsertAppRole(
  db: Kysely<VetraAppsDB>,
  row: AppRoleRow,
): Promise<AppRoleRow> {
  return db
    .insertInto("app_roles")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["app_id", "address", "role"]).doUpdateSet({
        owner_scope: row.owner_scope,
        granted_by: row.granted_by,
        granted_at: row.granted_at,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteAppRole(
  db: Kysely<VetraAppsDB>,
  appId: string,
  address: string,
  role: AppRoleName,
): Promise<boolean> {
  const r = await db
    .deleteFrom("app_roles")
    .where("app_id", "=", appId)
    .where("address", "=", address)
    .where("role", "=", role)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}
```

- [ ] **Step 7: Run it again.** Same command. Expected: PASS (the whole file).
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps/db subgraphs/vetra-apps/audit/repo.ts subgraphs/vetra-apps/roles/repo.ts subgraphs/vetra-apps/__tests__/migrations.test.ts && git commit -m "feat(audit): app_audit and app_roles tables" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Audit service (source, paging, retention)

**Files:**
- Modify: `subgraphs/vetra-apps/auth.ts`
- Create: `subgraphs/vetra-apps/audit/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/audit-api.test.ts`

**Interfaces:**
- Consumes: Task 2's `audit/repo.ts`.
- Produces (`auth.ts`): `CallerSource = "console" | "api"`; `Caller.source?: CallerSource` (absent = `api`). Informational, never an authorisation input.
- Produces (`audit/service.ts`):
  - `AUDIT_RETENTION_DAYS = 365`, `AUDIT_PAGE_DEFAULT = 50`, `AUDIT_PAGE_MAX = 200`, `AUDIT_SWEEP_BATCH = 5000`;
  - `callerSource(ctx: Pick<AppsContext, "headers">, consoleUrl: string): CallerSource`;
  - `auditCaller(db, caller: Caller, e: Omit<AuditEntry, "actor" | "source">): Promise<AppAuditRow>`;
  - `AuditEntryJson { id; appId; at; actor; source; action; subject; detail: string }`;
  - `AuditPageJson { entries: AuditEntryJson[]; nextBefore: string | null }`;
  - `encodeAuditCursor(r)`, `decodeAuditCursor(s): AuditCursor` (BAD_USER_INPUT when malformed);
  - `appAuditFor(deps, caller, appId, limit?: number | null, before?: string | null): Promise<AuditPageJson>` (`need: "view"`);
  - `sweepAuditOnce(deps): Promise<number>`.

- [ ] **Step 1: Write the failing test** `audit-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, stranger, type Harness } from "./harness.js";
import { recordAudit } from "../audit/repo.js";
import {
  appAuditFor,
  auditCaller,
  callerSource,
  sweepAuditOnce,
} from "../audit/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({ extensions: expect.objectContaining({ code: c }) });
const seed = async (n: number) => {
  for (let i = 0; i < n; i++)
    await auditCaller(h.db, owner, {
      appId,
      at: h.deps.now().toISOString(),
      action: "plan.updated",
      subject: `plan:p${i}`,
    });
};

describe("audit log", () => {
  it("pages newest first with an opaque cursor", async () => {
    await seed(5);
    const p1 = await appAuditFor(h.deps, owner, appId, 2, null);
    expect(p1.entries.map((e) => e.subject)).toEqual(["plan:p4", "plan:p3"]);
    expect(p1.entries[0]).toMatchObject({
      appId,
      actor: owner.address,
      source: "api",
      action: "plan.updated",
      detail: "{}",
    });
    const p2 = await appAuditFor(h.deps, owner, appId, 2, p1.nextBefore);
    expect(p2.entries.map((e) => e.subject)).toEqual(["plan:p2", "plan:p1"]);
    const p3 = await appAuditFor(h.deps, owner, appId, 2, p2.nextBefore);
    expect(p3).toMatchObject({
      entries: [expect.objectContaining({ subject: "plan:p0" })],
      nextBefore: null,
    });
  });

  it("clamps the page size and refuses a malformed cursor", async () => {
    await seed(3);
    expect((await appAuditFor(h.deps, owner, appId, 0, null)).entries).toHaveLength(1);
    expect((await appAuditFor(h.deps, owner, appId, 10_000, null)).entries).toHaveLength(3);
    expect((await appAuditFor(h.deps, owner, appId, null, null)).entries).toHaveLength(3);
    await expect(appAuditFor(h.deps, owner, appId, 10, "bm9wZQ")).rejects.toMatchObject(
      code("BAD_USER_INPUT"),
    );
  });

  it("is for those who may view the App", async () => {
    await expect(appAuditFor(h.deps, stranger, appId, 10, null)).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
  });

  it("records the caller's source, api when none", async () => {
    await auditCaller(h.db, { ...owner, source: "console" }, {
      appId,
      at: h.deps.now().toISOString(),
      action: "plan.retired",
      subject: "plan:x",
    });
    expect((await appAuditFor(h.deps, owner, appId, 1, null)).entries[0].source).toBe("console");
  });

  it("tells the console by the request's Origin", () => {
    const at = (origin?: string) => (origin ? { headers: { origin } } : { headers: {} });
    expect(callerSource(at("https://vetra.io"), "https://vetra.io")).toBe("console");
    expect(callerSource(at("https://vetra.io"), "https://vetra.io/")).toBe("console");
    expect(callerSource(at("https://evil.example"), "https://vetra.io")).toBe("api");
    expect(callerSource(at("not a url"), "https://vetra.io")).toBe("api");
    expect(callerSource(at(), "https://vetra.io")).toBe("api");
  });

  it("keeps one year", async () => {
    await recordAudit(h.db, {
      appId,
      at: "2025-10-01T00:00:00.000Z",
      actor: "vetra",
      source: "system",
      action: "instance.status",
      subject: "instance:x",
    });
    await seed(1);
    expect(await sweepAuditOnce(h.deps)).toBe(1);
    expect((await appAuditFor(h.deps, owner, appId, 10, null)).entries).toHaveLength(1);
  });
});
```

(The harness clock starts at 2026-10-02, so 2025-10-01 is 366 days old.)

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/audit-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: `auth.ts`.** Before `export interface Caller`:

```ts
/**
 * Where a person's request came from, for the audit log (spec section 10):
 * the Vetra console (by its Origin) or any other client. Informational only:
 * never an input to an authorisation decision.
 */
export type CallerSource = "console" | "api";
```

and in `Caller`, after `isAdmin: boolean;`:

```ts
  /** Set by the GraphQL resolvers of audited mutations; absent = "api". */
  source?: CallerSource;
```

- [ ] **Step 4: `audit/service.ts`.**

```ts
import type { Kysely } from "kysely";
import type { AppsContext, Caller, CallerSource } from "../auth.js";
import type { VetraAppsDB } from "../db/schema.js";
import { appsError } from "../errors.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  listAudit,
  recordAudit,
  sweepAudit,
  type AppAuditRow,
  type AuditCursor,
  type AuditEntry,
} from "./repo.js";

export const AUDIT_RETENTION_DAYS = 365;
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
export const AUDIT_SWEEP_BATCH = 5000;

/** console when the request's Origin is the console's (cfg.vetraAppUrl); else api. */
export function callerSource(
  ctx: Pick<AppsContext, "headers">,
  consoleUrl: string,
): CallerSource {
  const raw = ctx.headers?.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) return "api";
  try {
    return new URL(origin).origin === new URL(consoleUrl).origin ? "console" : "api";
  } catch {
    return "api";
  }
}

/** A row for something a person did. Pass the transaction of the change. */
export function auditCaller(
  db: Kysely<VetraAppsDB>,
  caller: Caller,
  e: Omit<AuditEntry, "actor" | "source">,
): Promise<AppAuditRow> {
  return recordAudit(db, { ...e, actor: caller.address, source: caller.source ?? "api" });
}

export interface AuditEntryJson {
  id: string;
  appId: string;
  at: string;
  actor: string;
  source: string;
  action: string;
  subject: string;
  /** A JSON object. */
  detail: string;
}

export interface AuditPageJson {
  entries: AuditEntryJson[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: string | null;
}

const auditJson = (r: AppAuditRow): AuditEntryJson => ({
  id: r.id,
  appId: r.app_id,
  at: r.at,
  actor: r.actor,
  source: r.source,
  action: r.action,
  subject: r.subject,
  detail: r.detail,
});

export const encodeAuditCursor = (r: Pick<AppAuditRow, "at" | "id">): string =>
  Buffer.from(`${r.at}|${r.id}`).toString("base64url");

export function decodeAuditCursor(s: string): AuditCursor {
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const i = raw.indexOf("|");
  if (i <= 0 || i === raw.length - 1)
    throw appsError("BAD_USER_INPUT", "Invalid audit cursor");
  return { at: raw.slice(0, i), id: raw.slice(i + 1) };
}

/** The App's audit log, newest first (spec section 10). Anyone who may view the App. */
export async function appAuditFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  limit?: number | null,
  before?: string | null,
): Promise<AuditPageJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const n = Math.min(Math.max(limit ?? AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX);
  const rows = await listAudit(deps.db, app.id, {
    limit: n + 1,
    before: before ? decodeAuditCursor(before) : null,
  });
  const page = rows.slice(0, n);
  return {
    entries: page.map(auditJson),
    nextBefore: rows.length > n ? encodeAuditCursor(page[page.length - 1]) : null,
  };
}

/** Deletes rows older than AUDIT_RETENTION_DAYS, a batch per pass. */
export async function sweepAuditOnce(deps: AppsDeps): Promise<number> {
  const cutoff = new Date(
    deps.now().getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return sweepAudit(deps.db, cutoff, AUDIT_SWEEP_BATCH);
}
```

- [ ] **Step 5: Run it again.** Same command. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/auth.ts subgraphs/vetra-apps/audit/service.ts subgraphs/vetra-apps/__tests__/audit-api.test.ts && git commit -m "feat(audit): audit log reads, sources and retention" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Release managers and the access levels

**Files:**
- Create: `subgraphs/vetra-apps/roles/access.ts`, `subgraphs/vetra-apps/roles/service.ts`
- Modify: `subgraphs/vetra-apps/service.ts` (`AppAccessOptions`, `loadAppForOwner`)
- Test: `subgraphs/vetra-apps/__tests__/roles-api.test.ts`

**Interfaces:**
- Consumes: Task 1's `canAdminister`, Task 2's `roles/repo.ts`, Task 3's `auditCaller`.
- Produces (`roles/access.ts`):
  - `AppNeed = "view" | "operate" | "release" | "administer"`;
  - `ownerScopeOf(app: Pick<AppRow, "owner_org_id" | "owner_address">): string`;
  - `isReleaseManager(deps, caller, app): Promise<boolean>` (the effective release manager of the Model);
  - `canRelease(deps, caller, app): Promise<boolean>`;
  - `allows(deps, caller, app, need: AppNeed): Promise<boolean>`.
- Produces (`service.ts`): `AppAccessOptions.need?: AppNeed`. `loadAppForOwner` throws the same FORBIDDEN message as before when `allows` is false.
- Produces (`roles/service.ts`):
  - `APP_ROLE_NAMES = ["release_manager"]`, `MAX_ROLES_PER_APP = 50`;
  - `AppRoleJson { appId; address; role; grantedBy; grantedAt }`;
  - `appRolesFor(deps, caller, appId)` (view);
  - `setAppRole(deps, caller, appId, address, role?: string | null): Promise<AppRoleJson>` (administer; idempotent; audits `role.granted` only when it grants or re-scopes);
  - `removeAppRole(deps, caller, appId, address, role?): Promise<boolean>` (administer; audits `role.removed` when a row was deleted);
  - `AppAccessJson { operate; release; administer; releaseManager }`, `appAccessFor(deps, caller, appId)` (view).

- [ ] **Step 1: Write the failing test** `roles-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  makeHarness,
  member,
  MEMBER,
  ORG,
  owner,
  seedActiveApp,
  stranger,
  STRANGER,
  type Harness,
} from "./harness.js";
import type { Caller } from "../auth.js";
import { appForOwner, updateApp } from "../service.js";
import { listAudit } from "../audit/repo.js";
import {
  appAccessFor,
  appRolesFor,
  MAX_ROLES_PER_APP,
  removeAppRole,
  setAppRole,
} from "../roles/service.js";

const ORG_ADMIN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const orgAdmin: Caller = { address: ORG_ADMIN, chainId: 1, appKey: null, isAdmin: false };

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );
const release = (c: Caller) => code(appForOwner(h.deps, c, appId, { need: "release" }));
const moveToOrg = async () => {
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  await appForOwner(h.deps, admin, appId);
};

describe("release managers of a personal App", () => {
  it("the owner names one: they may release and view, not operate or name others", async () => {
    expect(await release(stranger)).toBe("FORBIDDEN");
    // Mixed case in, lowercased out.
    const r = await setAppRole(h.deps, owner, appId, `0x${STRANGER.slice(2).toUpperCase()}`, null);
    expect(r).toMatchObject({ appId, address: STRANGER, role: "release_manager", grantedBy: owner.address });
    expect(await release(stranger)).toBe("OK");
    expect(await code(appForOwner(h.deps, stranger, appId, { need: "view" }))).toBe("OK");
    expect(await code(updateApp(h.deps, stranger, appId, { name: "Nope" }))).toBe("FORBIDDEN");
    expect(await code(setAppRole(h.deps, stranger, appId, MEMBER, null))).toBe("FORBIDDEN");
    expect(await appAccessFor(h.deps, stranger, appId)).toEqual({
      operate: false,
      release: true,
      administer: false,
      releaseManager: true,
    });
    expect(await appAccessFor(h.deps, owner, appId)).toEqual({
      operate: true,
      release: true,
      administer: true,
      releaseManager: false,
    });
    expect((await appRolesFor(h.deps, stranger, appId)).map((x) => x.address)).toEqual([STRANGER]);
    expect(await removeAppRole(h.deps, owner, appId, STRANGER, null)).toBe(true);
    expect(await removeAppRole(h.deps, owner, appId, STRANGER, null)).toBe(false);
    expect(await release(stranger)).toBe("FORBIDDEN");
  });

  it("checks the address and the role, is idempotent, and caps the holders", async () => {
    expect(await code(setAppRole(h.deps, owner, appId, "0x12", null))).toBe("BAD_USER_INPUT");
    expect(await code(setAppRole(h.deps, owner, appId, STRANGER, "owner"))).toBe("BAD_USER_INPUT");
    const first = await setAppRole(h.deps, owner, appId, STRANGER, "release_manager");
    expect(await setAppRole(h.deps, owner, appId, STRANGER, null)).toEqual(first);
    for (let i = 1; i < MAX_ROLES_PER_APP; i++)
      await setAppRole(h.deps, owner, appId, `0x${i.toString(16).padStart(40, "0")}`, null);
    expect(await code(setAppRole(h.deps, owner, appId, `0x${"f".repeat(40)}`, null))).toBe(
      "BAD_USER_INPUT",
    );
  });

  it("audits a grant and a removal, never a repeat", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await removeAppRole(h.deps, owner, appId, STRANGER, null);
    await removeAppRole(h.deps, owner, appId, STRANGER, null);
    const rows = await listAudit(h.db, appId, { limit: 10 });
    expect(rows.map((r) => [r.action, r.subject, r.actor, r.source])).toEqual([
      ["role.removed", `role:${STRANGER}`, owner.address, "api"],
      ["role.granted", `role:${STRANGER}`, owner.address, "api"],
    ]);
    expect(JSON.parse(rows[1].detail)).toEqual({ address: STRANGER, role: "release_manager" });
  });

  it("lapses when the App changes hands", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await moveToOrg();
    h.orgs.join(ORG, STRANGER, "MEMBER");
    h.orgs.join(ORG, ORG_ADMIN, "ADMIN");
    expect(await release(stranger)).toBe("FORBIDDEN");
    expect(await appRolesFor(h.deps, orgAdmin, appId)).toEqual([]);
  });
});

describe("release managers of an org App", () => {
  beforeEach(async () => {
    await moveToOrg();
    h.orgs.join(ORG, ORG_ADMIN, "ADMIN");
  });

  it("org OWNER/ADMIN and platform admins name them; a publisher or a non-member cannot", async () => {
    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    expect(await code(setAppRole(h.deps, member, appId, STRANGER, null))).toBe("FORBIDDEN");
    expect(await code(setAppRole(h.deps, owner, appId, STRANGER, null))).toBe("FORBIDDEN");
    expect(await code(setAppRole(h.deps, orgAdmin, appId, MEMBER, null))).toBe("OK");
    expect(await code(setAppRole(h.deps, admin, appId, STRANGER, null))).toBe("OK");
  });

  it("a plain member with the role may release; without it, or after leaving the org, not", async () => {
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await release(member)).toBe("FORBIDDEN");
    await setAppRole(h.deps, orgAdmin, appId, MEMBER, null);
    expect(await release(member)).toBe("OK");
    expect(await code(appForOwner(h.deps, member, appId))).toBe("FORBIDDEN");
    h.orgs.members.delete(`${ORG}|${MEMBER}`);
    expect(await release(member)).toBe("FORBIDDEN");
  });

  it("gives an outsider with the role nothing", async () => {
    await setAppRole(h.deps, orgAdmin, appId, STRANGER, null);
    expect(await release(stranger)).toBe("FORBIDDEN");
    expect(await code(appForOwner(h.deps, stranger, appId, { need: "view" }))).toBe("FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/roles-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: `roles/access.ts`.**

```ts
import {
  canAdminister,
  canOperate,
  canView,
} from "../../../shared/org-access.js";
import type { Caller } from "../auth.js";
import { appResource, callerAccess } from "../org-ownership.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { hasAppRole } from "./repo.js";

/** What a caller needs to do with an App (loadAppForOwner). */
export type AppNeed = "view" | "operate" | "release" | "administer";

/** The owner a grant is made under: a role from a previous owner has no effect. */
export const ownerScopeOf = (
  app: Pick<AppRow, "owner_org_id" | "owner_address">,
): string =>
  app.owner_org_id
    ? `org:${app.owner_org_id}`
    : `user:${app.owner_address.toLowerCase()}`;

/**
 * A release manager in effect (spec section 10, D7): granted under the App's
 * current owner and, for an org App, still a member of a non-disputed org.
 */
export async function isReleaseManager(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
): Promise<boolean> {
  if (
    !(await hasAppRole(deps.db, app.id, caller.address, "release_manager", ownerScopeOf(app)))
  )
    return false;
  if (!app.owner_org_id) return true;
  return canView(deps.orgs ?? null, callerAccess(caller), appResource(app));
}

/** Plans, settings, (slice 3) rollouts: the App's operators or its release managers. */
export async function canRelease(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
): Promise<boolean> {
  return (
    (await canOperate(deps.orgs ?? null, callerAccess(caller), appResource(app))) ||
    (await isReleaseManager(deps, caller, app))
  );
}

export async function allows(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
  need: AppNeed,
): Promise<boolean> {
  const orgs = deps.orgs ?? null;
  const who = callerAccess(caller);
  const r = appResource(app);
  switch (need) {
    case "view":
      return (await canView(orgs, who, r)) || (await isReleaseManager(deps, caller, app));
    case "operate":
      return canOperate(orgs, who, r);
    case "release":
      return canRelease(deps, caller, app);
    case "administer":
      return canAdminister(orgs, who, r);
  }
}
```

- [ ] **Step 4: `loadAppForOwner`.** In `service.ts` add `import { allows, type AppNeed } from "./roles/access.js";`. Change `AppAccessOptions`:

```ts
export interface AppAccessOptions {
  includeDeleted?: boolean;
  /**
   * "view": any member of the owning org, or a release manager; "operate"
   * (default): publishers; "release": publishers or release managers;
   * "administer": the personal owner or the org's OWNER/ADMIN.
   */
  need?: AppNeed;
}
```

and in `loadAppForOwner` replace

```ts
  const check = opts.need === "view" ? canView : canOperate;
  if (
    !(await check(deps.orgs ?? null, callerAccess(caller), appResource(synced)))
  ) {
    throw appsError("FORBIDDEN", "Not allowed to manage this App");
  }
```

with

```ts
  if (!(await allows(deps, caller, synced, opts.need ?? "operate"))) {
    throw appsError("FORBIDDEN", "Not allowed to manage this App");
  }
```

If `canView` is now unused in `service.ts`, drop it from the `shared/org-access.js` import (lint will say).

- [ ] **Step 5: `roles/service.ts`.**

```ts
import type { Caller } from "../auth.js";
import type { AppRoleName } from "../db/schema.js";
import { appsError } from "../errors.js";
import { auditCaller } from "../audit/service.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { allows, isReleaseManager, ownerScopeOf } from "./access.js";
import {
  deleteAppRole,
  getAppRole,
  listAppRoles,
  upsertAppRole,
  type AppRoleRow,
} from "./repo.js";

export const APP_ROLE_NAMES: readonly AppRoleName[] = ["release_manager"];
export const MAX_ROLES_PER_APP = 50;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface AppRoleJson {
  appId: string;
  address: string;
  role: string;
  grantedBy: string;
  grantedAt: string;
}

const roleJson = (r: AppRoleRow): AppRoleJson => ({
  appId: r.app_id,
  address: r.address,
  role: r.role,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
});

function parseRole(role: string | null | undefined): AppRoleName {
  const r = (role ?? "release_manager").trim().toLowerCase();
  if (!(APP_ROLE_NAMES as readonly string[]).includes(r))
    throw appsError(
      "BAD_USER_INPUT",
      `Unknown role ${String(role)}; known: ${APP_ROLE_NAMES.join(", ")}`,
    );
  return r as AppRoleName;
}

function parseAddress(a: string): string {
  const v = a.trim().toLowerCase();
  if (!ADDRESS.test(v))
    throw appsError("BAD_USER_INPUT", "An address is 0x followed by 40 hex digits");
  return v;
}

/** The App's role holders under its current owner. Anyone who may view the App. */
export async function appRolesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppRoleJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  return (await listAppRoles(deps.db, app.id, ownerScopeOf(app))).map(roleJson);
}

/** Names a release manager (owner, org OWNER/ADMIN). Idempotent. */
export async function setAppRole(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  address: string,
  role?: string | null,
): Promise<AppRoleJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "administer" });
  const who = parseAddress(address);
  const name = parseRole(role);
  const scope = ownerScopeOf(app);
  const nowIso = deps.now().toISOString();
  return deps.db.transaction().execute(async (trx) => {
    // Count and write under the App row's lock (as setAppSetting does).
    await trx.selectFrom("apps").select("id").where("id", "=", app.id).forUpdate().execute();
    const existing = await getAppRole(trx, app.id, who, name);
    if (existing && existing.owner_scope === scope) return roleJson(existing);
    if ((await listAppRoles(trx, app.id, scope)).length >= MAX_ROLES_PER_APP)
      throw appsError(
        "BAD_USER_INPUT",
        `An App has at most ${MAX_ROLES_PER_APP} role holders; remove one first`,
      );
    const row = await upsertAppRole(trx, {
      app_id: app.id,
      address: who,
      role: name,
      owner_scope: scope,
      granted_by: caller.address,
      granted_at: nowIso,
    });
    await auditCaller(trx, caller, {
      appId: app.id,
      at: nowIso,
      action: "role.granted",
      subject: `role:${who}`,
      detail: { address: who, role: name },
    });
    return roleJson(row);
  });
}

/** Takes a role away (owner, org OWNER/ADMIN); false when there was none. */
export async function removeAppRole(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  address: string,
  role?: string | null,
): Promise<boolean> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "administer" });
  const who = parseAddress(address);
  const name = parseRole(role);
  const nowIso = deps.now().toISOString();
  return deps.db.transaction().execute(async (trx) => {
    const removed = await deleteAppRole(trx, app.id, who, name);
    if (removed)
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "role.removed",
        subject: `role:${who}`,
        detail: { address: who, role: name },
      });
    return removed;
  });
}

export interface AppAccessJson {
  operate: boolean;
  release: boolean;
  administer: boolean;
  releaseManager: boolean;
}

/** What the caller may do with the App, for the console to show the right controls. */
export async function appAccessFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppAccessJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  return {
    operate: await allows(deps, caller, app, "operate"),
    release: await allows(deps, caller, app, "release"),
    administer: await allows(deps, caller, app, "administer"),
    releaseManager: await isReleaseManager(deps, caller, app),
  };
}
```

Note: `owner_address` is typed `string` on `AppRow` (`db/schema.ts`). If `tsc` says it may be null there, use `(app.owner_address ?? "").toLowerCase()`.

- [ ] **Step 6: Run it again.** Same command, plus the access tests that must not change: `npx vitest run subgraphs/vetra-apps/__tests__/roles-api.test.ts subgraphs/vetra-apps/__tests__/org-apps.test.ts subgraphs/vetra-apps/__tests__/apps.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 7: Commit.** `git add subgraphs/vetra-apps/roles subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/__tests__/roles-api.test.ts && git commit -m "feat(roles): release managers per App (canRelease, administer)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: Plans for release managers, audited

**Files:**
- Modify: `subgraphs/vetra-apps/plans/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/plans-audit.test.ts`

**Interfaces:**
- Consumes: `loadAppForOwner(…, { need: "release" })` (Task 4), `auditCaller` (Task 3), `setAppRole` (Task 4, in the test).
- Produces: `createPlan`, `updatePlanFor`, `setPlanTarget`, `retirePlan` accept release managers and write `plan.created` / `plan.updated` / `plan.target_set` / `plan.retired` (Model table) in the transaction of their write, only when something changed. Signatures unchanged.

- [ ] **Step 1: Write the failing test** `plans-audit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  makeHarness,
  member,
  MEMBER,
  ORG,
  owner,
  seedActiveApp,
  stranger,
  STRANGER,
  testConfig,
  type Harness,
} from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { appForOwner } from "../service.js";
import { listAudit } from "../audit/repo.js";
import { setAppRole } from "../roles/service.js";
import {
  appPlansFor,
  createPlan,
  retirePlan,
  setPlanTarget,
  updatePlanFor,
} from "../plans/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness(testConfig({ plans: { enabled: true, stopAfterDays: 14 } }));
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
  await seedRelease(h, appId, { version: "1.5.0", run: 101, kind: "release" });
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({ extensions: expect.objectContaining({ code: c }) });
const planRows = async (planId: string) =>
  (await listAudit(h.db, appId, { limit: 50 }))
    .filter((r) => r.subject === `plan:${planId}`)
    .reverse();

describe("plans: release managers and the audit log", () => {
  it("a release manager creates, retargets, renames and retires a plan; each change is audited once", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    const p = await createPlan(h.deps, stranger, {
      appId,
      kind: "pro",
      access: "own",
      targetVersion: "1.4.0",
    });
    await setPlanTarget(h.deps, stranger, p.id, "1.5.0");
    await setPlanTarget(h.deps, stranger, p.id, "1.5.0");
    await updatePlanFor(h.deps, stranger, { planId: p.id, name: "Pro+" });
    await updatePlanFor(h.deps, stranger, { planId: p.id, name: "Pro+" });
    await retirePlan(h.deps, stranger, p.id);
    await retirePlan(h.deps, stranger, p.id);
    expect((await appPlansFor(h.deps, stranger, appId)).map((x) => x.status)).toEqual(["retired"]);
    const rows = await planRows(p.id);
    expect(rows.map((r) => [r.action, r.actor, r.source])).toEqual([
      ["plan.created", STRANGER, "api"],
      ["plan.target_set", STRANGER, "api"],
      ["plan.updated", STRANGER, "api"],
      ["plan.retired", STRANGER, "api"],
    ]);
    expect(JSON.parse(rows[0].detail)).toEqual({
      slug: "pro",
      name: "pro",
      kind: "pro",
      access: "own",
      size: "VETRA_AGENT_S",
      targetVersion: "1.4.0",
    });
    expect(JSON.parse(rows[1].detail)).toEqual({ slug: "pro", from: "1.4.0", to: "1.5.0" });
    expect(JSON.parse(rows[2].detail)).toEqual({
      slug: "pro",
      changes: { name: { from: "pro", to: "Pro+" } },
    });
    expect(JSON.parse(rows[3].detail)).toEqual({ slug: "pro" });
  });

  it("records the console as the source when the caller came from it", async () => {
    const p = await createPlan(h.deps, { ...owner, source: "console" }, {
      appId,
      kind: "pro",
      access: "shared",
    });
    expect((await planRows(p.id)).map((r) => r.source)).toEqual(["console"]);
  });

  it("refuses a signed-in address without the role, and audits nothing", async () => {
    await expect(
      createPlan(h.deps, stranger, { appId, kind: "pro", access: "own" }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    const p = await createPlan(h.deps, owner, { appId, kind: "pro", access: "own" });
    await expect(setPlanTarget(h.deps, stranger, p.id, "1.4.0")).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
    await expect(retirePlan(h.deps, stranger, p.id)).rejects.toMatchObject(code("FORBIDDEN"));
    expect((await planRows(p.id)).map((r) => r.action)).toEqual(["plan.created"]);
  });

  it("an org App: a plain member is refused until an org admin names them", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, appId);
    h.orgs.join(ORG, MEMBER, "MEMBER");
    await expect(
      createPlan(h.deps, member, { appId, kind: "pro", access: "own" }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await setAppRole(h.deps, admin, appId, MEMBER, null);
    expect((await createPlan(h.deps, member, { appId, kind: "pro", access: "own" })).kind).toBe(
      "pro",
    );
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/plans-audit.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (FORBIDDEN for the release manager; no audit rows).
- [ ] **Step 3: Implement.** In `plans/service.ts`:
  - Add `import { auditCaller } from "../audit/service.js";`.
  - `loadPlan`: `const app = await loadAppForOwner(deps, caller, plan.app_id, { need: "release" });`
  - `createPlan`: `const app = await loadAppForOwner(deps, caller, input.appId, { need: "release" });`, and replace the `const row = await insertPlan(deps.db, { … }).catch(…)` statement with:

```ts
  const row = await deps.db
    .transaction()
    .execute(async (trx) => {
      const p = await insertPlan(trx, {
        id: deps.newId(),
        app_id: app.id,
        slug,
        name,
        kind,
        access,
        size,
        target_version: target,
        policy: "manual",
        notice_hours: 72,
        status: "active",
        created_by: caller.address,
        created_at: nowIso,
        updated_at: nowIso,
      });
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "plan.created",
        subject: `plan:${p.id}`,
        detail: {
          slug: p.slug,
          name: p.name,
          kind: p.kind,
          access: p.access,
          size: p.size,
          targetVersion: p.target_version,
        },
      });
      return p;
    })
    .catch((err: unknown) => {
      // A concurrent createPlan took the slug or kind after the checks above.
      if (isUniqueViolation(err))
        throw appsError(
          "BAD_USER_INPUT",
          `The App already has a plan called ${slug} or for the term ${kind}`,
        );
      throw err;
    });
```

  - `updatePlanFor`: replace its `return planJson(await updatePlan(…))` with:

```ts
  const patch = {
    ...(name ? { name } : {}),
    ...(input.size ? { size: parseSize(input.size) } : {}),
  };
  const changes: Record<string, { from: string; to: string }> = {};
  if (patch.name !== undefined && patch.name !== plan.name)
    changes.name = { from: plan.name, to: patch.name };
  if (patch.size !== undefined && patch.size !== plan.size)
    changes.size = { from: plan.size, to: patch.size };
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      const p = await updatePlan(trx, plan.id, patch, nowIso);
      if (Object.keys(changes).length > 0)
        await auditCaller(trx, caller, {
          appId: plan.app_id,
          at: nowIso,
          action: "plan.updated",
          subject: `plan:${plan.id}`,
          detail: { slug: plan.slug, changes },
        });
      return p;
    }),
  );
```

  - `setPlanTarget`: replace its `return planJson(await updatePlan(…))` with:

```ts
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      const p = await updatePlan(trx, plan.id, { target_version: target }, nowIso);
      if (plan.target_version !== target)
        await auditCaller(trx, caller, {
          appId: plan.app_id,
          at: nowIso,
          action: "plan.target_set",
          subject: `plan:${plan.id}`,
          detail: { slug: plan.slug, from: plan.target_version, to: target },
        });
      return p;
    }),
  );
```

  - `retirePlan`: keep the early return for a retired plan; replace the final `return planJson(await updatePlan(…))` with:

```ts
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      const p = await updatePlan(trx, plan.id, { status: "retired" }, nowIso);
      await auditCaller(trx, caller, {
        appId: plan.app_id,
        at: nowIso,
        action: "plan.retired",
        subject: `plan:${plan.id}`,
        detail: { slug: plan.slug },
      });
      return p;
    }),
  );
```

  - Update the comment above `loadPlan`: "Throws NOT_FOUND / FORBIDDEN as for the App itself; operators and release managers (spec section 10)."
- [ ] **Step 4: Run it again**, with the existing plan tests: `npx vitest run subgraphs/vetra-apps/__tests__/plans-audit.test.ts subgraphs/vetra-apps/__tests__/plans-api.test.ts subgraphs/vetra-apps/__tests__/instances-plans.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/service.ts subgraphs/vetra-apps/__tests__/plans-audit.test.ts && git commit -m "feat(plans): release managers change plans; plan changes are audited" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Settings for release managers, audited without values

**Files:**
- Modify: `subgraphs/vetra-apps/settings/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/settings-audit.test.ts`

**Interfaces:**
- Consumes: `need: "release"` (Task 4), `auditCaller` (Task 3).
- Produces: `appSettingsFor`, `setAppSetting`, `deleteAppSetting` accept release managers. `setAppSetting` writes `setting.set` with `{ name, scope, secret, replaced }`. `deleteAppSetting` writes `setting.deleted` with `{ name, scope }` when a row was deleted. Subject `setting:<SCOPE>/<NAME>`. Signatures unchanged.

- [ ] **Step 1: Write the failing test** `settings-audit.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  owner,
  seedActiveApp,
  stranger,
  STRANGER,
  type Harness,
} from "./harness.js";
import { listAudit } from "../audit/repo.js";
import { setAppRole } from "../roles/service.js";
import {
  appSettingsFor,
  deleteAppSetting,
  setAppSetting,
} from "../settings/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({ extensions: expect.objectContaining({ code: c }) });

describe("settings: release managers and the audit log", () => {
  it("audits set and delete by name, scope and secrecy, never a value", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await setAppSetting(h.deps, stranger, { appId, name: "TOKEN", value: "s3cret-value", secret: true });
    await setAppSetting(h.deps, stranger, { appId, name: "TOKEN", value: "an0ther-value", secret: true });
    await setAppSetting(h.deps, owner, {
      appId,
      name: "RELAY",
      value: "https://relay.example",
      secret: false,
      scope: "BRANCH",
    });
    expect(await deleteAppSetting(h.deps, stranger, appId, "TOKEN")).toBe(true);
    expect(await deleteAppSetting(h.deps, stranger, appId, "TOKEN")).toBe(false);
    const rows = (await listAudit(h.db, appId, { limit: 50 }))
      .filter((r) => r.subject.startsWith("setting:"))
      .reverse();
    expect(rows.map((r) => [r.action, r.subject, r.actor])).toEqual([
      ["setting.set", "setting:ALL/TOKEN", STRANGER],
      ["setting.set", "setting:ALL/TOKEN", STRANGER],
      ["setting.set", "setting:BRANCH/RELAY", OWNER],
      ["setting.deleted", "setting:ALL/TOKEN", STRANGER],
    ]);
    expect(JSON.parse(rows[0].detail)).toEqual({ name: "TOKEN", scope: "ALL", secret: true, replaced: false });
    expect(JSON.parse(rows[1].detail)).toMatchObject({ replaced: true });
    expect(JSON.parse(rows[2].detail)).toEqual({ name: "RELAY", scope: "BRANCH", secret: false, replaced: false });
    expect(JSON.parse(rows[3].detail)).toEqual({ name: "TOKEN", scope: "ALL" });
    const everything = JSON.stringify(await h.db.selectFrom("app_audit").selectAll().execute());
    for (const s of [
      "s3cret-value",
      "an0ther-value",
      "https://relay.example",
      Buffer.from("s3cret-value").toString("base64"),
      Buffer.from("an0ther-value").toString("base64"),
    ])
      expect(everything).not.toContain(s);
  });

  it("lets a release manager read the settings; refuses an address without the role", async () => {
    await expect(appSettingsFor(h.deps, stranger, appId)).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(
      setAppSetting(h.deps, stranger, { appId, name: "FOO", value: "bar", secret: false }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    expect((await appSettingsFor(h.deps, stranger, appId)).settings).toEqual([]);
  });
});
```

(The harness vault stores `vault:<base64 of the value>`, hence the base64 checks.)

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/settings-audit.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `settings/service.ts`:
  - Add `import { auditCaller } from "../audit/service.js";`.
  - In `appSettingsFor`, `setAppSetting` and `deleteAppSetting`: `loadAppForOwner(deps, caller, …, { need: "release" })`. Update `appSettingsFor`'s doc comment: "Operators and release managers only: plain values may be private."
  - In `setAppSetting`, inside the existing `deps.db.transaction().execute(async (trx) => { … })`, after `await upsertAppSetting(trx, row);`:

```ts
    // Never the value: the audit log is readable by every viewer of the App.
    await auditCaller(trx, caller, {
      appId: app.id,
      at: row.updated_at,
      action: "setting.set",
      subject: `setting:${FROM_SCOPE[scope]}/${row.name}`,
      detail: { name: row.name, scope: FROM_SCOPE[scope], secret: row.secret, replaced: replaces },
    });
```

  - In `deleteAppSetting`, replace `const deleted = await deleteRow(deps.db, app.id, s, name);` with:

```ts
  const deleted = await deps.db.transaction().execute(async (trx) => {
    const gone = await deleteRow(trx, app.id, s, name);
    if (gone)
      await auditCaller(trx, caller, {
        appId: app.id,
        at: deps.now().toISOString(),
        action: "setting.deleted",
        subject: `setting:${FROM_SCOPE[s]}/${name}`,
        detail: { name, scope: FROM_SCOPE[s] },
      });
    return gone;
  });
```

- [ ] **Step 4: Run it again**, with the existing settings tests: `npx vitest run subgraphs/vetra-apps/__tests__/settings-audit.test.ts subgraphs/vetra-apps/__tests__/settings-api.test.ts subgraphs/vetra-apps/__tests__/instances-settings.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/settings/service.ts subgraphs/vetra-apps/__tests__/settings-audit.test.ts && git commit -m "feat(settings): release managers change settings; changes are audited without values" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: Instance status changes in the audit log

**Files:**
- Modify: `subgraphs/vetra-apps/instances/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/audit-instances.test.ts`

**Interfaces:**
- Consumes: `recordAudit`, `AUDIT_SYSTEM_ACTOR`, `AuditEntry` (Task 2).
- Produces:
  - `updateInstance(db, id, patch, nowIso)`, same signature. When `patch.status` is set, it reads the old status `FOR UPDATE` and writes one `instance.status` row (source `system`, actor `vetra`) when it differs, atomically with the update: in its own transaction, or in the caller's when `db.isTransaction`. Without `patch.status`, it runs the same single `UPDATE` as today.
  - `instanceStatusEntry(row, from, at): AuditEntry`.

- [ ] **Step 1: Write the failing test** `audit-instances.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, type Harness } from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { listInstances, updateInstance, type InstanceRow } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { listAudit } from "../audit/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
});
afterEach(async () => {
  await h.close();
});

const audit = () => listAudit(h.db, appId, { limit: 200 });
const detail = (d: string) =>
  JSON.parse(d) as { kind: string; name: string; from: string; to: string; reason: string | null };

/** A branch instance that went pending → updating → ready. */
async function readyInstance(): Promise<InstanceRow> {
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
  await reconcileInstancesOnce(h.deps);
  const row = (await listInstances(h.db, appId))[0];
  h.envs.setStatus(row.environment_id!, "READY");
  await reconcileInstancesOnce(h.deps);
  const ready = (await listInstances(h.db, appId))[0];
  expect(ready.status).toBe("ready");
  return ready;
}

describe("instance status changes in the audit log", () => {
  it("records each change as Vetra (system), and nothing while the instance stays ready", async () => {
    const row = await readyInstance();
    const rows = await audit();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(r).toMatchObject({
        actor: "vetra",
        source: "system",
        action: "instance.status",
        subject: `instance:${row.id}`,
      });
    const changes = rows.map((r) => detail(r.detail)).reverse();
    for (const c of changes) expect(c.from).not.toBe(c.to);
    expect(changes.at(-1)).toMatchObject({ kind: "branch", name: "main", from: "updating", to: "ready" });

    for (let i = 0; i < 3; i++) await reconcileInstancesOnce(h.deps);
    expect(await audit()).toHaveLength(rows.length);
  });

  it("writes a row only when a write changes the status, also inside a caller's transaction", async () => {
    const row = await readyInstance();
    const n = (await audit()).length;
    const now = () => h.deps.now().toISOString();
    await updateInstance(h.db, row.id, { reason: "a note" }, now());
    await updateInstance(h.db, row.id, { status: "ready" }, now());
    expect(await audit()).toHaveLength(n);
    await updateInstance(h.db, row.id, { status: "failed", reason: "boom" }, now());
    expect(detail((await audit())[0].detail)).toMatchObject({ from: "ready", to: "failed", reason: "boom" });
    await h.db
      .transaction()
      .execute((trx) => updateInstance(trx, row.id, { status: "pending" }, now()));
    expect(detail((await audit())[0].detail)).toMatchObject({ from: "failed", to: "pending" });
    expect(await audit()).toHaveLength(n + 2);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/audit-instances.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`rows.length` is 0).
- [ ] **Step 3: Implement.** In `instances/repo.ts` add

```ts
import {
  AUDIT_SYSTEM_ACTOR,
  recordAudit,
  type AuditEntry,
} from "../audit/repo.js";
```

and replace `updateInstance` with:

```ts
/** The audit row of an instance status change (spec section 10; source system). */
export function instanceStatusEntry(
  row: InstanceRow,
  from: string,
  at: string,
): AuditEntry {
  return {
    appId: row.app_id,
    at,
    actor: AUDIT_SYSTEM_ACTOR,
    source: "system",
    action: "instance.status",
    subject: `instance:${row.id}`,
    detail: {
      kind: row.kind,
      name: row.name,
      from,
      to: row.status,
      reason: row.reason,
      targetVersion: row.target_version,
      runningVersion: row.running_version,
      planId: row.plan_id ?? null,
    },
  };
}

/**
 * The only writer of instances.status. A patch that sets a status reads the
 * old one under a row lock and audits a change, atomically with the write; a
 * patch without a status is the single UPDATE it always was (the reconciler's
 * hot path; it patches only on change anyway).
 */
export async function updateInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: InstancePatch,
  nowIso: string,
): Promise<InstanceRow> {
  const write = async (q: Kysely<VetraAppsDB>): Promise<InstanceRow> => {
    const before =
      patch.status === undefined
        ? undefined
        : await q
            .selectFrom("instances")
            .select("status")
            .where("id", "=", id)
            .forUpdate()
            .executeTakeFirst();
    const row = normalize(
      await q
        .updateTable("instances")
        .set({ ...patch, updated_at: nowIso })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    if (before && before.status !== row.status)
      await recordAudit(q, instanceStatusEntry(row, before.status, nowIso));
    return row;
  };
  if (patch.status === undefined || db.isTransaction) return write(db);
  return db.transaction().execute(write);
}
```

- [ ] **Step 4: Run it again**, with the instance suites that write statuses: `npx vitest run subgraphs/vetra-apps/__tests__/audit-instances.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts subgraphs/vetra-apps/__tests__/instances-previews.test.ts subgraphs/vetra-apps/__tests__/instances-plans.test.ts subgraphs/vetra-apps/__tests__/instances-health.test.ts subgraphs/vetra-apps/__tests__/instances-status.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS. If the steady-state assertion fails, a reconciler pass flips a status back and forth in steady state. That is a reconciler bug: report it with the two statuses, and do not hide it by filtering audit rows.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/repo.ts subgraphs/vetra-apps/__tests__/audit-instances.test.ts && git commit -m "feat(instances): audit instance status changes (source system)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Recorded releases and builds in the audit log

**Files:**
- Modify: `subgraphs/vetra-apps/releases/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-report.test.ts`

**Interfaces:**
- Consumes: `recordAudit` (Task 2).
- Produces: `ciReportRelease` stores the release row and its `release.recorded` / `build.recorded` row (source `ci`, actor `ci.address` lowercased, subject `release:<version>`, detail `{ version, kind, branch, pr, commit, run, digest, githubActor, githubRun }`) in one transaction. A repeat report (`created` false) writes nothing. Return value unchanged.

- [ ] **Step 1: Write the failing test.** Append to `releases-report.test.ts` (add `import { listAudit } from "../audit/repo.js";`):

```ts
describe("ciReportRelease and the audit log", () => {
  it("records a release and a build once each, as CI for the address it acts for", async () => {
    await ciReportRelease(h.deps, ci(), input());
    await ciReportRelease(h.deps, ci(), input());
    await ciReportRelease(
      h.deps,
      ci("refs/heads/main", "501"),
      input({
        version: "1.5.0-main.4",
        kind: "build",
        notes: null,
        image: { ref: `cr.vetra.io/acme/${app.slug}:1.5.0-main.4`, digest: DIGEST, host: "cli" },
        packages: [],
      }),
    );
    const rows = await listAudit(h.db, app.id, { limit: 10 });
    expect(rows.map((r) => [r.action, r.subject, r.actor, r.source])).toEqual([
      ["build.recorded", "release:1.5.0-main.4", OWNER, "ci"],
      ["release.recorded", "release:1.5.0", OWNER, "ci"],
    ]);
    expect(JSON.parse(rows[1].detail)).toEqual({
      version: "1.5.0",
      kind: "release",
      branch: "main",
      pr: null,
      commit: SHA,
      run: 500,
      digest: DIGEST,
      githubActor: "octocat",
      githubRun: "500",
    });
  });

  it("records nothing when the report is refused", async () => {
    h.deps.attestations = {
      verify: async () => {
        throw Object.assign(new Error("no"), { extensions: { code: "FORBIDDEN" } });
      },
    };
    await expect(ciReportRelease(h.deps, ci(), input())).rejects.toBeTruthy();
    expect(await listAudit(h.db, app.id, { limit: 10 })).toEqual([]);
  });
});
```

If the claim rules refuse that build, take the build input of `releases-licensed-host.test.ts` "records nothing for a build" (same version, `notes: null`, `packages: []`, `requires: {}`).

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/releases-report.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: the first new test FAILS (no rows); the second passes.
- [ ] **Step 3: Implement.** In `releases/service.ts` add `import { recordAudit } from "../audit/repo.js";` and replace

```ts
  const { row, created } = await insertRelease(deps.db, {
```

through the end of that call (`created_at: deps.now().toISOString(),\n  });`) with:

```ts
  const nowIso = deps.now().toISOString();
  // The row and its audit entry together: a retry of the same report (created
  // false) adds neither.
  const { row, created } = await deps.db.transaction().execute(async (trx) => {
    const stored = await insertRelease(trx, {
      app_id: app.id,
      version: input.version,
      kind: input.kind,
      branch: input.branch,
      pr: input.pr,
      run,
      commit: input.commit,
      notes: input.notes,
      customer_notes: input.notes,
      image_ref: input.image.ref,
      image_digest: input.image.digest,
      host: input.image.host,
      packages: JSON.stringify(input.packages),
      requires: JSON.stringify(input.requires),
      migrates: input.migrates,
      powerhouse_version: input.built.powerhouse,
      base_image: input.built.baseImage,
      created_at: nowIso,
    });
    if (stored.created)
      await recordAudit(trx, {
        appId: app.id,
        at: nowIso,
        actor: ci.address.toLowerCase(),
        source: "ci",
        action: input.kind === "release" ? "release.recorded" : "build.recorded",
        subject: `release:${input.version}`,
        detail: {
          version: input.version,
          kind: input.kind,
          branch: input.branch,
          pr: input.pr,
          commit: input.commit,
          run,
          digest: input.image.digest,
          githubActor: ci.claim?.actor ?? null,
          githubRun: ci.claim?.runId ?? null,
        },
      });
    return stored;
  });
```

- [ ] **Step 4: Run it again**, with the other release suites: `npx vitest run subgraphs/vetra-apps/__tests__/releases-report.test.ts subgraphs/vetra-apps/__tests__/releases-claim.test.ts subgraphs/vetra-apps/__tests__/releases-licensed-host.test.ts subgraphs/vetra-apps/__tests__/ci.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/releases/service.ts subgraphs/vetra-apps/__tests__/releases-report.test.ts && git commit -m "feat(releases): audit recorded releases and builds (source ci)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: GraphQL (audit, roles, access; source from the console)

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Test: `subgraphs/vetra-apps/__tests__/audit-graphql.test.ts`

**Interfaces:**
- Consumes: `appAuditFor`, `callerSource` (Task 3); `appRolesFor`, `setAppRole`, `removeAppRole`, `appAccessFor` (Task 4).
- Produces (GraphQL):
  - types `AppAuditEntry`, `AppAuditPage`, `AppRole`, `AppAccess`;
  - `Query.appAudit(appId: ID!, limit: Int, before: String): AppAuditPage!`, `Query.appRoles(appId: ID!): [AppRole!]!`, `Query.appAccess(appId: ID!): AppAccess!`;
  - `Mutation.setAppRole(appId: ID!, address: String!, role: String): AppRole!`, `Mutation.removeAppRole(appId: ID!, address: String!, role: String): Boolean!`.
  - The audited mutations (`setAppSetting`, `deleteAppSetting`, `createPlan`, `updatePlan`, `setPlanTarget`, `retirePlan`, `setAppRole`, `removeAppRole`) pass a caller with `source` from `callerSource(ctx, deps.cfg.vetraAppUrl)`.

- [ ] **Step 1: Write the failing test** `audit-graphql.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  STRANGER,
  testConfig,
  type Harness,
} from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { createResolvers } from "../resolvers.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness(testConfig({ plans: { enabled: true, stopAfterDays: 14 } }));
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
});
afterEach(async () => {
  await h.close();
});

const ctx = (address: string, headers: Record<string, string> = {}) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  headers,
});

describe("audit and roles over GraphQL", () => {
  it("audits the console by its Origin and any other client as api", async () => {
    const r = createResolvers(h.deps);
    const p = await r.Mutation.createPlan(
      null,
      { input: { appId, kind: "pro", access: "own" } },
      ctx(OWNER, { origin: "https://vetra.io" }),
    );
    await r.Mutation.retirePlan(null, { planId: p.id }, ctx(OWNER));
    const page = await r.Query.appAudit(null, { appId, limit: 10, before: null }, ctx(OWNER));
    expect(page.entries.map((e) => [e.action, e.source])).toEqual([
      ["plan.retired", "api"],
      ["plan.created", "console"],
    ]);
    expect(page.nextBefore).toBeNull();
  });

  it("names, lists and removes a release manager, and tells each caller what they may do", async () => {
    const r = createResolvers(h.deps);
    expect(
      await r.Mutation.setAppRole(null, { appId, address: STRANGER, role: null }, ctx(OWNER)),
    ).toMatchObject({ address: STRANGER, role: "release_manager" });
    expect(
      (await r.Query.appRoles(null, { appId }, ctx(STRANGER))).map((x) => x.address),
    ).toEqual([STRANGER]);
    expect(await r.Query.appAccess(null, { appId }, ctx(STRANGER))).toEqual({
      operate: false,
      release: true,
      administer: false,
      releaseManager: true,
    });
    await expect(
      r.Mutation.setAppRole(null, { appId, address: OWNER, role: null }, ctx(STRANGER)),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(
      await r.Mutation.removeAppRole(null, { appId, address: STRANGER, role: null }, ctx(OWNER)),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/audit-graphql.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`appAudit` is undefined).
- [ ] **Step 3: Schema.** In `schema.ts`, after `input UpdatePlanInput { … }`:

```graphql
  "Who did what to an App, when and from where (spec: releases and instances, section 10). Kept one year."
  type AppAuditEntry {
    id: ID!
    appId: ID!
    at: String!
    "A lowercased address (a person, or the address CI acts for), or vetra for Vetra itself"
    actor: String!
    "console | api | policy | system | ci"
    source: String!
    "plan.created | plan.updated | plan.target_set | plan.retired | setting.set | setting.deleted | role.granted | role.removed | instance.status | release.recorded | build.recorded"
    action: String!
    "plan:<id> | setting:<SCOPE>/<NAME> | role:<address> | instance:<id> | release:<version>"
    subject: String!
    "A JSON object; never a setting value or secret"
    detail: String!
  }

  type AppAuditPage {
    "Newest first"
    entries: [AppAuditEntry!]!
    "Pass as before for the next (older) page; null on the last page"
    nextBefore: String
  }

  "A per-App role kept by Vetra (release managers: plans, settings and rollouts without being an org admin)"
  type AppRole {
    appId: ID!
    address: String!
    "release_manager"
    role: String!
    grantedBy: String!
    grantedAt: String!
  }

  "What the signed-in caller may do with an App"
  type AppAccess {
    "Edit, deploy, roll back, delete (owner, org OWNER/ADMIN, publishers in scope)"
    operate: Boolean!
    "Plans, settings, rollouts (operators and release managers)"
    release: Boolean!
    "Name release managers (owner, org OWNER/ADMIN)"
    administer: Boolean!
    releaseManager: Boolean!
  }
```

In `type Query`, after `appPlans(appId: ID!): [AppPlan!]!`:

```graphql
    "The App's audit log, newest first (default 50, at most 200 per page)"
    appAudit(appId: ID!, limit: Int, before: String): AppAuditPage!
    "The App's release managers"
    appRoles(appId: ID!): [AppRole!]!
    appAccess(appId: ID!): AppAccess!
```

In `type Mutation`, after `retirePlan(planId: ID!): AppPlan!`:

```graphql
    "Name a release manager (owner or org OWNER/ADMIN; role default release_manager)"
    setAppRole(appId: ID!, address: String!, role: String): AppRole!
    removeAppRole(appId: ID!, address: String!, role: String): Boolean!
```

- [ ] **Step 4: Resolvers.** In `resolvers.ts` add imports:

```ts
import { appAuditFor, callerSource } from "./audit/service.js";
import {
  appAccessFor,
  appRolesFor,
  removeAppRole,
  setAppRole,
} from "./roles/service.js";
```

At the top of `createResolvers(deps)`'s body:

```ts
  /** A person for an audited mutation: their source (console by Origin, else api) goes into the log. */
  const person = (ctx: AppsContext): Caller => ({
    ...requireCaller(ctx),
    source: callerSource(ctx, deps.cfg.vetraAppUrl),
  });
```

In `Query`, after `appPlans`:

```ts
      appAudit: (
        _: unknown,
        { appId, limit, before }: { appId: string; limit?: number | null; before?: string | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "appAudit", () =>
          appAuditFor(deps, requireCaller(ctx), appId, limit, before),
        ),
      appRoles: (_: unknown, { appId }: { appId: string }, ctx: AppsContext) =>
        guard(deps, "appRoles", () => appRolesFor(deps, requireCaller(ctx), appId)),
      appAccess: (_: unknown, { appId }: { appId: string }, ctx: AppsContext) =>
        guard(deps, "appAccess", () => appAccessFor(deps, requireCaller(ctx), appId)),
```

In `Mutation`, after `retirePlan`:

```ts
      setAppRole: (
        _: unknown,
        { appId, address, role }: { appId: string; address: string; role?: string | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "setAppRole", () => setAppRole(deps, person(ctx), appId, address, role)),
      removeAppRole: (
        _: unknown,
        { appId, address, role }: { appId: string; address: string; role?: string | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "removeAppRole", () =>
          removeAppRole(deps, person(ctx), appId, address, role),
        ),
```

In the resolvers of `setAppSetting`, `deleteAppSetting`, `createPlan`, `updatePlan`, `setPlanTarget` and `retirePlan`, replace `requireCaller(ctx)` with `person(ctx)`.
- [ ] **Step 5: Run it again**, with the SDL check and the settings GraphQL tests: `npx vitest run subgraphs/vetra-apps/__tests__/audit-graphql.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts subgraphs/vetra-apps/__tests__/settings-api.test.ts subgraphs/vetra-apps/__tests__/subgraph.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/schema.ts subgraphs/vetra-apps/resolvers.ts subgraphs/vetra-apps/__tests__/audit-graphql.test.ts && git commit -m "feat(apps): appAudit, appRoles, appAccess, setAppRole, removeAppRole" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 10: Retention sweep, full checks, PR

**Files:**
- Modify: `subgraphs/vetra-apps/index.ts`

- [ ] **Step 1: Wire the sweep.** In `index.ts` add `import { sweepAuditOnce } from "./audit/service.js";` and, after `every(5 * 60 * 1000, "push robot sweep", () => sweepPushRobots(deps));`:

```ts
    // The audit log keeps one year (spec section 10); a batch per pass.
    every(SWEEP_INTERVAL_MS, "audit retention", () => sweepAuditOnce(deps));
```

- [ ] **Step 2: Full checks.**
  - `npm run tsc 2>&1 | tail -20`
  - `npm run lint 2>&1 | grep -E "error|✖" | head -20`
  - `npx vitest run subgraphs/vetra-apps shared subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`

  Expected: no new errors compared with Task 0's baseline. Fix what this branch broke. Leave pre-existing failures alone.
- [ ] **Step 3: Commit.** `git add subgraphs/vetra-apps/index.ts && git commit -m "feat(audit): sweep audit rows older than a year" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
- [ ] **Step 4: PR.** `git push -u origin feat/releases-phase-3-audit` and `gh pr create --title "feat(apps): audit log and release managers (releases phase 3, slice 2)"`. The body covers:
  - what ships (two tables, the access levels, what is audited, the GraphQL surface);
  - that existing callers keep their rights and nothing is behind a switch;
  - decisions A1-A11 as built;
  - the staging steps below.

  End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

### Task 11: Staging verification (needs the user; no code)

- [ ] **Step 1: Pin staging.** After the merge and publish, the user merges a `powerhouse-k8s-hosting` PR that pins the new version in `tenants/staging/powerhouse-values.yaml` (`PH_REGISTRY_PACKAGES`, two places). There is no new environment value. Production stays as it is.
- [ ] **Step 2: Three test identities** on `switchboard.staging.vetra.io/graphql/vetra-apps`:
  - **A**: the staging canary app's owner (`96e56853-7041-4c32-a8f7-e9cc8afb50d4`), or an OWNER/ADMIN of its org if it is org-owned (`app(id)` shows `ownerOrgId`);
  - **B**: the future release manager. For an org App: a member with role MEMBER (not ADMIN, not PUBLISHER), added in Renown. For a personal App: any other address;
  - **C**: a plain member (org App) or any other signed-in address (personal App), without the role.
- [ ] **Step 3: Refusals before the role.**
  - As B: `createPlan(input: {appId, kind: "<an unissued term kind>", access: "shared"})` → FORBIDDEN.
  - As B: `setAppRole(appId, address: <C>)` → FORBIDDEN.
  - As B: `appAccess(appId)` → all false. For an org App, B as a member may view, so `appAccess` answers. For a personal App it is FORBIDDEN.
- [ ] **Step 4: Name B.** As A: `setAppRole(appId, address: "<B>")`. Then `appRoles(appId)` lists B, and `appAccess(appId)` as B shows `release: true`, `operate: false`, `administer: false`.
- [ ] **Step 5: B works the plan.** The staging switch `VETRA_APPS_PLANS` must be on (plan 1). As B:
  - `createPlan(input: {appId, kind: "<term>", access: "shared", targetVersion: "<a release>"})`;
  - `setPlanTarget(planId, version: "<another release>")`;
  - `retirePlan(planId)`.

  All three succeed.
- [ ] **Step 6: C is refused.** As C, the same three mutations → FORBIDDEN, and `setAppSetting(input: {appId, name: "AUDIT_TEST", value: "x", secret: false})` → FORBIDDEN.
- [ ] **Step 7: Settings as B.** `setAppSetting(input: {appId, name: "AUDIT_TEST", value: "do-not-log-me", secret: true})`, then `deleteAppSetting(appId, name: "AUDIT_TEST")`.
- [ ] **Step 8: The log.** `appAudit(appId, limit: 50)` (as A or B) shows, newest first:
  - `setting.deleted`, `setting.set` (detail without `do-not-log-me`);
  - `plan.retired`, `plan.target_set`, `plan.created` (actor B, source `api`);
  - `role.granted` (actor A);
  - `instance.status` rows for the plan's shared instance (`pending → updating → ready`, actor `vetra`, source `system`) once the reconciler ran;
  - `release.recorded` / `build.recorded` (source `ci`) for any CI report made after the pin.

  Paging works: `limit: 2`, then `before: <nextBefore>`.
- [ ] **Step 9: Steady state.** Note the newest `instance.status` row. Wait 10 minutes with nothing changing. No new `instance.status` row appears for a ready instance.
- [ ] **Step 10: Clean up.** As A: `removeAppRole(appId, address: "<B>")`; then as B, `setPlanTarget` → FORBIDDEN. Record all results in the PR. Production pin follows the Sektar rollout check (Global Constraints).

---

### Task 12: Console follow-up (vetra.to; separate PR after staging works; no code here)

A separate plan or task in the vetra.to repository, on a `feat/app-audit-and-release-managers` branch, after Task 11 passes:

- **Types.** `npm run codegen` against the staging vetra-apps schema: `AppAuditEntry`, `AppAuditPage`, `AppRole`, `AppAccess`, `appAudit`, `appRoles`, `appAccess`, `setAppRole`, `removeAppRole`. Add the queries and mutations to `modules/apps/graphql.ts` and hooks to `modules/apps/hooks/use-apps.ts`.
- **Who sees what.** Today `modules/apps/components/app-detail.tsx` treats its tabs as owner-only. Use `appAccess(appId)`:
  - `operate` → today's owner tabs;
  - `release` → the Plans tab (`modules/publisher/components/plans/plans-tab.tsx` or its replacement from plan 1's console work), the Settings tab's publisher settings, and (slice 3) rollouts;
  - `administer` → the release-manager picker.
  - A release manager who is not an operator sees Overview, Releases, Plans, Settings (publisher settings only) and Audit, without edit, deploy, delete or GitHub controls.
- **Audit tab.** New tab `audit` (label "Audit log") in `ALL_TABS`/`APP_TAB_LABEL`, component `modules/apps/components/app-audit.tsx`:
  - a list newest first with "Load more" (`nextBefore`);
  - each row shows when (relative, with an exact tooltip), who, where (a small source badge: Console, API, CI, Vetra, Policy), and what (one readable sentence per action from `action` + `detail`: "retargeted Pro from 1.4.0 to 1.5.0", "set secret TOKEN (all instances)", "instance main: updating → ready", "release 1.5.0 recorded by GitHub user octocat");
  - a filter by kind (plans, settings, roles, instances, releases) as a prefix match on `subject` done in the client.
- **People are Renown names.** Actors, role holders and `granted_by` are addresses. Show them with `usePersonName` (`modules/shared/hooks/use-person-name.ts`): the Renown name and picture, else the ENS name. Never show a raw `0x…` as the label; it may appear in a tooltip or copy button. `vetra` shows as "Vetra". A CI row shows the person CI acted for, with "via GitHub Actions (octocat)" from `detail.githubActor`.
- **Release-manager picker.** In the Settings tab (an "Access" card next to `OrganisationCard` in `modules/apps/components/app-settings.tsx`), visible with `administer`:
  - the current release managers (Renown names and pictures, granted by whom and when, a Remove button);
  - "Add release manager": for an org App, a picker over the org's members (from the existing org members query) excluding OWNER/ADMIN/PUBLISHER, who already have the rights; for a personal App, an address or Renown-handle input resolved to an address.
  - The copy explains: release managers can change plans, settings and (soon) rollouts, but cannot edit or delete the App or name others.
- **Tests.** Storybook stories for the audit row (each action), and a Playwright check that a release manager sees Plans and Audit but no Delete.

---

## Self-review

- **Spec coverage:**
  - Section 10, the table row "change plans" and settings → Tasks 4-6. "Publish a release" stays GitHub, unchanged. "Turn on the Team plan, add templates" → `need: "administer"` is ready for slice 6 (A6).
  - Section 10, the audit log: every action above (Tasks 4-6), every release reported (Task 8), every instance status change (Task 7); who/what/when/where (Model); shown on the App page (Task 9 query + Task 12); kept 1 year (Tasks 3 and 10).
  - Section 11 "Audit log" on the App page → Task 12.
  - Overview slice 2 (both tables, `canRelease`, `appAudit(appId, limit, before)`, `setAppRole`/`removeAppRole` for owner and org admins, system rows from the reconciler only on change; staging) → Tasks 2-11. D7 → `roles/*`.
- **Hot path:** a patch without `status` is unchanged (Task 7 Step 3), and the steady state is tested (Task 7 test 1, Task 11 Step 9).
- **Secrets:** settings rows carry no value (Task 6 test greps the whole table for values and ciphertexts). CI rows carry no token. Instance `reason` strings are the reconciler's own messages, cut at 500 characters.
- **Type consistency:**
  - `AppNeed` is used by `AppAccessOptions.need` and `allows`.
  - `AuditEntry` is used by `recordAudit`, `auditCaller` (minus actor and source) and `instanceStatusEntry`.
  - `AuditSource` (schema) is a superset of `CallerSource` (auth).
  - `AppRoleName` is used by `roles/repo.ts` and `roles/service.ts`.
- **Later slices:** rollout mutations (slice 3) call `loadAppForOwner(…, { need: "release" })` and `auditCaller`, and add their actions to `AUDIT_ACTIONS` with source `policy` for automatic steps (actor `vetra`). Support access (slice 7) and switch-over tooling (slice 9) add theirs the same way.
