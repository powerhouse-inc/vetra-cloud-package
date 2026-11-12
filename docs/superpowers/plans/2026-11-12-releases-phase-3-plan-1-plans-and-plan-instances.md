# Releases phase 3, plan 1: plans and plan instances (shared and own) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publisher turns one of the App's licensing terms into a **plan**: access `shared` or `own`, a size, a target release. Vetra then runs the plan's instances itself:
- one **shared** instance per shared plan;
- one **own** instance per live licence chain of an own plan.

Each instance runs the plan's target release by digest, with a kept `/data`, a database with S3 backups and the plan's size. An own instance is stopped `stopAfterDays` after its licence ends and woken when the chain is live again. Holders find their instances with `myInstances`. Licensed environments (the old model, Sektar) are not touched.

**Architecture:**
- A new `plans` table (vetra-apps) adopts a term by its `kind`. Issuers, validity and invite codes stay on the term, and holders are the term's licences.
- Holders are read from licensing's tables (`app_license_grants`, `license_chain`, `license_lifecycle`) through a new `licensingDb` dependency.
- `syncPlanInstances` (new, `plans/sync.ts`) runs in each reconciler pass beside `syncBranchInstances`/`syncPreviewInstances`. It writes `shared`/`own` rows into `instances` with `plan_id`, `holder_address`, `licence_root_id`, `target_size`, and a desired `stop_reason`.
- The existing per-instance reconcile path creates, updates, reverts and health-checks them, with four differences:
  - the environment is linked with a new role **`PLAN`**, so the processor's `isPreviewEnv` is false and the full profile is rendered without any processor code change;
  - the document is owned by the Vetra service identity;
  - `ADMINS` is the holder (own) or the App owner (shared);
  - the FUSION service gets the plan's size.
- A `stop_reason` puts the environment to sleep (`SLEEP_ENVIRONMENT`), and clearing it wakes it (`WAKE_ENVIRONMENT`). Nothing of a plan instance is ever deleted in this plan.
- Licensing's `AppLicenseHandler` drops chains of plan-owned kinds that have no `license_environments` row, so the two models never both act on one chain.
- `setPlanTarget` moves a plan's instances directly. It is the stand-in until rollouts (slice 3), and production keeps `VETRA_APPS_PLANS` off until then.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph), the `powerhouse/vetra-cloud-environment` document model (one enum value added), the processor `processors/vetra-cloud-environment` (unchanged; one test).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 2 (Plan, Instance);
- section 5 (instance kinds `shared`/`own`, removal rules, what every instance runs: `/data` persistent, own database, `ADMINS` per kind, instance hosts);
- section 6 (the reconciler; targets of shared and own instances move only through a rollout: here `setPlanTarget`, until slice 3);
- section 7 "Plans" (`{name, slug, template, access, validityDays, issuers, targetRelease, policy, noticeHours}`);
- 14.5 (holder data stays the holder's).

Slice scope, rules and gaps 1-4 and 11: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` (slice 1, decisions D1-D4). Conventions: the phase 2 plans (`2026-11-11-releases-phase-2-plan-*.md`).

## What exists today (checked 2026-11-12 on `main` = 0.0.114)

- **`instances`** (`subgraphs/vetra-apps/db/schema.ts` `InstancesTable`):
  - `kind: InstanceKind = "branch" | "preview" | "shared" | "own"`. The shared and own kinds are typed but never written.
  - Unique `(app_id, kind, name)` (`instances_app_kind_name_uq`), partial unique `host`, partial unique `environment_id`.
- **The reconciler** (`subgraphs/vetra-apps/instances/reconciler.ts`):
  - `reconcileInstancesOnce` → `reconcileApp` (`syncBranchInstances`, `syncPreviewInstances`, then `reconcileInstance` per row) → `createEnvironment`/`initEnvironment` or `reconcileEnvironment`.
  - Every write runs under `withEnvLock(envId)`, inside `withKeyLock("instances:<appId>")`.
  - `claimHost` uses `instanceLabel(app.id, app.slug, row.name, cfg.instances.labelSuffix)` (`instances/host.ts`; `MAX_INSTANCE_LABEL` = 31).
  - `ADMINS` is `app.owner_address` everywhere (`initEnvironment`, the three `instanceUpdateActions` calls in `reconcileEnvironment`).
  - `removeInstance` deletes only `PREVIEW`-role documents.
- **Render** (`instances/render.ts`):
  - `instanceCreateActions` links `setAppLink({ role: "PREVIEW", … })`, sets `setOwner(i.owner)` and, for org apps, `setOwnerOrg`.
  - `instanceUpdateActions(state, image, admins, settings, start = true)` throws unless `state.app?.role === "PREVIEW"` and `!state.managedBy`, and wakes a STOPPED environment before changes.
- **Processor** (`processors/vetra-cloud-environment/gitops.ts`):
  - `isPreviewEnv(state) = state.app?.role === "PREVIEW"` decides the slim profile: size S, 5 Gi database without backups, `persistence.enabled: false`, `previews/` root, dev registry.
  - Any other role, or none, gets the full profile: `hostBlock(false)` `/data` 10 Gi longhorn, CNPG 50 Gi with `backup.enabled: true` and scheduled backups to `s3://powerhouse-cnpg-backups/<tenant>/`, `tenants/` root, the FUSION size from `selectedRessource`.
  - The image allowlist (`app-image-project.ts`) vouches for any document linked to an App whose id is in `instances` (any role), from `apps.registry_namespace`.
- **Environment model:**
  - `AppEnvironmentRole = PRODUCTION | PREVIEW` (`document-models/vetra-cloud-environment/v1/schema.graphql`, `vetra-cloud-environment.json`, `v1/gen/document-model.ts`, `v1/gen/schema/types.ts`, `v1/gen/schema/zod.ts`).
  - `SET_APP_LINK` is system-only.
  - `SLEEP_ENVIRONMENT` is allowed from READY or `DEPLOYMENt_FAILED` only. `WAKE_ENVIRONMENT` only from STOPPED.
  - `SET_SERVICE_SIZE {prefix, size}` sets `selectedRessource`.
- **Licences** (`subgraphs/vetra-licensing/`):
  - `app_license_grants (license_id, app_id, license_type_id NOT NULL, user_address NOT NULL lowercased, issued_by, created_at, kind nullable, user_did nullable)`.
  - `license_chain (license_id, root_license_id, app_id, label, created_at)`. A licence without a row is its own root.
  - `license_lifecycle (license_id, status, end_at, replaced_by, updated_at)`. `lifecycle.ts` `isLiveEntry({status, endAt}, nowIso)`: ACTIVE and not past its end.
  - `license_environments (environment_id, root_license_id, app_id, …)`: one licensed environment per chain (Sektar).
  - Licensing's `up` is `subgraphs/vetra-licensing/db/migrations.ts` `up`.
  - vetra-apps already opens the `vetra-licensing` namespace (`index.ts`: ledger, `releasePolicy`), and licensing opens `vetra-apps` read-only (`index.ts` `onSetup`, `appsDb: Kysely<VetraAppsDB>`).
- **Licensing's handler** (`handler.ts` `AppLicenseHandler.reconcileApp`):
  - builds `PlanLicence[]` (`chain-plan.ts`: `{ id, user, kind, status, issued, stage, root, authorised, replacedBy }`) per App;
  - calls `planChains({ licences, environments, resolve, app, holdUnverified })`, then `this.holdChains(planned, licences, heldRoots)`.
  - A SHARED head only gets `set-stage`. A DEDICATED head gets a licensed environment.
- **Service identity:** `vetraServiceAddress()` (`subgraphs/vetra-cloud-observability/env-protection.ts`) is `VETRA_SERVICE_ADDRESS`, else an address nobody can sign as. `AppsDeps.serviceOwner?: string` exists.
- **Config:** `loadAppsConfig` (`subgraphs/vetra-apps/config.ts`). `instancesConfig` uses `INSTANCES_OFF`/`INSTANCES_ON` sets, `trimmed`, `intIn`. `config.test.ts` compares `loadAppsConfig({}).instances` with `toEqual`, so new settings go in a separate top-level `plans` key.

## Model (as built here)

| Plan field | Meaning |
|---|---|
| `kind` | The licensing term kind the plan adopted. Its live licences are the plan's holders. Unique per App. |
| `slug` | `[a-z0-9]`, 1-31 characters, inner `-`. Unique per App. Names the shared instance. Reserved: `main`, `team`, `own`, `own-*`, `pr-<n>`, the production branch, and any name matching the App's release branches. |
| `access` | `shared` (one instance; holders are members, the licence gate arrives in slice 5) or `own` (one instance per licence chain; the holder is the instance's admin). |
| `size` | `VETRA_AGENT_S` … `VETRA_AGENT_XXL` (default S). |
| `target_version` | A recorded **release** of the App (never a build), or null (no instances yet). |
| `policy`, `notice_hours` | Stored (`manual`, 72). Slice 3 acts on them. |
| `status` | `active` or `retired`. A retired plan keeps serving existing holders; its shared instance is stopped once no live licence is left. |

**Plan instances.**
- **Shared:** name = the plan's slug; host `instanceLabel(app.id, app.slug, slug, suffix, "plan:<slug>")`.
- **Own:** name = `own-<12 hex of sha256(root licence id)>`; host `generateSubdomain(instance id) + suffix` when it fits 31 characters, else `instanceLabel(app.id, app.slug, "own", suffix, "own:<root>")`.
- Environment document: owner = `deps.serviceOwner ?? vetraServiceAddress()`, no organisation; `app` link `{ appId, role: "PLAN", prNumber: null, gitRef: null, imageProject }`; FUSION size = the plan's size.
- `ADMINS`: own → the holder's address; shared → the App owner.

**Lifecycle.**
- The chain is live → the own row exists, follows the plan's target, `stop_reason` null.
- Its licence ended → `licence_ended_at` = first pass that saw it ended. After `stopAfterDays`, `stop_reason = "the licence ended"` → the environment sleeps.
- Live again (renewal, upgrade in the same chain) → `stop_reason` null → woken.
- A shared instance of a retired plan with no live licence of its kind → `stop_reason = "the plan is retired and has no live licences"`.
- Nothing is deleted.

## Global Constraints

- Only rows of the `instances` table are touched. Licensed environments (`license_environments`, `app_warm_pool`, any document with `managedBy`), production environments and Studio environments are never read for plans or written.
- A chain with a `license_environments` row never gets an own instance.
- `createPlan` refuses an App that has any `license_environments` row (Sektar moves in slice 9), and a kind with any live licence. Untyped (null-kind) live licences count as that kind.
- The licensing handler leaves chains of plan-owned kinds alone only when they have no licensed environment.
- Kill switch: `VETRA_APPS_PLANS` (default **off**) gates `syncPlanInstances` **and** the reconcile of every `shared`/`own` row. `VETRA_APPS_INSTANCES=off` stops everything as before. The API stores plans whatever the switch says.
- Mutations: `loadAppForOwner` (default `need: "operate"`); `appPlans`: `need: "view"`; `myInstances`: any signed-in caller, own data only.
- Additive schema only, through idempotent, race-tolerant `ensure…` migrations like the existing ones. The new enum value is additive: no document changes, and existing documents stay valid.
- No plan-instance document is ever deleted, and `removeInstance` refuses plan kinds.
- Commits: one per task, conventional (`feat(model): …`, `feat(plans): …`, `feat(instances): …`, `feat(licensing): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-plans` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, and `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors/vetra-cloud-environment document-models/vetra-cloud-environment 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4). Production keeps `VETRA_APPS_PLANS` unset.

## File structure

| File | Change |
|---|---|
| `document-models/vetra-cloud-environment/v1/schema.graphql`, `vetra-cloud-environment.json`, `v1/gen/document-model.ts`, `v1/gen/schema/types.ts`, `v1/gen/schema/zod.ts` | `AppEnvironmentRole` gains `PLAN` |
| `document-models/vetra-cloud-environment/v1/tests/app-link.test.ts` | `PLAN` link test |
| `processors/vetra-cloud-environment/fusion.test.ts` | `PLAN` renders the full profile |
| `subgraphs/vetra-apps/config.ts` | `PlansConfig`, `plansConfigOf`, `VETRA_APPS_PLANS`, `VETRA_APPS_PLAN_STOP_AFTER_DAYS` |
| `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts` | `plans` table; plan columns on `instances` |
| `subgraphs/vetra-apps/plans/repo.ts` (new) | `plans` reads and writes |
| `subgraphs/vetra-apps/plans/rules.ts` (new) | access, size, slug rules (pure) |
| `subgraphs/vetra-apps/plans/holders.ts` (new) | licence chains, licensed roots, a holder's live kinds |
| `subgraphs/vetra-apps/plans/service.ts` (new) | `appPlansFor`, `createPlan`, `updatePlan`, `setPlanTarget`, `retirePlan` |
| `subgraphs/vetra-apps/plans/sync.ts` (new) | `syncPlanInstances`, `isPlanKind`, `ownInstanceName` |
| `subgraphs/vetra-apps/plans/holder-view.ts` (new) | `myInstancesFor` |
| `subgraphs/vetra-apps/releases/repo.ts` | `releaseByVersion` |
| `subgraphs/vetra-apps/instances/host.ts` | `instanceLabel(…, identity)`, `planInstanceLabel` |
| `subgraphs/vetra-apps/instances/render.ts` | role `PLAN`, size, nullable `gitRef`, `isInstanceRole` |
| `subgraphs/vetra-apps/instances/reconciler.ts` | plan kinds: sync, stop/wake, admins, owner, size, host, guards |
| `subgraphs/vetra-apps/instances/service.ts` | `AppInstance.planId`, `holder` |
| `subgraphs/vetra-apps/service.ts` | `AppsDeps.licensingDb` |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | plan types, queries, mutations |
| `subgraphs/vetra-apps/index.ts` | `licensingDb` wiring |
| `subgraphs/vetra-licensing/plan-kinds.ts` (new), `handler.ts`, `index.ts` | plan-owned kinds left to instances |
| Tests (`subgraphs/vetra-apps/__tests__/` unless noted) | `harness.ts` (licensing tables), `instances-fixtures.ts` (`seedLicence`, `seedLicensedEnvironment`), `config.test.ts`, `migrations.test.ts`, `plans-rules.test.ts`, `plans-holders.test.ts`, `plans-api.test.ts`, `instances-plan-host.test.ts`, `instances-plan-render.test.ts`, `instances-plans.test.ts`, `plans-holder-view.test.ts` (all new except the first four); `subgraphs/vetra-licensing/__tests__/plan-kinds.test.ts` (new) |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-3-plans origin/main`. Never stash, and never touch the other worktrees of this repository (`git worktree list` shows them).
- [ ] **Step 2: Baseline.** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors/vetra-cloud-environment document-models/vetra-cloud-environment 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record failures that exist before any change in the PR description; do not fix them here.

---

### Task 1: Environment role `PLAN`

**Files:**
- Modify: `document-models/vetra-cloud-environment/v1/schema.graphql`, `document-models/vetra-cloud-environment/vetra-cloud-environment.json`, `document-models/vetra-cloud-environment/v1/gen/document-model.ts`, `document-models/vetra-cloud-environment/v1/gen/schema/types.ts`, `document-models/vetra-cloud-environment/v1/gen/schema/zod.ts`
- Test: `document-models/vetra-cloud-environment/v1/tests/app-link.test.ts`, `processors/vetra-cloud-environment/fusion.test.ts`

**Interfaces:**
- Produces: `AppEnvironmentRole = "PREVIEW" | "PRODUCTION" | "PLAN"`. `PLAN` = a plan's instance (shared or own), rendered with the full profile.

- [ ] **Step 1: Write the failing tests.** Append to the `describe("SET_APP_LINK / CLEAR_APP_LINK", …)` block of `app-link.test.ts`:

```ts
  it("accepts the PLAN role (a plan's instance, releases phase 3)", () => {
    const link = {
      appId: "app-1",
      role: "PLAN" as const,
      prNumber: null,
      gitRef: null,
      imageProject: "acme",
    };
    const doc = reducer(utils.createDocument(), setAppLink(link));
    expect(doc.operations.global.at(-1)?.error).toBeUndefined();
    expect(doc.state.global.app).toStrictEqual(link);
  });
```

Append inside `describe("generateValuesYaml — FUSION host image (PH_HOST)", …)` of `fusion.test.ts`, after `it("keeps no volume for a preview", …)`:

```ts
  it("gives a plan instance the full profile: kept /data and backed-up database", async () => {
    const yaml = await render(
      hostState([], {
        app: {
          appId: "app-1",
          role: "PLAN",
          prNumber: null,
          gitRef: null,
          imageProject: null,
        },
      }),
    );
    expect(appBlock(yaml)).toContain("  persistence:\n    enabled: true");
    expect(yaml).toContain("    storageSize: 50Gi");
    expect(yaml).toMatch(/    backup:\n      enabled: true/);
  });
```

- [ ] **Step 2: Run them.** `npx vitest run document-models/vetra-cloud-environment/v1/tests/app-link.test.ts processors/vetra-cloud-environment/fusion.test.ts 2>&1 | grep -E "FAIL|Tests|failed|error" | tail -20`. Expected: the app-link test fails (`SET_APP_LINK` input rejected: `Invalid enum value`); the fusion test fails to type-check or passes at runtime. Either way it is committed with the change.
- [ ] **Step 3: Implement.** In `v1/schema.graphql` replace

```graphql
enum AppEnvironmentRole {
  PRODUCTION
  PREVIEW
}
```

with

```graphql
enum AppEnvironmentRole {
  PRODUCTION
  PREVIEW
  PLAN
}
```

In `v1/gen/schema/types.ts` line 71: `export type AppEnvironmentRole = "PREVIEW" | "PRODUCTION" | "PLAN";`. In `v1/gen/schema/zod.ts` line 85: `export const AppEnvironmentRoleSchema = z.enum(["PREVIEW", "PRODUCTION", "PLAN"]);`. The JSON and `document-model.ts` carry the state schema as an escaped string (exactly one occurrence each). Patch both with:

```bash
node -e '
const fs = require("fs");
for (const f of ["document-models/vetra-cloud-environment/vetra-cloud-environment.json", "document-models/vetra-cloud-environment/v1/gen/document-model.ts"]) {
  const s = fs.readFileSync(f, "utf8");
  const from = "PRODUCTION\\n  PREVIEW\\n}";
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(f + ": expected 1 occurrence, found " + n);
  fs.writeFileSync(f, s.replace(from, "PRODUCTION\\n  PREVIEW\\n  PLAN\\n}"));
}'
```

- [ ] **Step 4: Run them.** Same command. Expected: PASS. Then `npx tsc --noEmit -p . 2>&1 | grep -E "AppEnvironmentRole|role" | head`. Fix any exhaustive `switch` the compiler names by adding a `PLAN` case that behaves like `PRODUCTION` for rendering. The known role readers compare with `"PREVIEW"`/`"PRODUCTION"` only and need nothing.
- [ ] **Step 5: Commit.** `git add document-models/vetra-cloud-environment processors/vetra-cloud-environment/fusion.test.ts && git commit -m "feat(model): PLAN role on the environment's app link (a plan's instance, full profile)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: Plans config

**Files:**
- Modify: `subgraphs/vetra-apps/config.ts`
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `PlansConfig { enabled: boolean; stopAfterDays: number }`;
  - `DEFAULT_PLANS: PlansConfig = { enabled: false, stopAfterDays: 14 }`;
  - `VetraAppsConfig.plans?: PlansConfig` (optional: test configs without it are "off");
  - `plansConfigOf(cfg: VetraAppsConfig): PlansConfig`.
  - Env: `VETRA_APPS_PLANS` (on/off words as `VETRA_APPS_INSTANCES`; unset = off) and `VETRA_APPS_PLAN_STOP_AFTER_DAYS` (1-90, default 14; overview D4).

- [ ] **Step 1: Write the failing test** (append to `config.test.ts`; extend the import to `import { DEFAULT_INSTANCE_HEALTH, DEFAULT_PLANS, loadAppsConfig, plansConfigOf } from "../config.js";`):

```ts
describe("plans config", () => {
  it("is off with a 14-day stop by default", () => {
    expect(loadAppsConfig({}).plans).toEqual({ enabled: false, stopAfterDays: 14 });
    expect(DEFAULT_PLANS).toEqual({ enabled: false, stopAfterDays: 14 });
  });
  it("turns on with VETRA_APPS_PLANS=on and takes the stop window", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_PLANS: " On ", VETRA_APPS_PLAN_STOP_AFTER_DAYS: "7" }).plans,
    ).toEqual({ enabled: true, stopAfterDays: 7 });
  });
  it("refuses unknown values at startup", () => {
    expect(() => loadAppsConfig({ VETRA_APPS_PLANS: "maybe" })).toThrow(/VETRA_APPS_PLANS.*maybe/);
    expect(() => loadAppsConfig({ VETRA_APPS_PLAN_STOP_AFTER_DAYS: "0" })).toThrow(
      /VETRA_APPS_PLAN_STOP_AFTER_DAYS/,
    );
  });
  it("reads a config without plans as off", () => {
    const { plans: _drop, ...rest } = loadAppsConfig({ VETRA_APPS_PLANS: "on" });
    expect(plansConfigOf(rest)).toEqual(DEFAULT_PLANS);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`DEFAULT_PLANS` not exported).
- [ ] **Step 3: Implement.** In `config.ts`, inside `VetraAppsConfig` after `instances: {…};`:

```ts
  /**
   * Releases phase 3 plans (shared and own instances). Absent = off.
   * VETRA_APPS_PLANS=on runs them; VETRA_APPS_PLAN_STOP_AFTER_DAYS is how long
   * an own instance keeps running after its licence ended.
   */
  plans?: PlansConfig;
```

After `DEFAULT_INSTANCE_HEALTH`:

```ts
export interface PlansConfig {
  enabled: boolean;
  stopAfterDays: number;
}

export const DEFAULT_PLANS: PlansConfig = { enabled: false, stopAfterDays: 14 };

export const plansConfigOf = (cfg: VetraAppsConfig): PlansConfig =>
  cfg.plans ?? DEFAULT_PLANS;
```

After `instancesConfig`:

```ts
function plansConfig(env: Env): PlansConfig {
  const raw = (trimmed(env.VETRA_APPS_PLANS) ?? "").toLowerCase();
  if (!INSTANCES_OFF.has(raw) && !INSTANCES_ON.has(raw)) {
    throw new Error(
      `VETRA_APPS_PLANS "${env.VETRA_APPS_PLANS}" is invalid: use on/off (also true/false, 1/0, yes/no)`,
    );
  }
  return {
    // Unset means off: plans are opted into per environment.
    enabled: raw !== "" && INSTANCES_ON.has(raw),
    stopAfterDays: intIn(env, "VETRA_APPS_PLAN_STOP_AFTER_DAYS", 14, 1, 90),
  };
}
```

In `loadAppsConfig`'s returned object, after `instances: instancesConfig(env),`: `plans: plansConfig(env),`.

- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/__tests__/config.test.ts && git commit -m "feat(plans): VETRA_APPS_PLANS switch and stop window" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: `plans` table, plan columns on `instances`, licensing tables in the test harness

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`, `subgraphs/vetra-apps/service.ts` (`AppsDeps.licensingDb`), `subgraphs/vetra-apps/__tests__/harness.ts`, `subgraphs/vetra-apps/__tests__/instances-fixtures.ts`
- Create: `subgraphs/vetra-apps/plans/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Produces (schema):
  - `PlanAccess = "shared" | "own"`, `PlanStatus = "active" | "retired"`.
  - `PlansTable { id; app_id; slug; name; kind; access: PlanAccess; size: string; target_version: string | null; policy: string; notice_hours: number; status: PlanStatus; created_by; created_at; updated_at }`, unique `(app_id, slug)` and `(app_id, kind)`, in `VetraAppsDB.plans`.
  - `InstancesTable` gains `plan_id`, `holder_address`, `licence_root_id`, `licence_ended_at`, `stop_reason`, `target_size` (all `string | null`), `stopped_by_vetra: boolean | null`, and a partial unique index `instances_licence_root_uq (app_id, licence_root_id)`.
- Produces (repo): `PlanRow = Selectable<PlansTable>`; `listPlans(db, appId): Promise<PlanRow[]>` (by `created_at`, `id`); `getPlan(db, id): Promise<PlanRow | null>`; `insertPlan(db, row: PlanRow): Promise<PlanRow>`; `updatePlan(db, id, patch: Partial<Omit<PlanRow, "id" | "app_id" | "kind" | "created_at" | "created_by">>, nowIso): Promise<PlanRow>`.
- Produces (deps): `AppsDeps.licensingDb?: Kysely<VetraLicensingDB> | null`.
- Produces (tests):
  - The harness runs licensing's `up` on the same PGlite database and sets `deps.licensingDb`.
  - `seedLicence(h, o: { appId; kind: string | null; holder: string; licenseId: string; root?: string; status?: string; endAt?: string | null }): Promise<void>`.
  - `seedLicensedEnvironment(h, o: { appId; root: string; environmentId?: string }): Promise<void>`.

- [ ] **Step 1: Write the failing test** (append to `migrations.test.ts`; reuse its PGlite `db` and `up` import; add `import { getPlan, insertPlan, listPlans, updatePlan } from "../plans/repo.js";`):

```ts
describe("plans and the instances' plan columns", () => {
  it("are created idempotently; a plan is unique per app by slug and by kind", async () => {
    await up(db as Kysely<any>); // second run: no error
    const row = {
      id: "plan-1",
      app_id: "app-1",
      slug: "pro",
      name: "Pro",
      kind: "pro",
      access: "own" as const,
      size: "VETRA_AGENT_M",
      target_version: null,
      policy: "manual",
      notice_hours: 72,
      status: "active" as const,
      created_by: "0xaa",
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
    };
    await insertPlan(db, row);
    await expect(insertPlan(db, { ...row, id: "plan-2", kind: "other" })).rejects.toThrow();
    await expect(insertPlan(db, { ...row, id: "plan-3", slug: "other" })).rejects.toThrow();
    const moved = await updatePlan(db, "plan-1", { target_version: "1.4.0" }, "2026-11-12T01:00:00.000Z");
    expect(moved).toMatchObject({ target_version: "1.4.0", updated_at: "2026-11-12T01:00:00.000Z" });
    expect((await listPlans(db, "app-1")).map((p) => p.id)).toEqual(["plan-1"]);
    expect(await getPlan(db, "missing")).toBeNull();
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'instances'`.execute(db);
    const names = cols.rows.map((c) => c.column_name);
    for (const c of [
      "plan_id",
      "holder_address",
      "licence_root_id",
      "licence_ended_at",
      "stop_reason",
      "stopped_by_vetra",
      "target_size",
    ])
      expect(names).toContain(c);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module `../plans/repo.js` not found).
- [ ] **Step 3: Schema.** In `db/schema.ts`, before `InstancesTable`:

```ts
/** shared: one instance for all holders; own: one instance per licence chain (spec section 5). */
export type PlanAccess = "shared" | "own";
export type PlanStatus = "active" | "retired";

/** What holders of one licensing term get (spec section 7; overview gap 1: a plan adopts a term by kind). */
export interface PlansTable {
  id: string;
  app_id: string;
  /** Names the shared instance; unique per App (plans/rules.ts). */
  slug: string;
  name: string;
  /** The licensing term kind adopted: its live licences are this plan's holders. Unique per App. */
  kind: string;
  access: PlanAccess;
  /** VETRA_AGENT_S … VETRA_AGENT_XXL: the FUSION size of every instance of the plan. */
  size: string;
  /** A recorded release of the App (never a build); null: no instances yet. */
  target_version: string | null;
  /** manual | patches | minor | follow:<branch>. Stored; rollouts (slice 3) act on it. */
  policy: string;
  notice_hours: number;
  status: PlanStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}
```

Add `plans: PlansTable;` to `VetraAppsDB` after `instances`. In `InstancesTable`, after `observed_settings`:

```ts
  /** shared/own: the plan the instance serves. */
  plan_id?: string | null;
  /** own: the holder's lowercased address (ADMINS). */
  holder_address?: string | null;
  /** own: the licence chain's root (license_chain.root_license_id, or the licence itself). */
  licence_root_id?: string | null;
  /** own: when a pass first saw the chain without a live licence. */
  licence_ended_at?: string | null;
  /** Set: the instance is to be stopped (the reconciler sleeps its environment). */
  stop_reason?: string | null;
  /** The environment was put to sleep by Vetra (woken by Vetra when stop_reason clears). */
  stopped_by_vetra?: boolean | null;
  /** shared/own: the FUSION size (VetraCloudRessourceSize) of the plan. */
  target_size?: string | null;
```

- [ ] **Step 4: Migrations.** In `db/migrations.ts`, after `ensureInstancesSettingsColumns`:

```ts
/** Plans (releases phase 3 slice 1). Schema builder only (namespaced). */
export async function ensurePlansTable(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("plans")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("slug", "varchar(63)", (c) => c.notNull())
      .addColumn("name", "varchar(255)", (c) => c.notNull())
      .addColumn("kind", "varchar(255)", (c) => c.notNull())
      .addColumn("access", "varchar(16)", (c) => c.notNull())
      .addColumn("size", "varchar(32)", (c) => c.notNull())
      .addColumn("target_version", "varchar(255)")
      .addColumn("policy", "varchar(255)", (c) => c.notNull())
      .addColumn("notice_hours", "integer", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("created_by", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addUniqueConstraint("plans_app_slug_uq", ["app_id", "slug"])
      .addUniqueConstraint("plans_app_kind_uq", ["app_id", "kind"])
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}

/** Plan columns on instances (slice 1). Nullable. */
export async function ensureInstancesPlanColumns(db: Kysely<any>): Promise<void> {
  for (const [name, type] of [
    ["plan_id", "varchar(64)"],
    ["holder_address", "varchar(255)"],
    ["licence_root_id", "varchar(255)"],
    ["licence_ended_at", "varchar(64)"],
    ["stop_reason", "text"],
    ["stopped_by_vetra", "boolean"],
    ["target_size", "varchar(32)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
  try {
    await db.schema
      .createIndex("instances_licence_root_uq")
      .ifNotExists()
      .unique()
      .on("instances")
      .columns(["app_id", "licence_root_id"])
      .where(sql.ref("licence_root_id"), "is not", null)
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}
```

Append to `up`, after `await ensureInstancesSettingsColumns(db);`:

```ts
  await ensurePlansTable(db);
  await ensureInstancesPlanColumns(db);
```

- [ ] **Step 5: Repo.** Create `subgraphs/vetra-apps/plans/repo.ts`:

```ts
import type { Kysely, Selectable } from "kysely";
import type { PlansTable, VetraAppsDB } from "../db/schema.js";

export type PlanRow = Selectable<PlansTable>;
export type PlanPatch = Partial<
  Omit<PlanRow, "id" | "app_id" | "kind" | "created_at" | "created_by">
>;

export async function listPlans(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow[]> {
  return db
    .selectFrom("plans")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
}

export async function getPlan(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<PlanRow | null> {
  return (
    (await db.selectFrom("plans").selectAll().where("id", "=", id).executeTakeFirst()) ??
    null
  );
}

export async function insertPlan(
  db: Kysely<VetraAppsDB>,
  row: PlanRow,
): Promise<PlanRow> {
  return db.insertInto("plans").values(row).returningAll().executeTakeFirstOrThrow();
}

export async function updatePlan(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: PlanPatch,
  nowIso: string,
): Promise<PlanRow> {
  return db
    .updateTable("plans")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}
```

- [ ] **Step 6: Deps and harness.** In `service.ts`:
  - add `import type { VetraLicensingDB } from "../vetra-licensing/db/schema.js";`;
  - in `AppsDeps` after `settingsVault`, add:

```ts
  /** Licensing's tables (licences of plans' kinds, licensed environments). Null/absent: plans have no holders and cannot be created. */
  licensingDb?: Kysely<VetraLicensingDB> | null;
```

In `__tests__/harness.ts`:
  - add `import { up as upLicensing } from "../../vetra-licensing/db/migrations.js";` and `import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";`;
  - after `await upObservability(db as Kysely<any>);` add `await upLicensing(db as Kysely<any>);` with the comment `// Licensing's tables, read by plans; no table name overlaps.`;
  - in `deps` add `licensingDb: db as unknown as Kysely<VetraLicensingDB>,`.

Append to `__tests__/instances-fixtures.ts` (add `import type { Kysely } from "kysely";`, `import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";`, and `OWNER` to the harness import):

```ts
const lic = (h: Harness) => h.db as unknown as Kysely<VetraLicensingDB>;

/** A licence as issueLicense records it: grant, chain link, lifecycle. */
export async function seedLicence(
  h: Harness,
  o: {
    appId: string;
    kind: string | null;
    holder: string;
    licenseId: string;
    root?: string;
    status?: string;
    endAt?: string | null;
  },
): Promise<void> {
  const at = "2026-10-01T00:00:00.000Z";
  await lic(h)
    .insertInto("app_license_grants")
    .values({
      license_id: o.licenseId,
      app_id: o.appId,
      license_type_id: o.kind ?? "legacy",
      user_address: o.holder.toLowerCase(),
      issued_by: OWNER,
      created_at: at,
      kind: o.kind,
      user_did: `did:pkh:eip155:1:${o.holder.toLowerCase()}`,
    })
    .execute();
  await lic(h)
    .insertInto("license_chain")
    .values({
      license_id: o.licenseId,
      root_license_id: o.root ?? o.licenseId,
      app_id: o.appId,
      label: null,
      created_at: at,
    })
    .execute();
  await lic(h)
    .insertInto("license_lifecycle")
    .values({
      license_id: o.licenseId,
      status: o.status ?? "ACTIVE",
      end_at: o.endAt ?? null,
      replaced_by: null,
      updated_at: at,
    })
    .execute();
}

/** A licensed environment of the old model for a chain (Sektar's kind of row). */
export async function seedLicensedEnvironment(
  h: Harness,
  o: { appId: string; root: string; environmentId?: string },
): Promise<void> {
  const at = "2026-10-01T00:00:00.000Z";
  await lic(h)
    .insertInto("license_environments")
    .values({
      environment_id: o.environmentId ?? `licensed-${o.root}`,
      root_license_id: o.root,
      app_id: o.appId,
      user_did: "did:pkh:eip155:1:0x0",
      license_id: o.root,
      template_id: "template-1",
      label: null,
      template_hash: "h",
      ended_at: null,
      stopped_at: null,
      delete_after: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}
```

(If `license_environments` has further NOT NULL columns in `subgraphs/vetra-licensing/db/migrations.ts` than `LicenseEnvironments` in `db/schema.ts` lists, add them with the same neutral values; the schema file is the source of truth for names.)

- [ ] **Step 7: Run it.** Same command as Step 2, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`, which checks that the harness change breaks nothing. Expected: PASS.
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(plans): plans table and plan columns on instances" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Plan rules (pure)

**Files:**
- Create: `subgraphs/vetra-apps/plans/rules.ts`
- Test: `subgraphs/vetra-apps/__tests__/plans-rules.test.ts`

**Interfaces:**
- Produces:
  - `PLAN_SIZES` (the five `VETRA_AGENT_*` names) and `type PlanSize`;
  - `parseAccess(v: string): PlanAccess` (case-insensitive `shared`/`own`, else `BAD_USER_INPUT`);
  - `parseSize(v?: string | null): PlanSize` (default `VETRA_AGENT_S`);
  - `slugFromKind(kind: string): string`;
  - `checkPlanSlug(slug: string, app: Pick<AppRow, "production_branch" | "release_branches">): void` (throws `BAD_USER_INPUT` naming the reason).

- [ ] **Step 1: Write the failing test** `plans-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkPlanSlug, parseAccess, parseSize, slugFromKind } from "../plans/rules.js";

const app = { production_branch: "main", release_branches: '["next","*.x"]' };
const bad = (f: () => unknown) =>
  expect(f).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: "BAD_USER_INPUT" }) }));

describe("plan rules", () => {
  it("parses access and size", () => {
    expect(parseAccess("SHARED")).toBe("shared");
    expect(parseAccess("own")).toBe("own");
    bad(() => parseAccess("team"));
    expect(parseSize(undefined)).toBe("VETRA_AGENT_S");
    expect(parseSize("VETRA_AGENT_M")).toBe("VETRA_AGENT_M");
    bad(() => parseSize("HUGE"));
  });
  it("derives a slug from a kind", () => {
    expect(slugFromKind("Pro Plan 2026")).toBe("pro-plan-2026");
    expect(slugFromKind("x".repeat(40))).toHaveLength(31);
  });
  it("accepts a plain slug", () => {
    expect(() => checkPlanSlug("starter", app)).not.toThrow();
  });
  it.each(["main", "team", "own", "own-1", "pr-12", "next", "1.x", "-a", "a-", "A", ""])(
    "refuses %j",
    (slug) => bad(() => checkPlanSlug(slug, app)),
  );
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/plans-rules.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `plans/rules.ts`:

```ts
import type { PlanAccess } from "../db/schema.js";
import { appsError } from "../errors.js";
import type { AppRow } from "../repo.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import { MAX_INSTANCE_LABEL } from "../instances/host.js";

export const PLAN_SIZES = [
  "VETRA_AGENT_S",
  "VETRA_AGENT_M",
  "VETRA_AGENT_L",
  "VETRA_AGENT_XL",
  "VETRA_AGENT_XXL",
] as const;
export type PlanSize = (typeof PLAN_SIZES)[number];

export function parseAccess(v: string): PlanAccess {
  const a = v.trim().toLowerCase();
  if (a === "shared" || a === "own") return a;
  throw appsError("BAD_USER_INPUT", `Access "${v}" is not shared or own`);
}

export function parseSize(v?: string | null): PlanSize {
  if (v == null || v === "") return "VETRA_AGENT_S";
  const found = PLAN_SIZES.find((s) => s === v);
  if (!found)
    throw appsError("BAD_USER_INPUT", `Size "${v}" is not one of ${PLAN_SIZES.join(", ")}`);
  return found;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MAX = MAX_INSTANCE_LABEL;

export function slugFromKind(kind: string): string {
  return kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** Throws BAD_USER_INPUT when the slug is malformed or names something reserved (overview gap 11, spec section 5). */
export function checkPlanSlug(
  slug: string,
  app: Pick<AppRow, "production_branch" | "release_branches">,
): void {
  const refuse = (why: string) =>
    appsError("BAD_USER_INPUT", `The plan slug "${slug}" ${why}`);
  if (!slug || slug.length > SLUG_MAX || !SLUG.test(slug))
    throw refuse(`must be 1-${SLUG_MAX} lowercase letters, digits and inner dashes`);
  if (slug === "main" || slug === "team" || slug === "own" || slug.startsWith("own-"))
    throw refuse("is reserved");
  if (/^pr-\d+$/.test(slug)) throw refuse("is reserved for previews");
  if (
    isReleaseBranch(
      slug,
      app.production_branch,
      parseReleaseBranches(app.release_branches),
    )
  )
    throw refuse("names a release branch of the App");
}
```

- [ ] **Step 4: Run it.** Same command. Expected: PASS. (`1.x` fails the slug pattern before the branch check, which is fine; `next` reaches the branch check.)
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/rules.ts subgraphs/vetra-apps/__tests__/plans-rules.test.ts && git commit -m "feat(plans): access, size and slug rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: Holders from licensing's tables

**Files:**
- Create: `subgraphs/vetra-apps/plans/holders.ts`
- Test: `subgraphs/vetra-apps/__tests__/plans-holders.test.ts`

**Interfaces:**
- Produces:
  - `ChainHead { root: string; licenseId: string; kind: string | null; address: string; endAt: string | null }`.
  - `liveChains(db: Kysely<VetraLicensingDB>, appId: string, nowIso: string): Promise<Map<string, ChainHead>>`: root → its live licence (`isLiveEntry`), the newest grant when several are live.
  - `licensedRoots(db, appId): Promise<Set<string>>`: roots with a `license_environments` row, ended ones included.
  - `hasLicensedEnvironments(db, appId): Promise<boolean>`.
  - `liveKindsOfHolder(db, address, nowIso): Promise<Array<{ appId: string; kind: string }>>`.

- [ ] **Step 1: Write the failing test** `plans-holders.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { makeHarness, type Harness } from "./harness.js";
import { seedLicence, seedLicensedEnvironment } from "./instances-fixtures.js";
import {
  hasLicensedEnvironments,
  licensedRoots,
  liveChains,
  liveKindsOfHolder,
} from "../plans/holders.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const NOW = "2026-11-12T00:00:00.000Z";
let h: Harness;
let lic: Kysely<VetraLicensingDB>;

beforeEach(async () => {
  h = await makeHarness();
  lic = h.deps.licensingDb!;
});
afterEach(async () => {
  await h.close();
});

describe("plan holders", () => {
  it("lists one live head per chain: renewals keep the root, ended and expired-by-date licences drop out", async () => {
    await seedLicence(h, { appId: "app", kind: "pro", holder: A, licenseId: "l1", status: "REPLACED" });
    await seedLicence(h, { appId: "app", kind: "pro", holder: A, licenseId: "l2", root: "l1" });
    await seedLicence(h, { appId: "app", kind: "pro", holder: B, licenseId: "l3", endAt: "2026-11-01T00:00:00.000Z" });
    await seedLicence(h, { appId: "other", kind: "pro", holder: B, licenseId: "l4" });
    const live = await liveChains(lic, "app", NOW);
    expect([...live.keys()]).toEqual(["l1"]);
    expect(live.get("l1")).toEqual({ root: "l1", licenseId: "l2", kind: "pro", address: A, endAt: null });
  });

  it("knows licensed roots and a holder's live kinds", async () => {
    await seedLicence(h, { appId: "app", kind: "pro", holder: A, licenseId: "l1" });
    await seedLicence(h, { appId: "app", kind: null, holder: A, licenseId: "l2" });
    expect(await hasLicensedEnvironments(lic, "app")).toBe(false);
    await seedLicensedEnvironment(h, { appId: "app", root: "l1" });
    expect(await hasLicensedEnvironments(lic, "app")).toBe(true);
    expect([...(await licensedRoots(lic, "app"))]).toEqual(["l1"]);
    expect(await liveKindsOfHolder(lic, A, NOW)).toEqual([
      { appId: "app", kind: "pro" },
    ]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/plans-holders.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `plans/holders.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { isLiveEntry } from "../../vetra-licensing/lifecycle.js";

export interface ChainHead {
  root: string;
  licenseId: string;
  kind: string | null;
  /** Lowercased 0x address of the holder. */
  address: string;
  endAt: string | null;
}

/**
 * Every licence chain of the App that has a live licence (license_lifecycle,
 * the record the system wrote: ACTIVE and not past its end), keyed by root.
 * A chain with several live licences (a moment during an upgrade) is
 * represented by the newest grant.
 */
export async function liveChains(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  nowIso: string,
): Promise<Map<string, ChainHead>> {
  const rows = await db
    .selectFrom("app_license_grants as g")
    .leftJoin("license_chain as c", "c.license_id", "g.license_id")
    .innerJoin("license_lifecycle as l", "l.license_id", "g.license_id")
    .select([
      "g.license_id as licenseId",
      "g.kind as kind",
      "g.user_address as address",
      "g.created_at as createdAt",
      "c.root_license_id as root",
      "l.status as status",
      "l.end_at as endAt",
    ])
    .where("g.app_id", "=", appId)
    .orderBy("g.created_at", "asc")
    .orderBy("g.license_id", "asc")
    .execute();
  const out = new Map<string, ChainHead>();
  for (const r of rows) {
    if (!isLiveEntry({ status: r.status, endAt: r.endAt }, nowIso)) continue;
    const root = r.root ?? r.licenseId;
    // Ordered oldest first: a newer live grant of the same chain wins.
    out.set(root, {
      root,
      licenseId: r.licenseId,
      kind: r.kind,
      address: r.address.toLowerCase(),
      endAt: r.endAt,
    });
  }
  return out;
}

/** Chains the old model runs a licensed environment for (overview rule 1). */
export async function licensedRoots(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("license_environments")
    .select("root_license_id")
    .where("app_id", "=", appId)
    .execute();
  return new Set(rows.map((r) => r.root_license_id));
}

export async function hasLicensedEnvironments(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("license_environments")
    .select("environment_id")
    .where("app_id", "=", appId)
    .executeTakeFirst());
}

/** The (App, kind) pairs the address holds a live licence of; kinds unknown (null) are left out. */
export async function liveKindsOfHolder(
  db: Kysely<VetraLicensingDB>,
  address: string,
  nowIso: string,
): Promise<Array<{ appId: string; kind: string }>> {
  const rows = await db
    .selectFrom("app_license_grants as g")
    .innerJoin("license_lifecycle as l", "l.license_id", "g.license_id")
    .select(["g.app_id as appId", "g.kind as kind", "l.status as status", "l.end_at as endAt"])
    .where("g.user_address", "=", address.toLowerCase())
    .execute();
  const seen = new Set<string>();
  const out: Array<{ appId: string; kind: string }> = [];
  for (const r of rows) {
    if (!r.kind || !isLiveEntry({ status: r.status, endAt: r.endAt }, nowIso)) continue;
    const key = `${r.appId}\0${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ appId: r.appId, kind: r.kind });
  }
  return out;
}
```

- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/holders.ts subgraphs/vetra-apps/__tests__/plans-holders.test.ts && git commit -m "feat(plans): read plan holders from licensing's records" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Plans API

**Files:**
- Create: `subgraphs/vetra-apps/plans/service.ts`
- Modify: `subgraphs/vetra-apps/releases/repo.ts` (`releaseByVersion`), `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Test: `subgraphs/vetra-apps/__tests__/plans-api.test.ts`

**Interfaces:**
- Produces (repo): `releaseByVersion(db, appId, version): Promise<ReleaseRow | null>`.
- Produces (service):
  - `PlanJson { id; appId; slug; name; kind; access; size; targetVersion; policy; noticeHours; status; createdAt; updatedAt }`;
  - `planJson(p: PlanRow): PlanJson`;
  - `appPlansFor(deps, caller, appId)`;
  - `CreatePlanInput { appId; kind; access; slug?; name?; size?; targetVersion? }`;
  - `createPlan(deps, caller, input)`;
  - `UpdatePlanInput { planId; name?; size? }`;
  - `updatePlanFor(deps, caller, input)`;
  - `setPlanTarget(deps, caller, planId, version)`;
  - `retirePlan(deps, caller, planId)`.
- Produces (GraphQL): type `AppPlan`, inputs `CreatePlanInput`/`UpdatePlanInput`, `Query.appPlans(appId: ID!): [AppPlan!]!`, `Mutation.createPlan`, `updatePlan`, `setPlanTarget(planId: ID!, version: String!)`, `retirePlan(planId: ID!)`.

- [ ] **Step 1: Write the failing test** `plans-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, stranger, type Harness } from "./harness.js";
import { seedLicence, seedLicensedEnvironment, seedRelease } from "./instances-fixtures.js";
import {
  appPlansFor,
  createPlan,
  retirePlan,
  setPlanTarget,
  updatePlanFor,
} from "../plans/service.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
  await seedRelease(h, appId, { version: "1.5.0-main.3", run: 101 });
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({ extensions: expect.objectContaining({ code: c }) });

describe("plans API", () => {
  it("creates a plan from a term kind with defaults, and lists it", async () => {
    const p = await createPlan(h.deps, owner, { appId, kind: "Pro", access: "OWN" });
    expect(p).toMatchObject({
      appId,
      slug: "pro",
      name: "Pro",
      kind: "Pro",
      access: "own",
      size: "VETRA_AGENT_S",
      targetVersion: null,
      policy: "manual",
      noticeHours: 72,
      status: "active",
    });
    expect((await appPlansFor(h.deps, owner, appId)).map((x) => x.id)).toEqual([p.id]);
  });

  it("is for the App's operators only", async () => {
    await expect(createPlan(h.deps, stranger, { appId, kind: "pro", access: "own" })).rejects.toMatchObject(
      code("FORBIDDEN"),
    );
  });

  it("refuses a kind that already has holders, a second plan for a kind, and reserved slugs", async () => {
    await seedLicence(h, { appId, kind: "early", holder: HOLDER, licenseId: "l1" });
    await expect(createPlan(h.deps, owner, { appId, kind: "early", access: "own" })).rejects.toMatchObject(
      code("BAD_USER_INPUT"),
    );
    await createPlan(h.deps, owner, { appId, kind: "pro", access: "own" });
    await expect(
      createPlan(h.deps, owner, { appId, kind: "pro", access: "shared", slug: "pro-2" }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(createPlan(h.deps, owner, { appId, kind: "x", access: "own", slug: "main" })).rejects.toMatchObject(
      code("BAD_USER_INPUT"),
    );
  });

  it("refuses an App that still has licensed environments (they move with the switch-over)", async () => {
    await seedLicensedEnvironment(h, { appId, root: "old" });
    await expect(createPlan(h.deps, owner, { appId, kind: "new", access: "own" })).rejects.toThrow(
      /switch-over/,
    );
  });

  it("targets releases only, changes size and name, and retires", async () => {
    const p = await createPlan(h.deps, owner, { appId, kind: "pro", access: "shared", targetVersion: "1.4.0" });
    expect(p.targetVersion).toBe("1.4.0");
    await expect(setPlanTarget(h.deps, owner, p.id, "1.5.0-main.3")).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(setPlanTarget(h.deps, owner, p.id, "9.9.9")).rejects.toMatchObject(code("BAD_USER_INPUT"));
    expect(await updatePlanFor(h.deps, owner, { planId: p.id, size: "VETRA_AGENT_L", name: "Pro+" })).toMatchObject({
      size: "VETRA_AGENT_L",
      name: "Pro+",
    });
    expect((await retirePlan(h.deps, owner, p.id)).status).toBe("retired");
    await expect(setPlanTarget(h.deps, owner, p.id, "1.4.0")).rejects.toMatchObject(code("BAD_USER_INPUT"));
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/plans-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: `releaseByVersion`.** Append to `releases/repo.ts`:

```ts
export async function releaseByVersion(
  db: Kysely<VetraAppsDB>,
  appId: string,
  version: string,
): Promise<ReleaseRow | null> {
  const r = await db
    .selectFrom("releases")
    .selectAll()
    .where("app_id", "=", appId)
    .where("version", "=", version)
    .executeTakeFirst();
  return r ? normalize(r) : null;
}
```

- [ ] **Step 4: Service.** Create `plans/service.ts`:

```ts
import type { Caller } from "../auth.js";
import { appsError, notConfigured } from "../errors.js";
import { releaseByVersion } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { hasLicensedEnvironments, liveChains } from "./holders.js";
import { getPlan, insertPlan, listPlans, updatePlan, type PlanRow } from "./repo.js";
import { checkPlanSlug, parseAccess, parseSize, slugFromKind } from "./rules.js";

export interface PlanJson {
  id: string;
  appId: string;
  slug: string;
  name: string;
  kind: string;
  access: string;
  size: string;
  targetVersion: string | null;
  policy: string;
  noticeHours: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const planJson = (p: PlanRow): PlanJson => ({
  id: p.id,
  appId: p.app_id,
  slug: p.slug,
  name: p.name,
  kind: p.kind,
  access: p.access,
  size: p.size,
  targetVersion: p.target_version,
  policy: p.policy,
  noticeHours: p.notice_hours,
  status: p.status,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export interface CreatePlanInput {
  appId: string;
  kind: string;
  access: string;
  slug?: string | null;
  name?: string | null;
  size?: string | null;
  targetVersion?: string | null;
}

export interface UpdatePlanInput {
  planId: string;
  name?: string | null;
  size?: string | null;
}

/** A plan's target is a recorded release of its App, never a build (spec section 2). */
async function checkTarget(deps: AppsDeps, appId: string, version: string): Promise<string> {
  const r = await releaseByVersion(deps.db, appId, version);
  if (!r) throw appsError("BAD_USER_INPUT", `The App has no release ${version}`);
  if (r.kind !== "release")
    throw appsError("BAD_USER_INPUT", `${version} is a build; a plan targets releases only`);
  return r.version;
}

async function loadPlan(deps: AppsDeps, caller: Caller, planId: string) {
  const plan = await getPlan(deps.db, planId);
  if (!plan) throw appsError("NOT_FOUND", "Plan not found");
  // Throws NOT_FOUND / FORBIDDEN as for the App itself.
  const app = await loadAppForOwner(deps, caller, plan.app_id);
  return { plan, app };
}

export async function appPlansFor(deps: AppsDeps, caller: Caller, appId: string): Promise<PlanJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  return (await listPlans(deps.db, app.id)).map(planJson);
}

export async function createPlan(deps: AppsDeps, caller: Caller, input: CreatePlanInput): Promise<PlanJson> {
  const app = await loadAppForOwner(deps, caller, input.appId);
  if (!deps.licensingDb) throw notConfigured("The licensing tables");
  const kind = input.kind.trim();
  if (!kind) throw appsError("BAD_USER_INPUT", "A plan adopts a licensing term: give its kind");
  const access = parseAccess(input.access);
  const size = parseSize(input.size);
  const slug = (input.slug ?? slugFromKind(kind)).trim();
  checkPlanSlug(slug, app);
  if (await hasLicensedEnvironments(deps.licensingDb, app.id))
    throw appsError(
      "BAD_USER_INPUT",
      "This App's licensed environments move to plans with the switch-over (releases phase 3, slice 9); it cannot have plans before that",
    );
  const nowIso = deps.now().toISOString();
  // A kind with holders is a migration, not a new plan (slice 9). Licences of unknown kind count.
  const holders = [...(await liveChains(deps.licensingDb, app.id, nowIso)).values()];
  if (holders.some((c) => c.kind === kind || c.kind === null))
    throw appsError(
      "BAD_USER_INPUT",
      `The term ${kind} already has holders (or the App has licences of unknown kind); it becomes a plan with the switch-over`,
    );
  const existing = await listPlans(deps.db, app.id);
  if (existing.some((p) => p.kind === kind))
    throw appsError("BAD_USER_INPUT", `The term ${kind} is already a plan`);
  if (existing.some((p) => p.slug === slug))
    throw appsError("BAD_USER_INPUT", `The App already has a plan called ${slug}`);
  const target = input.targetVersion ? await checkTarget(deps, app.id, input.targetVersion) : null;
  const row = await insertPlan(deps.db, {
    id: deps.newId(),
    app_id: app.id,
    slug,
    name: input.name?.trim() || kind,
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
  return planJson(row);
}

export async function updatePlanFor(deps: AppsDeps, caller: Caller, input: UpdatePlanInput): Promise<PlanJson> {
  const { plan } = await loadPlan(deps, caller, input.planId);
  const name = input.name?.trim();
  return planJson(
    await updatePlan(
      deps.db,
      plan.id,
      {
        ...(name ? { name } : {}),
        ...(input.size ? { size: parseSize(input.size) } : {}),
      },
      deps.now().toISOString(),
    ),
  );
}

/**
 * Moves the plan's instances to `version` on the next reconciler pass, without
 * notice. The stand-in for rollouts (releases phase 3 slice 3), which replace it.
 */
export async function setPlanTarget(deps: AppsDeps, caller: Caller, planId: string, version: string): Promise<PlanJson> {
  const { plan } = await loadPlan(deps, caller, planId);
  if (plan.status === "retired") throw appsError("BAD_USER_INPUT", "The plan is retired");
  const target = await checkTarget(deps, plan.app_id, version);
  return planJson(await updatePlan(deps.db, plan.id, { target_version: target }, deps.now().toISOString()));
}

/** No new licences should be issued for it (retire the term too); existing holders keep their instances. */
export async function retirePlan(deps: AppsDeps, caller: Caller, planId: string): Promise<PlanJson> {
  const { plan } = await loadPlan(deps, caller, planId);
  if (plan.status === "retired") return planJson(plan);
  return planJson(await updatePlan(deps.db, plan.id, { status: "retired" }, deps.now().toISOString()));
}
```

- [ ] **Step 5: GraphQL.** In `schema.ts`, after `type AppInstance {…}`:

```graphql
  "What holders of one licensing term get (spec: releases and instances, section 7). The plan adopted the term by its kind."
  type AppPlan {
    id: ID!
    appId: ID!
    slug: String!
    name: String!
    kind: String!
    "shared | own"
    access: String!
    "VETRA_AGENT_S … VETRA_AGENT_XXL"
    size: String!
    targetVersion: String
    "manual (rollouts arrive later)"
    policy: String!
    noticeHours: Int!
    "active | retired"
    status: String!
    createdAt: String!
    updatedAt: String!
  }

  input CreatePlanInput {
    appId: ID!
    "The licensing term's kind; it must have no holders yet"
    kind: String!
    "shared | own"
    access: String!
    slug: String
    name: String
    size: String
    "A recorded release of the App"
    targetVersion: String
  }

  input UpdatePlanInput {
    planId: ID!
    name: String
    size: String
  }
```

In `type Query`, after `appSettings(…)`: `appPlans(appId: ID!): [AppPlan!]!`. In `type Mutation`, after `deleteAppSetting(…)`:

```graphql
    "Turn a licensing term into a plan (shared or own instances)"
    createPlan(input: CreatePlanInput!): AppPlan!
    updatePlan(input: UpdatePlanInput!): AppPlan!
    "Move the plan's instances to a release at once (no notice; replaced by rollouts)"
    setPlanTarget(planId: ID!, version: String!): AppPlan!
    retirePlan(planId: ID!): AppPlan!
```

In `resolvers.ts`, import `{ appPlansFor, createPlan, retirePlan, setPlanTarget, updatePlanFor, type CreatePlanInput, type UpdatePlanInput } from "./plans/service.js"`. In `Query`, after `appSettings`:

```ts
      appPlans: (_: unknown, { appId }: { appId: string }, ctx: AppsContext) =>
        guard(deps, "appPlans", () => appPlansFor(deps, requireCaller(ctx), appId)),
```

In `Mutation`, after `deleteAppSetting`:

```ts
      createPlan: (_: unknown, { input }: { input: CreatePlanInput }, ctx: AppsContext) =>
        guard(deps, "createPlan", () => createPlan(deps, requireCaller(ctx), input)),
      updatePlan: (_: unknown, { input }: { input: UpdatePlanInput }, ctx: AppsContext) =>
        guard(deps, "updatePlan", () => updatePlanFor(deps, requireCaller(ctx), input)),
      setPlanTarget: (
        _: unknown,
        { planId, version }: { planId: string; version: string },
        ctx: AppsContext,
      ) => guard(deps, "setPlanTarget", () => setPlanTarget(deps, requireCaller(ctx), planId, version)),
      retirePlan: (_: unknown, { planId }: { planId: string }, ctx: AppsContext) =>
        guard(deps, "retirePlan", () => retirePlan(deps, requireCaller(ctx), planId)),
```

- [ ] **Step 6: Run it.** Same command as Step 2, plus `npx vitest run subgraphs/vetra-apps/__tests__/subgraph.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` (schema composition). Expected: PASS.
- [ ] **Step 7: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(plans): plans API (create from a term, target, size, retire)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: Host labels for plan instances

**Files:**
- Modify: `subgraphs/vetra-apps/instances/host.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-plan-host.test.ts`

**Interfaces:**
- Changes: `instanceLabel(appId, slug, branch, suffix = "", identity = branch)`. The 6-hex hash is `instanceHash(appId, identity)`, so existing labels are unchanged.
- Produces: `planInstanceLabel(app: { id: string; slug: string }, row: { id: string; kind: string; name: string; licence_root_id?: string | null }, suffix: string): string`.

- [ ] **Step 1: Write the failing test** `instances-plan-host.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { instanceLabel, MAX_INSTANCE_LABEL, planInstanceLabel } from "../instances/host.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";

const app = { id: "app-1", slug: "sektar" };

describe("plan instance hosts", () => {
  it("keeps branch labels as they were", () => {
    expect(instanceLabel("app-1", "sektar", "main", "-stg", "main")).toBe(
      instanceLabel("app-1", "sektar", "main", "-stg"),
    );
  });
  it("never gives a shared plan the label of a branch with the same name", () => {
    const shared = planInstanceLabel(app, { id: "i1", kind: "shared", name: "starter" }, "");
    expect(shared.startsWith("sektar-starter-")).toBe(true);
    expect(shared).not.toBe(instanceLabel("app-1", "sektar", "starter"));
  });
  it("gives an own instance a generated name with the suffix, else a hashed fallback", () => {
    const id = "3f2a9c1e-0000-4000-8000-000000000000";
    const own = planInstanceLabel(app, { id, kind: "own", name: "own-x", licence_root_id: "root-1" }, "-stg");
    const generated = `${generateSubdomain(id)}-stg`;
    expect(own).toBe(generated.length <= MAX_INSTANCE_LABEL ? generated : own);
    expect(own.length).toBeLessThanOrEqual(MAX_INSTANCE_LABEL);
    const tight = planInstanceLabel(app, { id, kind: "own", name: "own-x", licence_root_id: "root-1" }, "-abcdefg");
    expect(tight.length).toBeLessThanOrEqual(MAX_INSTANCE_LABEL);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-plan-host.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`planInstanceLabel` not exported).
- [ ] **Step 3: Implement.** In `host.ts`:
  - add `import { generateSubdomain } from "../../../shared/subdomain-generator.js";`;
  - change `instanceLabel`'s signature to `(appId: string, slug: string, branch: string, suffix = "", identity = branch)` and its last line to `return [s, b, instanceHash(appId, identity)].filter(Boolean).join("-") + suffix;`;
  - add to its doc comment: "`identity` (default: the branch) feeds the hash: plan instances pass `plan:<slug>` / `own:<root>` so they never share a branch's label";
  - append:

```ts
/**
 * The host label of a plan instance (releases phase 3). Shared: the plan's
 * slug, hashed as `plan:<slug>`. Own: a generated name (spec section 5:
 * `calm-bat-b4qzzqbb`) when it fits with the suffix, else `<slug>-own-<h>`
 * hashed on the licence chain.
 */
export function planInstanceLabel(
  app: { id: string; slug: string },
  row: { id: string; kind: string; name: string; licence_root_id?: string | null },
  suffix: string,
): string {
  if (row.kind === "shared")
    return instanceLabel(app.id, app.slug, row.name, suffix, `plan:${row.name}`);
  const generated = `${generateSubdomain(row.id)}${suffix}`;
  if (generated.length <= MAX_INSTANCE_LABEL) return generated;
  return instanceLabel(app.id, app.slug, "own", suffix, `own:${row.licence_root_id ?? row.id}`);
}
```

- [ ] **Step 4: Run it.** Same command plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-host.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/host.ts subgraphs/vetra-apps/__tests__/instances-plan-host.test.ts && git commit -m "feat(instances): host labels for shared and own instances" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Render plan instances (role `PLAN`, size)

**Files:**
- Modify: `subgraphs/vetra-apps/instances/render.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-plan-render.test.ts`

**Interfaces:**
- Changes:
  - `CreateInstanceInput.gitRef: string | null`;
  - new optional `CreateInstanceInput.role?: "PREVIEW" | "PLAN"` (default PREVIEW) and `size?: VetraCloudRessourceSize | null`;
  - `instanceUpdateActions(state, image, admins, settings, start = true, size: VetraCloudRessourceSize | null = null)` accepts `PREVIEW` and `PLAN` documents.
- Produces: `isInstanceRole(state: VetraCloudEnvironmentState): boolean` (`PREVIEW` or `PLAN`).

- [ ] **Step 1: Write the failing test** `instances-plan-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeEnvs } from "./harness.js";
import { instanceCreateActions, instanceUpdateActions } from "../instances/render.js";

const settings = { revision: "r1", plain: [], secretNames: [] };
const image = { repository: "cr.vetra.io/acme/shop", tag: "1.4.0@sha256:" + "b".repeat(64), phHost: "cli" };
const HOLDER = "0x1111111111111111111111111111111111111111";
const SERVICE = "0x9999999999999999999999999999999999999999";

async function planDoc(envs: FakeEnvs) {
  const id = await envs.create();
  await envs.execute(
    id,
    instanceCreateActions({
      label: "Shop · own-1",
      host: "calm-bat-12345678",
      baseDomain: "vetra.io",
      registry: "https://registry.vetra.io",
      owner: SERVICE,
      ownerOrgId: null,
      appId: "app-1",
      gitRef: null,
      imageProject: "acme",
      image,
      admins: HOLDER,
      settings,
      start: true,
      role: "PLAN",
      size: "VETRA_AGENT_M",
    }),
  );
  return id;
}

describe("plan instance documents", () => {
  it("are linked as PLAN, owned by the service, sized by the plan, with the holder as ADMINS", async () => {
    const envs = new FakeEnvs();
    const state = (await envs.getState(await planDoc(envs)))!;
    expect(state.app).toMatchObject({ appId: "app-1", role: "PLAN", gitRef: null });
    expect(state.owner).toBe(SERVICE);
    const fusion = state.services.find((s) => s.type === "FUSION")!;
    expect(fusion.selectedRessource).toBe("VETRA_AGENT_M");
    expect(fusion.version).toBe(image.tag);
    expect(state.fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(HOLDER);
  });

  it("are updated (size included) like any instance, and nothing else is", async () => {
    const envs = new FakeEnvs();
    const id = await planDoc(envs);
    const state = (await envs.getState(id))!;
    expect(instanceUpdateActions(state, image, HOLDER, settings, true, "VETRA_AGENT_M")).toEqual([]);
    const resize = instanceUpdateActions(state, image, HOLDER, settings, true, "VETRA_AGENT_L");
    expect(resize.map((a) => a.type)).toEqual(["SET_SERVICE_SIZE"]);
    const other = await envs.seedStandalone();
    await envs.link(other, "app-1", "PRODUCTION");
    expect(() => instanceUpdateActions((await envs.getState(other))!, image, HOLDER, settings)).toThrow(
      /not an instance/,
    );
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-plan-render.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (TypeScript or runtime: `role` ignored, link is PREVIEW).
- [ ] **Step 3: Implement** in `render.ts`:
  - add `setServiceSize` to the creators import;
  - add `type VetraCloudRessourceSize` to the type import from `document-models/vetra-cloud-environment/index.js`.

In `CreateInstanceInput` change `gitRef: string;` to `gitRef: string | null;` and add:

```ts
  /** PREVIEW: branch/preview instances (slim profile). PLAN: shared/own instances (full profile: kept /data, backups). */
  role?: "PREVIEW" | "PLAN";
  /** The plan's FUSION size; null/absent: the processor's default (previews always run S). */
  size?: VetraCloudRessourceSize | null;
```

In `instanceCreateActions`, replace `role: "PREVIEW",` with `role: i.role ?? "PREVIEW",` and, right after `enableService({ type: "FUSION", prefix: "fusion" }),`, insert `...(i.size ? [setServiceSize({ prefix: "fusion", size: i.size })] : []),`. Update the function's doc comment: "Linked as the App's PREVIEW (branch, preview) or PLAN (shared, own)."

Add, before `instanceUpdateActions`:

```ts
/** A document the reconciler made: a branch/preview instance (PREVIEW) or a plan's instance (PLAN). */
export const isInstanceRole = (state: VetraCloudEnvironmentState) =>
  state.app?.role === "PREVIEW" || state.app?.role === "PLAN";
```

In `instanceUpdateActions`:
  - add the parameter `size: VetraCloudRessourceSize | null = null` after `start = true`;
  - replace `if (state.app?.role !== "PREVIEW")` with `if (!isInstanceRole(state))`, and its message with `` `Environment ${envName(state)} is not an instance (not an app PREVIEW or PLAN)` ``;
  - after the `setFusionConfig` block, add:

```ts
  if (size && fusion?.selectedRessource !== size)
    changes.push(setServiceSize({ prefix: "fusion", size }));
```

- [ ] **Step 4: Run it.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-render.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS (existing callers pass a string `gitRef` and no role).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/render.ts subgraphs/vetra-apps/__tests__/instances-plan-render.test.ts && git commit -m "feat(instances): render plan instances (PLAN role, plan size)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: `syncPlanInstances`

**Files:**
- Create: `subgraphs/vetra-apps/plans/sync.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-plans.test.ts` (sync part; Task 10 adds the reconcile part)

**Interfaces:**
- Produces:
  - `isPlanKind(kind: string): boolean` (`shared` | `own`);
  - `ownInstanceName(root: string): string` (`own-<12 hex of sha256(root)>`);
  - `LICENCE_ENDED = "the licence ended"`, `PLAN_RETIRED = "the plan is retired and has no live licences"`;
  - `syncPlanInstances(deps: AppsDeps, app: AppRow): Promise<void>`. Rows only, no environment writes, and nothing deleted. The caller decides whether it runs (switch, `wantsInstances`).

- [ ] **Step 1: Write the failing test** `instances-plans.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, OWNER, seedActiveApp, testConfig, type Harness } from "./harness.js";
import { digest, seedLicence, seedLicensedEnvironment, seedRelease } from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { insertPlan, updatePlan } from "../plans/repo.js";
import { LICENCE_ENDED, ownInstanceName, PLAN_RETIRED, syncPlanInstances } from "../plans/sync.js";
import { getApp } from "../repo.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const DAY = 86_400_000;
let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness(testConfig({ plans: { enabled: true, stopAfterDays: 14 } }));
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release", digest: digest("b") });
});
afterEach(async () => {
  await h.close();
});

const plan = (over: Partial<Parameters<typeof insertPlan>[1]> = {}) =>
  insertPlan(h.db, {
    id: "plan-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  });
const sync = async () => syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
const rows = () => listInstances(h.db, appId);

describe("syncPlanInstances", () => {
  it("gives each live chain of an own plan one row, on the plan's target and size", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await seedLicence(h, { appId, kind: "other", holder: HOLDER, licenseId: "l2" });
    await sync();
    await sync(); // idempotent
    expect(await rows()).toEqual([
      expect.objectContaining({
        kind: "own",
        name: ownInstanceName("l1"),
        plan_id: "plan-own",
        holder_address: HOLDER,
        licence_root_id: "l1",
        target_version: "1.4.0",
        target_digest: digest("b"),
        target_size: "VETRA_AGENT_M",
        status: "pending",
        stop_reason: null,
      }),
    ]);
  });

  it("makes no row without a target, and none for a chain with a licensed environment", async () => {
    await plan({ target_version: null });
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await sync();
    expect(await rows()).toEqual([]);
    await updatePlan(h.db, "plan-own", { target_version: "1.4.0" }, "2026-10-02T00:00:00.000Z");
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await sync();
    expect(await rows()).toEqual([]);
  });

  it("marks an own row to stop stopAfterDays after its licence ended, and clears it when live again", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await sync();
    await h.deps.licensingDb!.updateTable("license_lifecycle").set({ status: "EXPIRED" }).where("license_id", "=", "l1").execute();
    await sync();
    const ended = (await rows())[0];
    expect(ended.licence_ended_at).not.toBeNull();
    expect(ended.stop_reason).toBeNull();
    h.advance(15 * DAY);
    await sync();
    expect((await rows())[0].stop_reason).toBe(LICENCE_ENDED);
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1b", root: "l1" });
    await sync();
    expect((await rows())[0]).toMatchObject({ stop_reason: null, licence_ended_at: null });
  });

  it("gives a shared plan one row while active or with live licences, else marks it to stop", async () => {
    await plan({ id: "plan-shared", slug: "starter", kind: "starter", access: "shared" });
    await sync();
    expect(await rows()).toEqual([
      expect.objectContaining({ kind: "shared", name: "starter", plan_id: "plan-shared", holder_address: null }),
    ]);
    await seedLicence(h, { appId, kind: "starter", holder: HOLDER, licenseId: "l1" });
    await updatePlan(h.db, "plan-shared", { status: "retired" }, "2026-10-03T00:00:00.000Z");
    await sync();
    expect((await rows())[0].stop_reason).toBeNull();
    await h.deps.licensingDb!.updateTable("license_lifecycle").set({ status: "REVOKED" }).where("license_id", "=", "l1").execute();
    await sync();
    expect((await rows())[0].stop_reason).toBe(PLAN_RETIRED);
  });

  it("follows a new plan target", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await sync();
    await seedRelease(h, appId, { version: "1.4.1", run: 110, kind: "release", digest: digest("c") });
    await updatePlan(h.db, "plan-own", { target_version: "1.4.1" }, "2026-10-04T00:00:00.000Z");
    await sync();
    expect((await rows())[0]).toMatchObject({ target_version: "1.4.1", target_digest: digest("c") });
  });
});
```

(`h.deps.licensingDb` is the same PGlite database, typed for licensing's tables.)

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `plans/sync.ts`:

```ts
import { createHash } from "node:crypto";
import { plansConfigOf } from "../config.js";
import type { InstanceKind } from "../db/schema.js";
import type { AppRow } from "../repo.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppsDeps } from "../service.js";
import {
  insertInstance,
  listInstances,
  updateInstance,
  type InstancePatch,
  type InstanceRow,
} from "../instances/repo.js";
import { targetOf, type InstanceTarget } from "../instances/targets.js";
import { licensedRoots, liveChains, type ChainHead } from "./holders.js";
import { listPlans, type PlanRow } from "./repo.js";

export const LICENCE_ENDED = "the licence ended";
export const PLAN_RETIRED = "the plan is retired and has no live licences";
const DAY_MS = 86_400_000;

export const isPlanKind = (kind: InstanceKind | string) => kind === "shared" || kind === "own";

/** Stable per licence chain, holder-neutral (it appears in labels and logs). */
export const ownInstanceName = (root: string) =>
  `own-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;

async function planTarget(deps: AppsDeps, plan: PlanRow): Promise<InstanceTarget | null> {
  if (!plan.target_version) return null;
  const r = await releaseByVersion(deps.db, plan.app_id, plan.target_version);
  if (!r || r.kind !== "release") return null;
  try {
    return targetOf(r);
  } catch (err) {
    deps.logger.warn(`[vetra-apps] plan ${plan.slug}: ${String(err)}`);
    return null;
  }
}

const changed = (row: InstanceRow, p: InstancePatch) =>
  Object.entries(p).some(([k, v]) => (row as unknown as Record<string, unknown>)[k] !== v);

function newRow(
  deps: AppsDeps,
  app: AppRow,
  plan: PlanRow,
  target: InstanceTarget,
  nowIso: string,
  own: ChainHead | null,
) {
  return {
    id: deps.newId(),
    app_id: app.id,
    kind: own ? ("own" as const) : ("shared" as const),
    name: own ? ownInstanceName(own.root) : plan.slug,
    branch: null,
    pr: null,
    host: null,
    environment_id: null,
    ...target,
    running_version: null,
    running_digest: null,
    running_repository: null,
    status: "pending" as const,
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: plan.id,
    holder_address: own?.address ?? null,
    licence_root_id: own?.root ?? null,
    licence_ended_at: null,
    stop_reason: null,
    stopped_by_vetra: false,
    target_size: plan.size,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Rows for the App's plan instances (spec section 5): one shared row per shared
 * plan while it is active or has live licences; one own row per live licence
 * chain of an own plan, unless the old model runs a licensed environment for
 * that chain (overview rule 1). Ended chains and retired, unheld shared plans
 * get a stop_reason; nothing is ever deleted here.
 */
export async function syncPlanInstances(deps: AppsDeps, app: AppRow): Promise<void> {
  if (!deps.licensingDb) return;
  const cfg = plansConfigOf(deps.cfg);
  const plans = await listPlans(deps.db, app.id);
  const shared = await listInstances(deps.db, app.id, "shared");
  const own = await listInstances(deps.db, app.id, "own");
  if (plans.length === 0 && shared.length === 0 && own.length === 0) return;
  const nowIso = deps.now().toISOString();
  const live = await liveChains(deps.licensingDb, app.id, nowIso);
  const licensed = await licensedRoots(deps.licensingDb, app.id);
  const targets = new Map<string, InstanceTarget | null>();
  for (const p of plans) targets.set(p.id, await planTarget(deps, p));
  const patch = (row: InstanceRow, p: InstancePatch) =>
    changed(row, p) ? updateInstance(deps.db, row.id, p, nowIso) : Promise.resolve(row);

  for (const plan of plans.filter((p) => p.access === "shared")) {
    const target = targets.get(plan.id) ?? null;
    const held = [...live.values()].some((c) => c.kind === plan.kind);
    const wanted = plan.status === "active" || held;
    const row = shared.find((r) => r.plan_id === plan.id);
    if (!row) {
      if (wanted && target) await insertInstance(deps.db, newRow(deps, app, plan, target, nowIso, null));
      continue;
    }
    await patch(row, {
      ...(target ?? {}),
      target_size: plan.size,
      stop_reason: wanted ? null : PLAN_RETIRED,
    });
  }

  const ownPlans = new Map(plans.filter((p) => p.access === "own").map((p) => [p.kind, p]));
  const served = new Set<string>();
  for (const head of live.values()) {
    const plan = head.kind ? ownPlans.get(head.kind) : undefined;
    if (!plan || licensed.has(head.root)) continue;
    const target = targets.get(plan.id) ?? null;
    const row = own.find((r) => r.licence_root_id === head.root);
    if (!row) {
      if (target) {
        await insertInstance(deps.db, newRow(deps, app, plan, target, nowIso, head));
        served.add(head.root);
      }
      continue;
    }
    served.add(head.root);
    await patch(row, {
      ...(target ?? {}),
      plan_id: plan.id,
      holder_address: head.address,
      target_size: plan.size,
      licence_ended_at: null,
      stop_reason: null,
    });
  }
  const stopAfterMs = cfg.stopAfterDays * DAY_MS;
  for (const row of own) {
    if (served.has(row.licence_root_id ?? "")) continue;
    const ended = row.licence_ended_at ?? nowIso;
    const due = deps.now().getTime() - Date.parse(ended) >= stopAfterMs;
    await patch(row, { licence_ended_at: ended, stop_reason: due ? LICENCE_ENDED : null });
  }
}
```

- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/sync.ts subgraphs/vetra-apps/__tests__/instances-plans.test.ts && git commit -m "feat(plans): sync shared and own instance rows from plans and licences" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 10: The reconciler runs plan instances

**Files:**
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-plans.test.ts` (append)

**Interfaces:**
- Changes:
  - `reconcileApp` runs `syncPlanInstances` (switch on and `wantsInstances(app)`), and skips `shared`/`own` rows while the switch is off.
  - `reconcileInstance` sends a row with `stop_reason` to `stopPlanInstance`.
  - `reconcileEnvironment` wakes a Vetra-stopped environment, uses `adminsOf(app, row)` and `row.target_size`, and approves pending `PLAN` changes.
  - `claimHost` uses `planInstanceLabel` for plan kinds.
  - `createEnvironment`/`initEnvironment` give plan kinds role `PLAN`, the service owner, no organisation, no `gitRef`, the size, and `ADMINS` per kind.
  - `removeInstance` throws for plan kinds.
- Produces: `adminsOf(app: AppRow, row: InstanceRow): string` (exported for tests).

- [ ] **Step 1: Write the failing tests** (append to `instances-plans.test.ts`; add `import { reconcileInstancesOnce } from "../instances/reconciler.js";`):

```ts
const SERVICE = "0x9999999999999999999999999999999999999999";

describe("reconcileInstancesOnce — plan instances", () => {
  beforeEach(() => {
    h.deps.serviceOwner = SERVICE;
  });
  const env = async () => (await h.envs.getState((await rows())[0].environment_id!))!;

  it("creates an own instance as a PLAN environment owned by Vetra, sized, with the holder as admin, then ready", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await reconcileInstancesOnce(h.deps);
    const state = await env();
    expect(state.app).toMatchObject({ appId, role: "PLAN", gitRef: null });
    expect(state.owner).toBe(SERVICE);
    expect(state.ownerOrgId ?? null).toBeNull();
    expect(state.services.find((s) => s.type === "FUSION")).toMatchObject({
      selectedRessource: "VETRA_AGENT_M",
      version: `1.4.0@${digest("b")}`,
    });
    expect(state.fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(HOLDER);
    h.envs.setStatus((await rows())[0].environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await rows())[0]).toMatchObject({ status: "ready", running_version: "1.4.0" });
  });

  it("gives a shared instance the App owner as admin", async () => {
    await plan({ id: "plan-shared", slug: "starter", kind: "starter", access: "shared" });
    await reconcileInstancesOnce(h.deps);
    expect((await env()).fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(OWNER);
  });

  it("does nothing for plans while VETRA_APPS_PLANS is off", async () => {
    await h.close();
    h = await makeHarness(testConfig());
    appId = (await seedActiveApp(h)).id;
    await h.db.updateTable("apps").set({ instances_enabled: true, registry_namespace: "acme" }).where("id", "=", appId).execute();
    await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release", digest: digest("b") });
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await reconcileInstancesOnce(h.deps);
    expect(await rows()).toEqual([]);
  });

  it("stops an ended licence's instance after the window and wakes it on renewal", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await reconcileInstancesOnce(h.deps);
    const envId = (await rows())[0].environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    await h.deps.licensingDb!.updateTable("license_lifecycle").set({ status: "EXPIRED" }).where("license_id", "=", "l1").execute();
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("READY");
    h.advance(15 * DAY);
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("STOPPED");
    expect((await rows())[0]).toMatchObject({ status: "stopped", reason: LICENCE_ENDED, stopped_by_vetra: true });
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1b", root: "l1" });
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).not.toBe("STOPPED");
    expect((await rows())[0]).toMatchObject({ status: "updating", stopped_by_vetra: false });
  });

  it("never touches a licensed environment's chain, nor deletes a plan instance", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    const before = h.envs.docs.size;
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.docs.size).toBe(before);
    expect(h.envs.deleted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: the new `describe` fails (no plan rows reconciled).
- [ ] **Step 3: Implement** in `reconciler.ts`:

Imports:
  - add `sleepEnvironment` and `wakeEnvironment` from `"../../../document-models/vetra-cloud-environment/v1/gen/creators.js"`, next to `approveChanges`;
  - add `import { vetraServiceAddress } from "../../vetra-cloud-observability/env-protection.js";`;
  - add `import { plansConfigOf } from "../config.js";` next to `instanceHealth`;
  - add `import { isPlanKind, syncPlanInstances } from "../plans/sync.js";`;
  - change `import { instanceLabel } from "./host.js";` to `import { instanceLabel, planInstanceLabel } from "./host.js";`;
  - add `isInstanceRole` to the `./render.js` import.

Helpers, after `const patch = …`:

```ts
/** ADMINS per kind (spec section 5): the holder of an own instance, else the App owner. */
export function adminsOf(app: AppRow, row: InstanceRow): string {
  return row.kind === "own" && row.holder_address ? row.holder_address : app.owner_address;
}

const sizeOf = (row: InstanceRow) =>
  (row.target_size ?? null) as Parameters<typeof instanceUpdateActions>[5];

/**
 * A plan instance Vetra wants stopped (licence ended, plan retired): its
 * environment sleeps once it is READY or failed; nothing is deleted.
 */
async function stopPlanInstance(deps: AppsDeps, row: InstanceRow): Promise<void> {
  const reason = row.stop_reason!;
  if (!row.environment_id) {
    if (row.status !== "stopped" || row.reason !== reason)
      await patch(deps, row, { status: "stopped", reason });
    return;
  }
  const envId = row.environment_id;
  await withEnvLock(envId, async () => {
    const state = await deps.envs.getState(envId);
    if (!state || !ours(state, row)) return;
    if (state.status === "READY" || state.status === "DEPLOYMENt_FAILED") {
      await deps.envs.execute(envId, [sleepEnvironment({})]);
      await patch(deps, row, { status: "stopped", reason, stopped_by_vetra: true });
      return;
    }
    if (state.status === "STOPPED") {
      if (row.status !== "stopped" || row.reason !== reason)
        await patch(deps, row, { status: "stopped", reason });
      return;
    }
    const waiting = `${reason}: stopped once the environment settles (${state.status})`;
    if (row.reason !== waiting) await patch(deps, row, { reason: waiting });
  });
}
```

`reconcileApp`: after `await syncPreviewInstances(deps, app);` insert:

```ts
  const plans = plansConfigOf(deps.cfg);
  if (plans.enabled && wantsInstances(app)) {
    try {
      await syncPlanInstances(deps, app);
    } catch (err) {
      // Licensing's tables may not exist yet (boot order); branch and preview instances go on.
      deps.logger.warn(`[vetra-apps] plan instances of ${app.slug}: ${message(err)}`);
    }
  }
```

and, as the first statement inside `for (const row of rows) {`: `if (isPlanKind(row.kind) && !plans.enabled) continue;`.

`reconcileInstance`: right after the `if (row.removed_at) return …;` statement, insert `if (row.stop_reason) return stopPlanInstance(deps, row);`.

`reconcileEnvironment`:
  - replace `if (state.status === "CHANGES_PENDING" && state.app?.role === "PREVIEW") {` with `if (state.status === "CHANGES_PENDING" && isInstanceRole(state)) {`;
  - right after that block (before `if (!declaresVetraSecrets(state))`), insert:

```ts
  if (state.status === "STOPPED" && row.stopped_by_vetra) {
    // Stopped by Vetra (licence ended, plan retired) and wanted again.
    await apply(deps, envId, [wakeEnvironment({})]);
    await patch(deps, row, {
      status: "updating",
      reason: "waking up",
      stopped_by_vetra: false,
      update_started_at: deps.now().toISOString(),
    });
    return;
  }
  const admins = adminsOf(app, row);
  const size = sizeOf(row);
```

  - Replace the three `instanceUpdateActions(` calls in this function as follows:
    - first revert (in `if (failedOn(…))`): `instanceUpdateActions(state, back, admins, want, true, size)`;
    - the update: `instanceUpdateActions(state, image, admins, want, start, size)`;
    - the revert after a failure: `instanceUpdateActions(state, back, admins, want, true, size)`.

`claimHost`: replace the `const host = instanceLabel(…);` statement with:

```ts
  const host = isPlanKind(row.kind)
    ? planInstanceLabel(app, row, deps.cfg.instances.labelSuffix)
    : instanceLabel(app.id, app.slug, row.name, deps.cfg.instances.labelSuffix);
```

`createEnvironment`: change `if (app.owner_org_id && !deps.orgHandoverDb)` to `if (app.owner_org_id && !deps.orgHandoverDb && !isPlanKind(row.kind))`.

`initEnvironment`:
  - change `if (app.owner_org_id)` to `if (app.owner_org_id && !isPlanKind(row.kind))`;
  - replace the `instanceCreateActions({…})` argument with:

```ts
      instanceCreateActions({
        label: `${app.name} · ${row.name}`,
        host,
        baseDomain: INSTANCE_BASE_DOMAIN,
        registry: isPlanKind(row.kind)
          ? deps.cfg.productionRegistry
          : deps.cfg.previewRegistry,
        // Plan instances: no person owns the document (overview D2, spec 14.5).
        owner: isPlanKind(row.kind)
          ? (deps.serviceOwner ?? vetraServiceAddress())
          : app.owner_address,
        ownerOrgId: isPlanKind(row.kind) ? null : app.owner_org_id,
        appId: app.id,
        gitRef: isPlanKind(row.kind)
          ? null
          : row.kind === "preview"
            ? `refs/pull/${row.pr}/head`
            : `refs/heads/${row.branch}`,
        prNumber: row.kind === "preview" ? row.pr : null,
        imageProject: app.registry_namespace!,
        image,
        admins: adminsOf(app, row),
        settings: envSettings(settings),
        // Started by reconcileEnvironment once its tenant has the secrets.
        start: false,
        role: isPlanKind(row.kind) ? "PLAN" : "PREVIEW",
        size: sizeOf(row),
      }),
```


`removeInstance`: insert as its first statement:

```ts
  if (isPlanKind(row.kind))
    throw new Error(
      "plan instances are never removed by the reconciler (releases phase 3: stopped, not deleted)",
    );
```

- [ ] **Step 4: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts subgraphs/vetra-apps/__tests__/instances-previews.test.ts subgraphs/vetra-apps/__tests__/instances-settings.test.ts subgraphs/vetra-apps/__tests__/instances-health.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS. If the wake test sees the document still `STOPPED`, check that `wakeEnvironment` leaves `CHANGES_APPROVED` (reducer `wakeEnvironmentOperation`) and that `apply` approves only on `CHANGES_PENDING`/`DRAFT`; the test asserts "not STOPPED" for that reason.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/__tests__/instances-plans.test.ts && git commit -m "feat(instances): reconcile shared and own instances (PLAN environments, stop and wake)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 11: Licensing leaves plan-owned kinds to instances

**Files:**
- Create: `subgraphs/vetra-licensing/plan-kinds.ts`
- Modify: `subgraphs/vetra-licensing/handler.ts` (`HandlerDeps.planKinds`, `reconcileApp`), `subgraphs/vetra-licensing/index.ts` (wiring)
- Test: `subgraphs/vetra-licensing/__tests__/plan-kinds.test.ts`

**Interfaces:**
- Produces:
  - `leaveToInstances(licences: PlanLicence[], planKinds: ReadonlySet<string>, licensedRoots: ReadonlySet<string>): PlanLicence[]`: drops every licence of a chain that has a licence of a plan kind and no licensed environment.
  - `createPlanKindsReader(appsDb: Kysely<VetraAppsDB>): (appId: string) => Promise<ReadonlySet<string>>`. A missing `plans` table (42P01) reads as no kinds.
  - `HandlerDeps.planKinds?(appId: string): Promise<ReadonlySet<string>>`.

- [ ] **Step 1: Write the failing test** `plan-kinds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { leaveToInstances } from "../plan-kinds.js";
import type { PlanLicence } from "../chain-plan.js";

const lic = (id: string, kind: string | null, root = id): PlanLicence => ({
  id,
  user: "did:pkh:eip155:1:0x1",
  kind,
  status: "ACTIVE",
  issued: "2026-11-01T00:00:00.000Z",
  stage: null,
  root,
  authorised: true,
  replacedBy: null,
});

describe("leaveToInstances", () => {
  it("drops whole chains of plan kinds without a licensed environment, and nothing else", () => {
    const licences = [
      lic("a1", "basic"),
      lic("a2", "pro", "a1"), // upgraded into a plan kind: the chain goes to instances
      lic("b1", "pro"), // has a licensed environment: stays with licensing
      lic("c1", "dedicated"),
      lic("d1", null),
    ];
    expect(
      leaveToInstances(licences, new Set(["pro"]), new Set(["b1"])).map((l) => l.id),
    ).toEqual(["b1", "c1", "d1"]);
    expect(leaveToInstances(licences, new Set(), new Set())).toBe(licences);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-licensing/__tests__/plan-kinds.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `plan-kinds.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import type { PlanLicence } from "./chain-plan.js";

/**
 * Releases phase 3: a kind adopted by a vetra-apps plan belongs to the
 * instances model. Its chains get shared/own instances from the vetra-apps
 * reconciler, so licensing neither provisions, stages nor ends them. A chain
 * that already has a licensed environment stays here until the switch-over
 * moves it (overview rule 1).
 */
export function leaveToInstances(
  licences: PlanLicence[],
  planKinds: ReadonlySet<string>,
  licensedRoots: ReadonlySet<string>,
): PlanLicence[] {
  if (planKinds.size === 0) return licences;
  const toInstances = new Set(
    licences
      .filter((l) => l.kind !== null && planKinds.has(l.kind) && !licensedRoots.has(l.root))
      .map((l) => l.root),
  );
  return toInstances.size === 0 ? licences : licences.filter((l) => !toInstances.has(l.root));
}

const UNDEFINED_TABLE = "42P01";

/** The kinds the App's plans adopted (retired plans included: their holders stay theirs). */
export function createPlanKindsReader(appsDb: Kysely<VetraAppsDB>) {
  return async (appId: string): Promise<ReadonlySet<string>> => {
    try {
      const rows = await appsDb.selectFrom("plans").select("kind").where("app_id", "=", appId).execute();
      return new Set(rows.map((r) => r.kind));
    } catch (err) {
      // vetra-apps has not created the table yet (boot order): no plans.
      if ((err as { code?: unknown } | null)?.code === UNDEFINED_TABLE) return new Set();
      throw err;
    }
  };
}
```

In `handler.ts`:
  - import `leaveToInstances` from `"./plan-kinds.js"`;
  - in `HandlerDeps` after `environmentAppIds(): Promise<string[]>;`, add:

```ts
  /** Kinds adopted by vetra-apps plans (releases phase 3); their chains without a licensed environment are left to instances. Absent: none. */
  planKinds?(appId: string): Promise<ReadonlySet<string>>;
```

  - in `reconcileApp`, right after `const environments = await this.timed(…);`, insert:

```ts
    const planKinds = this.d.planKinds
      ? await this.timed(this.d.planKinds(appId), `plan kinds of app ${appId}`)
      : new Set<string>();
    const visible = leaveToInstances(
      licences,
      planKinds,
      new Set(environments.map((e) => e.root_license_id)),
    );
```

  - in the same function, pass `licences: visible,` to `planChains({…})` instead of `licences,`, and change `this.holdChains(planned, licences, heldRoots)` to `this.holdChains(planned, visible, heldRoots)`.

In `index.ts`, in the `new AppLicenseHandler({…})` object after `environmentAppIds: () => chainRows.appIds(),`, add `planKinds: createPlanKindsReader(appsDb),` and import `createPlanKindsReader` from `"./plan-kinds.js"`.

- [ ] **Step 4: Run it.** `npx vitest run subgraphs/vetra-licensing/__tests__/plan-kinds.test.ts subgraphs/vetra-licensing/__tests__/handler.test.ts subgraphs/vetra-licensing/__tests__/chain-plan.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS (the handler tests construct `HandlerDeps` without `planKinds`).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-licensing && git commit -m "feat(licensing): leave chains of plan-owned kinds to instances" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 12: Holder view and instance fields

**Files:**
- Create: `subgraphs/vetra-apps/plans/holder-view.ts`
- Modify: `subgraphs/vetra-apps/instances/service.ts`, `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Test: `subgraphs/vetra-apps/__tests__/plans-holder-view.test.ts`

**Interfaces:**
- Produces:
  - `HolderInstanceJson { instanceId; appId; appName; planName; access; url; status; reason; runningVersion }`;
  - `myInstancesFor(deps, caller): Promise<HolderInstanceJson[]>`: own instances whose `holder_address` is the caller (also while stopped), plus the shared instances of plans whose kind the caller holds a live licence of;
  - `InstanceJson.planId: string | null`, `InstanceJson.holder: string | null`;
  - GraphQL `HolderInstance`, `Query.myInstances: [HolderInstance!]!`, `AppInstance.planId`, `AppInstance.holder`.

- [ ] **Step 1: Write the failing test** `plans-holder-view.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, OWNER, seedActiveApp, stranger, testConfig, type Harness } from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { insertPlan } from "../plans/repo.js";
import { myInstancesFor } from "../plans/holder-view.js";
import type { Caller } from "../auth.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const holder: Caller = { address: HOLDER, chainId: 1, appKey: null, isAdmin: false };
let h: Harness;
let appId: string;

const base = {
  policy: "manual",
  notice_hours: 72,
  status: "active" as const,
  size: "VETRA_AGENT_S",
  target_version: "1.4.0",
  created_by: OWNER,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(async () => {
  h = await makeHarness(testConfig({ plans: { enabled: true, stopAfterDays: 14 } }));
  appId = (await seedActiveApp(h)).id;
  await h.db.updateTable("apps").set({ instances_enabled: true, registry_namespace: "acme" }).where("id", "=", appId).execute();
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release", digest: digest("b") });
  await insertPlan(h.db, { ...base, id: "p-own", app_id: appId, slug: "pro", name: "Pro", kind: "pro", access: "own" });
  await insertPlan(h.db, { ...base, id: "p-sh", app_id: appId, slug: "starter", name: "Starter", kind: "starter", access: "shared" });
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await seedLicence(h, { appId, kind: "starter", holder: HOLDER, licenseId: "l2" });
  await reconcileInstancesOnce(h.deps);
});
afterEach(async () => {
  await h.close();
});

describe("myInstances", () => {
  it("lists the holder's own instance and the shared instances of their plans", async () => {
    const mine = await myInstancesFor(h.deps, holder);
    expect(mine.map((m) => [m.planName, m.access])).toEqual([
      ["Pro", "own"],
      ["Starter", "shared"],
    ]);
    expect(mine[0].url).toMatch(/^https:\/\/.+\.vetra\.io$/);
  });
  it("lists nothing for someone without licences", async () => {
    expect(await myInstancesFor(h.deps, stranger)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/plans-holder-view.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `plans/holder-view.ts`:

```ts
import type { Caller } from "../auth.js";
import { INSTANCE_BASE_DOMAIN } from "../instances/reconciler.js";
import type { AppsDeps } from "../service.js";
import { liveKindsOfHolder } from "./holders.js";

export interface HolderInstanceJson {
  instanceId: string;
  appId: string;
  appName: string;
  planName: string;
  access: string;
  url: string | null;
  status: string;
  reason: string | null;
  runningVersion: string | null;
}

/** The instances the caller holds a licence for (spec section 11: a holder's own instances under their licences). */
export async function myInstancesFor(deps: AppsDeps, caller: Caller): Promise<HolderInstanceJson[]> {
  if (!deps.licensingDb) return [];
  const address = caller.address.toLowerCase();
  const base = () =>
    deps.db
      .selectFrom("instances")
      .innerJoin("plans", "plans.id", "instances.plan_id")
      .innerJoin("apps", "apps.id", "instances.app_id")
      .select([
        "instances.id as instanceId",
        "instances.app_id as appId",
        "apps.name as appName",
        "plans.name as planName",
        "plans.access as access",
        "instances.host as host",
        "instances.status as status",
        "instances.reason as reason",
        "instances.running_version as runningVersion",
      ])
      .where("instances.status", "!=", "removed");
  const own = await base()
    .where("instances.kind", "=", "own")
    .where("instances.holder_address", "=", address)
    .orderBy("instances.created_at")
    .execute();
  const kinds = await liveKindsOfHolder(deps.licensingDb, address, deps.now().toISOString());
  const shared: typeof own = [];
  for (const k of kinds)
    shared.push(
      ...(await base()
        .where("instances.kind", "=", "shared")
        .where("plans.access", "=", "shared")
        .where("plans.app_id", "=", k.appId)
        .where("plans.kind", "=", k.kind)
        .execute()),
    );
  return [...own, ...shared].map(({ host, ...r }) => ({
    ...r,
    url: host ? `https://${host}.${INSTANCE_BASE_DOMAIN}` : null,
  }));
}
```

In `instances/service.ts`, add to `InstanceJson` after `kind: string;`:

```ts
  /** shared/own: the plan it serves. */
  planId: string | null;
  /** own: the holder's address. */
  holder: string | null;
```

and in `instanceJson` after `kind: r.kind,`: `planId: r.plan_id ?? null, holder: r.holder_address ?? null,`.

In `schema.ts`, inside `type AppInstance` after `kind: String!`:

```graphql
    "shared/own: the plan it serves"
    planId: String
    "own: the holder's address"
    holder: String
```

and after `type AppPlan {…}`:

```graphql
  "An instance the caller holds a licence for"
  type HolderInstance {
    instanceId: ID!
    appId: ID!
    appName: String!
    planName: String!
    "shared | own"
    access: String!
    url: String
    status: String!
    reason: String
    runningVersion: String
  }
```

In `type Query` after `appPlans(…)`: `"Instances of the plans the caller holds licences of" myInstances: [HolderInstance!]!`. In `resolvers.ts` import `myInstancesFor` from `"./plans/holder-view.js"` and add to `Query`:

```ts
      myInstances: (_: unknown, __: unknown, ctx: AppsContext) =>
        guard(deps, "myInstances", () => myInstancesFor(deps, requireCaller(ctx))),
```

- [ ] **Step 4: Run it.** Same command plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-api.test.ts subgraphs/vetra-apps/__tests__/subgraph.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS. If `instances-api.test.ts` compares whole `InstanceJson` objects with `toEqual`, add `planId: null, holder: null` to its expectations.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(plans): myInstances for holders; plan and holder on AppInstance" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 13: Wiring and full checks

**Files:**
- Modify: `subgraphs/vetra-apps/index.ts`

- [ ] **Step 1: Wire `licensingDb`.** In `index.ts`, before `const deps: AppsDeps = {`:

```ts
    // Licensing's tables (plans' holders, licensed environments). Its tables
    // may not exist yet at boot (order is not fixed): plan sync logs and skips.
    const licensingDb = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;
```

and in the `deps` object after `releasePolicy,`: `licensingDb,`.

- [ ] **Step 2: Full checks.**
  - `npm run tsc 2>&1 | tail -20`
  - `npm run lint 2>&1 | grep -E "error|✖" | head -20`
  - `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors/vetra-cloud-environment document-models/vetra-cloud-environment 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`

  Expected: no new errors compared with Task 0's baseline. Fix what this branch broke. Leave pre-existing failures alone.
- [ ] **Step 3: Commit.** `git add subgraphs/vetra-apps/index.ts && git commit -m "feat(plans): wire licensing's tables into vetra-apps" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
- [ ] **Step 4: PR.** `git push -u origin feat/releases-phase-3-plans` and `gh pr create --title "feat(plans): plans and plan instances (releases phase 3, slice 1)"`. The body covers:
  - what ships;
  - that `VETRA_APPS_PLANS` defaults off;
  - the `PLAN` enum value;
  - the licensing handler change;
  - the staging steps below.

  End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

### Task 14: Staging verification (needs the user; no code)

- [ ] **Step 1: Pin staging.** After the merge and publish, the user merges a `powerhouse-k8s-hosting` PR that:
  - pins the new version in `tenants/staging/powerhouse-values.yaml` (`PH_REGISTRY_PACKAGES`, two places);
  - adds `VETRA_APPS_PLANS: "on"` and `VETRA_APPS_PLAN_STOP_AFTER_DAYS: "1"` (short, for the test).

  Production stays as it is.
- [ ] **Step 2: Terms on the staging canary app** (`96e56853-7041-4c32-a8f7-e9cc8afb50d4`). As its owner on `switchboard.staging.vetra.io/graphql` (`vetraPublisher` mutations):
  - `addTerm(input: {appId, kind: "pro", issuers: ["PUBLISHER_GRANT"], validityDays: 1})`, then `publishTerm(appId, termId)`;
  - the same for `starter`, without `validityDays`;
  - `addToAllowList(appId, user: <second test address>)`.

  The canary app needs a stable release recorded through vetra-publish (`appReleases(appId, kind: "release")`). If it has none, merge its release PR first.
- [ ] **Step 3: Plans.** On `switchboard.staging.vetra.io/graphql/vetra-apps`, as the owner:
  - `createPlan(input: {appId, kind: "pro", access: "own", size: "VETRA_AGENT_S", targetVersion: "<release>"})`;
  - `createPlan(input: {appId, kind: "starter", access: "shared", targetVersion: "<release>"})`.
- [ ] **Step 4: Shared instance.** Within one pass, `appInstances` shows `kind: shared` → `ready`. In `powerhouse-tenants-staging`, `tenants/<tenant>/powerhouse-values.yaml` has `persistence:\n    enabled: true` in the app block, `backup:\n      enabled: true`, and the tenant directory is under `tenants/`, not `previews/`. `kubectl -n <tenant> get pvc` shows the `/data` PVC.
- [ ] **Step 5: Own instance.** `vetraPublisher.issueGrant(input: {appId, kind: "pro", user: <second test address>})`. Within one pass:
  - an `own` instance appears, `holder` = that address;
  - its pod env `ADMINS` is that address (`kubectl -n <tenant> get deploy -o jsonpath='{..env}'`);
  - `myInstances` signed in as that address lists it and, after a `starter` grant, the Starter shared instance.
- [ ] **Step 6: Stop and wake.**
  - The `pro` grant ends after its 1 validity day (`validityDays: 1`). The instance then shows `licence_ended_at`, and one more day later (`VETRA_APPS_PLAN_STOP_AFTER_DAYS: "1"`) it is `stopped` and its environment STOPPED.
  - Wake: `vetraPublisher.replaceGrant(input: {licenseId: <the ended licence>, kind: "pro"})` renews in the same chain, and the instance wakes on the next pass. If licensing refuses to replace an ended head, the wake is covered by Task 10's test only; record that in the PR, and check instead that a fresh grant gets a second own instance.
  - `revokeLicense` on a live grant behaves like the end (licence ended → stop after the window).
- [ ] **Step 7: Target move.** Record a newer release on the canary app, then `setPlanTarget(planId, "<newer>")`: both instances update and become `ready` on the new digest (`kubectl get pod -o jsonpath='{..imageID}'`).
- [ ] **Step 8: Licensing untouched.** The switchboard logs show no `[licensing] … hold` lines for the `pro`/`starter` chains (`kubectl -n staging logs deploy/powerhouse-staging-switchboard | grep -E "licensing.*(pro|starter)"`), and `license_environments` has no new row.
- [ ] **Step 9: Record** the results in the PR. Production pin only with `VETRA_APPS_PLANS` unset, after the Sektar rollout check (Global Constraints).
- [ ] **Step 10: Console (vetra.to, separate PR, after staging works).**
  - Regenerate GraphQL types (`npm run codegen`).
  - App page → a **Plans** tab (`modules/apps/components/app-plans.tsx`): list, "Create plan from a term" (terms from `vetraPublisher` reads), target picker (releases only), size, retire.
  - The Instances tab shows `planId`/`holder` (show holder names from Renown, never raw addresses, per the console's naming rule).
  - The user's apps page → **My instances** (`myInstances`).
