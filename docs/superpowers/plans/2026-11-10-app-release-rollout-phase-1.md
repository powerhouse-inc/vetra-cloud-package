# App Release Rollout, Phase 1 (Gate and Records) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publisher can gate an app's releases: CI builds land on a canary environment first, the publisher promotes a version with a notice period, customers are updated one environment at a time when due or when they ask, a failed update pauses the rollout, every FUSION version move is recorded, and a holder can no longer change what the template owns.

**Architecture:** New relational state (`app_release_settings`, `app_rollouts`, `environment_updates`, `license_environments.channel_override`) lives in the licensing database behind one row module (`rollout-db.ts`). The keeper's existing path stays: `provisionChain` asks a new `UpdateGate` (`update-gate.ts`, wrapping the pure `decideRelease` in `release-gate.ts`) before the floor moves a live environment's FUSION version, and the handler runs new per-app release work after its chains (`release-tracker.ts` for outcomes and completion, `managed-by.ts` for the document marker). The environment document model gains `managedBy` and `SET_MANAGED_BY`, and its reducers lock template-owned fields against user-signed actions. The publisher and holder API is a new `vetraReleases` GraphQL root.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Kysely on Postgres (PGlite in tests), Powerhouse reactor and document models (`ph-cli` codegen), GraphQL (`graphql-tag`), Vitest, oxlint.

**Spec:** `docs/superpowers/specs/2026-11-10-app-release-rollout-design.md`. This plan implements sections 4.1 to 4.6 only. Section 5 (safe apply) and section 6 (console) have their own plans; `pre_update_dump_id` and the `REVERTED` / `RESTORED` statuses exist here only so phase 2 needs no migration.

## Global Constraints

- An app whose policy is AUTO (the default: no `app_release_settings` row) behaves exactly as today. Every existing test stays green and unchanged, except one assertion that encodes the "held but marked applied" bug: `subgraphs/vetra-licensing/__tests__/environments.test.ts`, test "warns, naming the environment and both versions, when the current version has aged out of the record" (Task 8 changes its hash expectation from `"h2"` to `"h1"`).
- Nothing may ever downgrade a FUSION version. The floor's `"floor"` and `"hold"` modes only move a version up (`isFusionUpgrade`); `"force"` never moves to a version provably older than the current one.
- No new dependency. `node:crypto`, `kysely`, `graphql-tag` and `graphql` are already used.
- Follow existing naming, comment density and test style: Vitest, real PGlite databases for row modules, hand-written fakes, `toStrictEqual` / `toMatchObject`, the "[licensing] ..." log prefix, `type` imports, `.js` suffixes on relative imports.
- Never edit files under a `gen/` folder by hand: Task 11 regenerates them.
- Commands, always from the repo root (`/home/froid/projects/vetra-cloud-package`): one test file `npx vitest run <path>`; the whole suite `npm test`; types `npm run tsc`; lint `npm run lint`; reducer coverage (must stay at or above 95%) `npm run test:coverage`.
- One commit per task, conventional message, ending with the line `Co-Authored-By: Claude <noreply@anthropic.com>`. Stay on `feat/app-release-rollout`; never push.

## Before You Start

- [ ] **Install the locked dependencies.** `node_modules` is stale: `@renown/sdk` (6.2.3-dev.2) is missing, so every test file that imports `subgraphs/vetra-apps/ci.ts` or `renown.ts` fails to load. Run `pnpm install --frozen-lockfile`.
- [ ] **Record the baseline.** Run `npm test 2>&1 | tail -6`, `npm run tsc 2>&1 | tail -5` and `npm run lint 2>&1 | tail -15`. Measured on 2026-11-10 before the install: 31 test files failed to load (all `Cannot find package '@renown/sdk/node'`), 163 files and 2318 tests passed, 18 skipped, 76 s; `tsc` had 3 errors and `lint` exited 1, all from the same missing package, plus two pre-existing lint errors (`subgraphs/vetra-apps/__tests__/migrations.test.ts:146`, `processors/vetra-cloud-environment/factory.ts:82`). After the install the 31 files are expected to load. Whatever still fails is the baseline: write it down.
- [ ] **What "green" means in every task below:** no test file fails that passed at baseline; the task's new tests pass; `npm run tsc` and `npm run lint` report nothing new in the files the task touched. Task 3 can only be verified after the install.
- Every patch below is applied from the repo root with `git apply`. If one does not apply (the file moved on), make the same edit by hand: the hunk shows exactly which lines change.

## Decisions Where the Spec Is Ambiguous or Does Not Fit the Code

Each was chosen as the option that changes the least. They are referenced from the tasks as D1 to D16.

- **D1. The API is a new `vetraReleases` root, not new fields on `vetraPublisher` / `vetraSubscriptions`.** `schema-composition.test.ts` pins the exact field lists of `VetraPublisherQueries`, `VetraPublisherMutations` and the subscriptions contract SDL in `docs/superpowers/specs/2026-10-08-licensing-api-contract.md`. Adding fields there means changing that contract and those tests. `PublisherEnvironment` is extended with `extend type` (its test only checks `toContain`). App fields authorise the app's owner exactly as `vetraPublisher` does; environment fields take the holder or the owner of the environment's app.
- **D2. `managedBy` carries a fourth field, `services`** (the service types the template declares). The reducer cannot read the template, and the lock applies to "a service the template declares".
- **D3. Lock semantics.** User-signed `SET_SERVICE_VERSION`, `DISABLE_SERVICE` and `TOGGLE_SERVICE` are rejected for a declared service type. `ENABLE_SERVICE` is rejected only when it would turn a declared service on (missing or disabled); re-stating an enabled one, which is how a size or prefix changes, passes. `SET_FUSION_CONFIG` is rejected when `image`, `autoUpdate` or `autoUpdateTagPattern` differ from the state; changing only `env` passes. Services the template does not declare stay the holder's.
- **D4. `SET_MANAGED_BY` is dispatched by a per-app sync after the chains run (`managed-by.ts`, via the handler's new `afterChains` hook), not inside `provisionChain`'s batches.** It runs in the same tick as a create or a warm claim, and it backfills every existing environment. Putting it inside the create/claim/floor batches would change action lists that existing tests assert exactly. The cost is a window of one tick in which a new environment is not yet locked.
- **D5. Section 4.6 is not a typo to fix.** `DEPLOYMENt_FAILED` is the environment model's own enum value (`schema.graphql`, reducers, `offboarding.ts`, `housekeeping`, the observability reconciler all use it). "Fixing" the string in `fusion-auto-update.ts` would stop auto-update bumping failed environments. Task 18 instead pins it with `satisfies VetraCloudEnvironmentStatus[]` and a comment, so a future rename of the enum breaks the build. Renaming the enum value itself would need a document-model version upgrade and is out of scope.
- **D6. A canary resolves on its override channel but keeps each service's own `artifactChannel`,** so its template hash equals the customers' hash whenever both channels point at the same version: marking a canary causes no re-template on its own.
- **D7. Update rows exist only for a move of an existing FUSION version on a live environment.** A create, a warm claim, or a FUSION service that has no version yet records nothing.
- **D8. A new column `environment_updates.forced_at`** (not in the spec) records `forceEnvironmentUpdate`. A forced update skips its deadline, a paused rollout and the stranded hold, but still waits for another update of the same app to finish, and never moves to a provably older version. Force also applies to a FAILED update, which is the only retry path for a canary.
- **D9. A gated customer whose wanted version has no ACTIVE or PAUSED rollout is held with no row** (for example LATEST moved before the app was gated). The publisher promotes that version to release it.
- **D10. A held environment gives its re-template budget back after the fact.** The handler only learns a chain was held from `provisionChain`'s result (`versionHeld`); it then refunds the slot it took, as it already does for a refusal.
- **D11. Rollout completion** needs no PENDING or APPLYING update, LATEST pointing at the rollout's version in the app document the tick read, and no live non-canary environment behind its template hash (an environment the keeper has not visited since the promotion has no update yet).
- **D12. A resumed update whose environment already runs its version** (its deployment failed after the version was set; phase 1 does not revert) is never moved again, because the environment meets its template. The tracker marks it SUCCEEDED once the environment is READY again. Without this, the rollout could never complete.
- **D13. `promoteRelease` refuses an app that is not GATED,** checks that the artifact has the version, needs a live canary READY on it, and moves LATEST before inserting the rollout (an insert failure then only delays customers; promoting again finishes it).
- **D14. Only an environment the caller holds can be marked canary**; GATED needs at least one live canary, and the last canary of a GATED app cannot be unmarked. Notice hours are whole numbers from 0 to 720.
- **D15. `myEnvironments` exposes `managedBy` through a field resolver** on `VetraCloudEnvironmentSummary` (one primary-key read per environment that asks for it), because the existing `my-environments.test.ts` builds its own `environments` table without the new column.
- **D16. `channel_override` is optional in the `LicenseEnvironments` TypeScript type** (`channel_override?: string | null`), so the many existing row literals in code and tests still type-check. The machine API's `applyEnvironmentTemplate` also resolves a canary chain on its channel.

## File Structure

| Path | | Responsibility |
|---|---|---|
| `subgraphs/vetra-licensing/db/schema.ts`, `db/migrations.ts` | modify | Row types and the migration for the three tables and the column |
| `subgraphs/vetra-licensing/rollout-db.ts` | create | Every query on the release tables; `releasePolicyOf` for vetra-apps |
| `subgraphs/vetra-apps/service.ts`, `index.ts` | modify | CI redirect LATEST to STAGING for a gated app (4.1) |
| `subgraphs/vetra-licensing/artifact-resolution.ts`, `channel-override.ts` | modify, create | Resolve a chain's template on its override channel (4.2) |
| `subgraphs/vetra-licensing/chain-plan.ts`, `handler.ts`, `resolvers.ts` | modify | Per-chain resolution; held refund; `afterChains` hook |
| `subgraphs/vetra-licensing/template.ts` | modify | `fusionMoveOf`, FUSION version modes `floor` / `hold` / `force` |
| `subgraphs/vetra-licensing/release-gate.ts` | create | Pure: may this version move now, which rows record it |
| `subgraphs/vetra-licensing/update-gate.ts` | create | Loads the gate's inputs, writes its rows in one transaction |
| `subgraphs/vetra-licensing/environments.ts` | modify | Ask the gate; advance `template_hash` only when the template is met |
| `subgraphs/vetra-licensing/update-outcome.ts`, `release-tracker.ts`, `config.ts` | create, create, modify | Outcome transitions, pause on failure, completion; the timeout |
| `document-models/vetra-cloud-environment/**` | modify, regenerate | `managedBy`, `SET_MANAGED_BY`, reducer locks |
| `subgraphs/vetra-cloud-observability/env-protection.ts` | modify | `SET_MANAGED_BY` is system-only at reactor-api |
| `subgraphs/vetra-licensing/managed-by.ts` | create | Keeps every chain environment's marker on its template |
| `processors/vetra-cloud-environment/*`, `subgraphs/vetra-cloud-observability/{schema,resolvers}.ts` | modify | Read-model column and `myEnvironments.managedBy` |
| `subgraphs/vetra-licensing/release-service.ts`, `publisher-errors.ts` | create, modify | Promote, resume, force, update now, policy, canary; the read side |
| `subgraphs/vetra-licensing/releases-schema.ts`, `releases-resolvers.ts`, `schema.ts` | create, create, modify | The `vetraReleases` GraphQL surface |
| `subgraphs/vetra-licensing/index.ts` | modify | Production wiring |
| `subgraphs/vetra-cloud-observability/fusion-auto-update.ts` | modify | Pin the model's status spelling (4.6, D5) |

---

### Task 1: Release tables and the canary column

**Files:**
- Modify: `subgraphs/vetra-licensing/db/schema.ts` (after `LicenseEnvironments.template_hash`; before `VetraLicensingDB`; inside `VetraLicensingDB`)
- Modify: `subgraphs/vetra-licensing/db/migrations.ts` (end of `up()`, the drop list in `down()`)
- Test: `subgraphs/vetra-licensing/__tests__/migrations.test.ts` (appended describe)

**Interfaces:**
- Consumes: `addColumnIfMissing(db, table, column, type)` (private to `db/migrations.ts`).
- Produces (in `db/schema.ts`): `type ReleasePolicy = "AUTO" | "GATED"`; `type RolloutStatus = "ACTIVE" | "PAUSED" | "SUPERSEDED" | "COMPLETE"`; `type UpdateStatus = "PENDING" | "APPLYING" | "SUCCEEDED" | "REVERTED" | "RESTORED" | "FAILED" | "SUPERSEDED"`; row interfaces `AppReleaseSettings`, `AppRollouts`, `EnvironmentUpdates` (snake_case columns exactly as in the spec plus `forced_at: string | null`, D8); `LicenseEnvironments.channel_override?: string | null` (D16); `VetraLicensingDB` keys `app_release_settings`, `app_rollouts`, `environment_updates`.

- [ ] **Step 1: Write the failing test.** Append to `subgraphs/vetra-licensing/__tests__/migrations.test.ts`:

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/migrations.test.ts b/subgraphs/vetra-licensing/__tests__/migrations.test.ts
--- a/subgraphs/vetra-licensing/__tests__/migrations.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/migrations.test.ts
@@ -307,3 +307,59 @@ describe("vetra-licensing migrations (real PGlite)", () => {
     expect(rows).toHaveLength(1);
   });
 });
+
+describe("vetra-licensing migrations: app release rollout tables", () => {
+  let db: Kysely<VetraLicensingDB> | undefined;
+  afterEach(async () => {
+    await db?.destroy();
+    db = undefined;
+  });
+  const update = (id: string, rollout_id: string | null, environment_id = "e1") => ({
+    id, rollout_id, environment_id, app_id: "a", from_version: "1.0.0", to_version: "1.1.0", status: "PENDING" as const,
+    due_at: "t", requested_at: null, started_at: null, finished_at: null, pre_update_dump_id: null, error: null,
+    forced_at: null, created_at: "t",
+  });
+
+  it("defaults a settings row to AUTO with 72 hours' notice", async () => {
+    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
+    await up(db as Kysely<any>);
+    await (db as Kysely<any>).insertInto("app_release_settings").values({ app_id: "a", updated_at: "t" }).execute();
+    expect(await db.selectFrom("app_release_settings").selectAll().executeTakeFirstOrThrow())
+      .toStrictEqual({ app_id: "a", policy: "AUTO", default_notice_hours: 72, updated_at: "t" });
+  });
+
+  it("adds channel_override to license_environments, null on existing rows", async () => {
+    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
+    await up(db as Kysely<any>);
+    await db.insertInto("license_environments").values({
+      environment_id: "e", root_license_id: "l", app_id: "a", user_did: "u", license_id: "l", template_id: null,
+      label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t",
+    }).execute();
+    await up(db as Kysely<any>);
+    const row = await db.selectFrom("license_environments").selectAll().executeTakeFirstOrThrow();
+    expect(row.channel_override).toBeNull();
+  });
+
+  it("allows one update per (rollout, environment), and any number without a rollout", async () => {
+    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
+    await up(db as Kysely<any>);
+    await db.insertInto("environment_updates").values(update("u1", "r1")).execute();
+    await expect(db.insertInto("environment_updates").values(update("u2", "r1")).execute())
+      .rejects.toThrow(/duplicate key|unique/i);
+    await db.insertInto("environment_updates").values(update("u3", "r1", "e2")).execute();
+    await db.insertInto("environment_updates").values(update("u4", null)).execute();
+    await db.insertInto("environment_updates").values(update("u5", null)).execute();
+    expect(await db.selectFrom("environment_updates").select("id").execute()).toHaveLength(4);
+  });
+
+  it("drops the release tables on down() and recreates them on up()", async () => {
+    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
+    await up(db as Kysely<any>);
+    await db.insertInto("environment_updates").values(update("u1", "r1")).execute();
+    await down(db as Kysely<any>);
+    await up(db as Kysely<any>);
+    for (const t of ["app_release_settings", "app_rollouts", "environment_updates"] as const) {
+      expect(await db.selectFrom(t).selectAll().execute()).toHaveLength(0);
+    }
+  });
+});
PATCH
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migrations.test.ts`
Expected: the four new tests FAIL (`relation "app_release_settings" does not exist`, `relation "environment_updates" does not exist`, and `channel_override` reads `undefined`, not `null`); the existing ones pass. TypeScript types are not checked by Vitest, so the missing row types show only in `npm run tsc`.

- [ ] **Step 3: Add the row types and the migration.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/db/schema.ts b/subgraphs/vetra-licensing/db/schema.ts
--- a/subgraphs/vetra-licensing/db/schema.ts
+++ b/subgraphs/vetra-licensing/db/schema.ts
@@ -68,6 +68,12 @@ export interface LicenseEnvironments {
   template_id: string | null;
   label: string | null;
   template_hash: string;
+  /**
+   * The channel every artifact of this chain's template resolves on instead
+   * of the template's own (spec 4.2): 'STAGING' marks a canary. Null (or
+   * absent on a row built in code before the column existed): the template's.
+   */
+  channel_override?: string | null;
   /** First moment the keeper saw the chain without an ACTIVE licence. */
   ended_at: string | null;
   stopped_at: string | null;
@@ -206,6 +212,65 @@ export interface AppWarmPool {
   timed_out_at: string | null;
 }
 
+export type ReleasePolicy = "AUTO" | "GATED";
+export type RolloutStatus = "ACTIVE" | "PAUSED" | "SUPERSEDED" | "COMPLETE";
+export type UpdateStatus =
+  | "PENDING"
+  | "APPLYING"
+  | "SUCCEEDED"
+  | "REVERTED"
+  | "RESTORED"
+  | "FAILED"
+  | "SUPERSEDED";
+
+/** Per-app release policy (spec 4.1). No row: AUTO with 72 hours' notice. */
+export interface AppReleaseSettings {
+  app_id: string;
+  policy: ReleasePolicy;
+  default_notice_hours: number;
+  updated_at: string;
+}
+
+/** A promotion of one FUSION artifact version to the app's customers (spec 4.3). */
+export interface AppRollouts {
+  id: string;
+  app_id: string;
+  artifact_name: string;
+  version: string;
+  status: RolloutStatus;
+  /** Customers are updated automatically from here on (promotion + notice). */
+  apply_after: string;
+  /** Lowercased address of the publisher who promoted it. */
+  promoted_by: string;
+  promoted_at: string;
+  paused_at: string | null;
+  paused_reason: string | null;
+}
+
+/**
+ * One FUSION version move of one environment (spec 4.3). rollout_id is null
+ * for a canary's update and for every update of an AUTO app.
+ */
+export interface EnvironmentUpdates {
+  id: string;
+  rollout_id: string | null;
+  environment_id: string;
+  app_id: string;
+  from_version: string;
+  to_version: string;
+  status: UpdateStatus;
+  due_at: string;
+  requested_at: string | null;
+  started_at: string | null;
+  finished_at: string | null;
+  /** Phase 2 (safe apply): the dump taken before the version was set. */
+  pre_update_dump_id: string | null;
+  error: string | null;
+  /** Set by the publisher's forceEnvironmentUpdate: applies despite a pause or an unordered version. */
+  forced_at: string | null;
+  created_at: string;
+}
+
 export interface VetraLicensingDB {
   app_licensing_state: AppLicensingState;
   app_licensing_intent: AppLicensingIntent;
@@ -222,4 +287,7 @@ export interface VetraLicensingDB {
   licensing_migration_type_map: LicensingMigrationTypeMap;
   licensing_migration_steps: LicensingMigrationSteps;
   license_lifecycle: LicenseLifecycle;
+  app_release_settings: AppReleaseSettings;
+  app_rollouts: AppRollouts;
+  environment_updates: EnvironmentUpdates;
 }
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/db/migrations.ts b/subgraphs/vetra-licensing/db/migrations.ts
--- a/subgraphs/vetra-licensing/db/migrations.ts
+++ b/subgraphs/vetra-licensing/db/migrations.ts
@@ -283,10 +283,63 @@ export async function up(db: Kysely<any>): Promise<void> {
 
   // Also created by vetra-apps, which writes the ledger too (licensing-ledger.ts).
   await ensureLedgerTables(db);
+
+  // App release rollout (spec 2026-11-10 §4): the release policy, the canary
+  // flag, promotions and every environment's FUSION version moves.
+  await db.schema.createTable("app_release_settings")
+    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
+    .addColumn("policy", "varchar(16)", (c) => c.notNull().defaultTo("AUTO"))
+    .addColumn("default_notice_hours", "integer", (c) => c.notNull().defaultTo(72))
+    .addColumn("updated_at", "varchar(255)", (c) => c.notNull())
+    .addPrimaryKeyConstraint("app_release_settings_pkey", ["app_id"])
+    .ifNotExists().execute();
+  await addColumnIfMissing(db, "license_environments", "channel_override", "varchar(255)");
+  await db.schema.createTable("app_rollouts")
+    .addColumn("id", "varchar(255)", (c) => c.notNull())
+    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
+    .addColumn("artifact_name", "varchar(255)", (c) => c.notNull())
+    .addColumn("version", "varchar(255)", (c) => c.notNull())
+    .addColumn("status", "varchar(16)", (c) => c.notNull())
+    .addColumn("apply_after", "varchar(255)", (c) => c.notNull())
+    .addColumn("promoted_by", "varchar(255)", (c) => c.notNull())
+    .addColumn("promoted_at", "varchar(255)", (c) => c.notNull())
+    .addColumn("paused_at", "varchar(255)")
+    .addColumn("paused_reason", "text")
+    .addPrimaryKeyConstraint("app_rollouts_pkey", ["id"])
+    .ifNotExists().execute();
+  await db.schema.createIndex("app_rollouts_artifact_idx").on("app_rollouts")
+    .columns(["app_id", "artifact_name", "status"]).ifNotExists().execute();
+  await db.schema.createTable("environment_updates")
+    .addColumn("id", "varchar(255)", (c) => c.notNull())
+    .addColumn("rollout_id", "varchar(255)")
+    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
+    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
+    .addColumn("from_version", "varchar(255)", (c) => c.notNull())
+    .addColumn("to_version", "varchar(255)", (c) => c.notNull())
+    .addColumn("status", "varchar(16)", (c) => c.notNull())
+    .addColumn("due_at", "varchar(255)", (c) => c.notNull())
+    .addColumn("requested_at", "varchar(255)")
+    .addColumn("started_at", "varchar(255)")
+    .addColumn("finished_at", "varchar(255)")
+    .addColumn("pre_update_dump_id", "varchar(255)")
+    .addColumn("error", "text")
+    .addColumn("forced_at", "varchar(255)")
+    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
+    .addPrimaryKeyConstraint("environment_updates_pkey", ["id"])
+    // NULL rollout ids are distinct: a canary or AUTO app may have many.
+    .addUniqueConstraint("environment_updates_rollout_env_key", ["rollout_id", "environment_id"])
+    .ifNotExists().execute();
+  await db.schema.createIndex("environment_updates_env_idx").on("environment_updates")
+    .columns(["environment_id", "created_at"]).ifNotExists().execute();
+  await db.schema.createIndex("environment_updates_app_status_idx").on("environment_updates")
+    .columns(["app_id", "status"]).ifNotExists().execute();
 }
 
 export async function down(db: Kysely<any>): Promise<void> {
   for (const t of [
+    "environment_updates",
+    "app_rollouts",
+    "app_release_settings",
     "license_lifecycle",
     "app_licensing_intent",
     "app_licensing_state",
PATCH
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/migrations.test.ts` then `npm run tsc 2>&1 | tail -5`
Expected: all migration tests PASS (20); `tsc` reports nothing new.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/db/schema.ts subgraphs/vetra-licensing/db/migrations.ts subgraphs/vetra-licensing/__tests__/migrations.test.ts
git commit -m "feat(licensing): release policy, rollout and environment update tables" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2: The rollout row module

**Files:**
- Create: `subgraphs/vetra-licensing/rollout-db.ts`
- Test: `subgraphs/vetra-licensing/__tests__/rollout-db.test.ts`

**Interfaces:**
- Consumes: the Task 1 row types.
- Produces:
  - `releasePolicyOf(db: Kysely<VetraLicensingDB>, appId: string): Promise<ReleasePolicy>` (a missing table, SQLSTATE 42P01, reads AUTO; anything else throws).
  - `interface ReleaseSettings { appId: string; policy: ReleasePolicy; defaultNoticeHours: number }`, `DEFAULT_NOTICE_HOURS = 72`.
  - `createRolloutStore(db): RolloutStore` where `RolloutStore = RolloutQueries & { inTransaction<T>(fn: (q: RolloutQueries) => Promise<T>): Promise<T> }` and `RolloutQueries` has: `settings(appId)`, `saveSettings(s, now)`, `rollout(id)`, `openRollout(appId, artifactName, version)`, `rolloutsOf(appId)`, `activeRollouts(appId)`, `promote(row)`, `pause(id, reason, now): Promise<boolean>`, `resume(id): Promise<boolean>`, `complete(id)`, `openCount(rolloutId)`, `countsByStatus(rolloutId): Promise<{ status: UpdateStatus; count: number }[]>`, `update(id)`, `updateFor(rolloutId, environmentId)`, `unrolledUpdate(environmentId, toVersion)`, `openExcept(environmentId, exceptId: string | null)`, `anotherApplying(appId, environmentId): Promise<boolean>`, `applyingOf(appId)`, `pendingOf(appId)`, `latest(environmentId)`, `history(environmentId, limit)`, `insertUpdate(row)`, `patchUpdate(id, patch)`, `releaseApplying(id)`, `finishUpdate(id, status: "SUCCEEDED" | "FAILED", error, now, from: UpdateStatus = "APPLYING")`. "Newest" is `created_at` descending, then `id` descending.

- [ ] **Step 1: Write the failing test.** Create `subgraphs/vetra-licensing/__tests__/rollout-db.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { AppRollouts, EnvironmentUpdates, VetraLicensingDB } from "../db/schema.js";
import { createRolloutStore, releasePolicyOf, type RolloutStore } from "../rollout-db.js";

const T0 = "2026-11-10T00:00:00.000Z";
const T1 = "2026-11-10T01:00:00.000Z";
const rollout = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1", app_id: "a", artifact_name: "web", version: "1.1.0", status: "ACTIVE", apply_after: T1,
  promoted_by: "0xp", promoted_at: T0, paused_at: null, paused_reason: null, ...over,
});
const update = (over: Partial<EnvironmentUpdates> = {}): EnvironmentUpdates => ({
  id: "u1", rollout_id: "r1", environment_id: "e1", app_id: "a", from_version: "1.0.0", to_version: "1.1.0",
  status: "PENDING", due_at: T1, requested_at: null, started_at: null, finished_at: null, pre_update_dump_id: null,
  error: null, forced_at: null, created_at: T0, ...over,
});

let db: Kysely<VetraLicensingDB>;
let store: RolloutStore;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  store = createRolloutStore(db);
});
afterEach(async () => { await db.destroy(); });

describe("release settings", () => {
  it("reads AUTO with 72 hours for an app without a row, and saves over it", async () => {
    expect(await store.settings("a")).toStrictEqual({ appId: "a", policy: "AUTO", defaultNoticeHours: 72 });
    await store.saveSettings({ appId: "a", policy: "GATED", defaultNoticeHours: 0 }, T0);
    await store.saveSettings({ appId: "a", policy: "GATED", defaultNoticeHours: 24 }, T1);
    expect(await store.settings("a")).toStrictEqual({ appId: "a", policy: "GATED", defaultNoticeHours: 24 });
    expect(await releasePolicyOf(db, "a")).toBe("GATED");
    expect(await releasePolicyOf(db, "b")).toBe("AUTO");
  });

  it("reads AUTO when the licensing tables do not exist yet, and propagates anything else", async () => {
    const bare = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    expect(await releasePolicyOf(bare, "a")).toBe("AUTO");
    await bare.destroy();
    await expect(releasePolicyOf(bare, "a")).rejects.toThrow();
  });
});

describe("rollouts", () => {
  it("supersedes the artifact's ACTIVE and PAUSED rollouts on promotion, not other artifacts'", async () => {
    await store.promote(rollout({ id: "r1" }));
    await store.promote(rollout({ id: "other", artifact_name: "api" }));
    expect(await store.pause("r1", "e1 failed", T1)).toBe(true);
    await store.promote(rollout({ id: "r2", version: "1.2.0", promoted_at: T1 }));
    expect((await store.rollout("r1"))!.status).toBe("SUPERSEDED");
    expect((await store.rollout("other"))!.status).toBe("ACTIVE");
    expect(await store.openRollout("a", "web", "1.2.0")).toMatchObject({ id: "r2", status: "ACTIVE" });
    expect(await store.openRollout("a", "web", "1.1.0")).toBeNull();
    expect((await store.rolloutsOf("a")).map((r) => r.id)).toStrictEqual(["r2", "r1", "other"]);
    expect((await store.activeRollouts("a")).map((r) => r.id).sort()).toStrictEqual(["other", "r2"]);
  });

  it("pauses only an ACTIVE rollout, and resume returns its FAILED updates to PENDING", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ id: "u1", status: "FAILED", error: "boom", started_at: T0, finished_at: T1 }));
    await store.insertUpdate(update({ id: "u2", environment_id: "e2", status: "SUCCEEDED" }));
    expect(await store.resume("r1")).toBe(false);
    expect(await store.pause("r1", "environment e1: boom", T1)).toBe(true);
    expect(await store.pause("r1", "again", T1)).toBe(false);
    expect(await store.rollout("r1")).toMatchObject({ status: "PAUSED", paused_at: T1, paused_reason: "environment e1: boom" });
    expect(await store.resume("r1")).toBe(true);
    expect(await store.rollout("r1")).toMatchObject({ status: "ACTIVE", paused_at: null, paused_reason: null });
    expect(await store.update("u1")).toMatchObject({ status: "PENDING", error: null, started_at: null, finished_at: null });
    expect((await store.update("u2"))!.status).toBe("SUCCEEDED");
  });

  it("counts open updates and updates by status; complete only moves an ACTIVE rollout", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ id: "u1", status: "PENDING" }));
    await store.insertUpdate(update({ id: "u2", environment_id: "e2", status: "APPLYING" }));
    await store.insertUpdate(update({ id: "u3", environment_id: "e3", status: "SUCCEEDED" }));
    expect(await store.openCount("r1")).toBe(2);
    expect(await store.countsByStatus("r1")).toStrictEqual([
      { status: "APPLYING", count: 1 }, { status: "PENDING", count: 1 }, { status: "SUCCEEDED", count: 1 },
    ]);
    await store.pause("r1", "x", T1);
    await store.complete("r1");
    expect((await store.rollout("r1"))!.status).toBe("PAUSED");
  });
});

describe("environment updates", () => {
  it("finds the rows the gate needs", async () => {
    await store.insertUpdate(update({ id: "old", rollout_id: null, to_version: "1.1.0", status: "SUPERSEDED", created_at: T0 }));
    await store.insertUpdate(update({ id: "canary", rollout_id: null, to_version: "1.1.0", status: "SUCCEEDED", created_at: T1 }));
    await store.insertUpdate(update({ id: "r1e1", rollout_id: "r1", to_version: "1.2.0", status: "PENDING", created_at: T1 }));
    await store.insertUpdate(update({ id: "r1e2", rollout_id: "r1", environment_id: "e2", status: "APPLYING" }));
    expect((await store.updateFor("r1", "e1"))!.id).toBe("r1e1");
    expect((await store.unrolledUpdate("e1", "1.1.0"))!.id).toBe("canary");
    expect(await store.unrolledUpdate("e1", "9.9.9")).toBeNull();
    expect((await store.openExcept("e1", null))!.id).toBe("r1e1");
    expect(await store.openExcept("e1", "r1e1")).toBeNull();
    expect(await store.anotherApplying("a", "e1")).toBe(true);
    expect(await store.anotherApplying("a", "e2")).toBe(false);
    expect((await store.applyingOf("a")).map((u) => u.id)).toStrictEqual(["r1e2"]);
    // Same created_at: the larger id is newest.
    expect((await store.latest("e1"))!.id).toBe("r1e1");
    expect((await store.history("e1", 2)).map((u) => u.id)).toHaveLength(2);
  });

  it("releases only an APPLYING update, and finishes only an APPLYING one", async () => {
    await store.insertUpdate(update({ id: "u1", status: "APPLYING", started_at: T0 }));
    await store.releaseApplying("u1");
    expect(await store.update("u1")).toMatchObject({ status: "PENDING", started_at: null });
    await store.finishUpdate("u1", "SUCCEEDED", null, T1);
    expect((await store.update("u1"))!.status).toBe("PENDING");
    await store.patchUpdate("u1", { status: "APPLYING", started_at: T0 });
    await store.finishUpdate("u1", "FAILED", "deployment failed", T1);
    expect(await store.update("u1")).toMatchObject({ status: "FAILED", error: "deployment failed", finished_at: T1 });
  });

  it("runs gate writes in one transaction: a failure leaves nothing behind", async () => {
    await expect(
      store.inTransaction(async (q) => {
        await q.insertUpdate(update({ id: "u1" }));
        await q.insertUpdate(update({ id: "u1" }));
      }),
    ).rejects.toThrow();
    expect(await store.update("u1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/rollout-db.test.ts`
Expected: FAIL, `Failed to load url ../rollout-db.js`.

- [ ] **Step 3: Write the module.** Create `subgraphs/vetra-licensing/rollout-db.ts`:

```ts
import type { Kysely } from "kysely";
import type {
  AppRollouts,
  EnvironmentUpdates,
  ReleasePolicy,
  UpdateStatus,
  VetraLicensingDB,
} from "./db/schema.js";

/** Postgres SQLSTATE for "relation does not exist". */
const UNDEFINED_TABLE = "42P01";

export interface ReleaseSettings {
  appId: string;
  policy: ReleasePolicy;
  defaultNoticeHours: number;
}

/** What an app without a settings row has: every app before this feature. */
export const DEFAULT_NOTICE_HOURS = 72;

/**
 * The app's release policy, for vetra-apps' CI artifact path (spec 4.1). The
 * licensing subgraph creates the table; until it has booted no app can be
 * GATED, so a missing table reads as AUTO. Any other failure propagates: CI
 * fails loudly rather than publishing a gated build to every customer.
 */
export async function releasePolicyOf(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<ReleasePolicy> {
  try {
    const row = await db
      .selectFrom("app_release_settings")
      .select("policy")
      .where("app_id", "=", appId)
      .executeTakeFirst();
    return row?.policy ?? "AUTO";
  } catch (err) {
    if ((err as { code?: string } | null)?.code === UNDEFINED_TABLE) return "AUTO";
    throw err;
  }
}

const OPEN: UpdateStatus[] = ["PENDING", "APPLYING"];

type UpdatePatch = Partial<Omit<EnvironmentUpdates, "id" | "environment_id" | "app_id" | "rollout_id">>;

/** The store's queries, over the database or over one transaction. */
export type RolloutQueries = ReturnType<typeof rolloutQueries>;

export type RolloutStore = RolloutQueries & {
  /** fn over the queries bound to one transaction. Not re-entrant: promote and resume open their own. */
  inTransaction<T>(fn: (queries: RolloutQueries) => Promise<T>): Promise<T>;
};

/**
 * `app_release_settings`, `app_rollouts` and `environment_updates`. Newest
 * means latest `created_at` (then id, so the order is total).
 */
export function createRolloutStore(db: Kysely<VetraLicensingDB>): RolloutStore {
  return {
    ...rolloutQueries(db),
    inTransaction: (fn) => db.transaction().execute((trx) => fn(rolloutQueries(trx))),
  };
}

function rolloutQueries(db: Kysely<VetraLicensingDB>) {
  const updates = () =>
    db.selectFrom("environment_updates").selectAll().orderBy("created_at", "desc").orderBy("id", "desc");
  const first = (q: Promise<EnvironmentUpdates | undefined>) => q.then((r) => r ?? null);
  return {
    async settings(appId: string): Promise<ReleaseSettings> {
      const row = await db
        .selectFrom("app_release_settings")
        .selectAll()
        .where("app_id", "=", appId)
        .executeTakeFirst();
      return {
        appId,
        policy: row?.policy ?? "AUTO",
        defaultNoticeHours: row?.default_notice_hours ?? DEFAULT_NOTICE_HOURS,
      };
    },
    async saveSettings(s: ReleaseSettings, now: string): Promise<void> {
      const row = { policy: s.policy, default_notice_hours: s.defaultNoticeHours, updated_at: now };
      await db
        .insertInto("app_release_settings")
        .values({ app_id: s.appId, ...row })
        .onConflict((oc) => oc.column("app_id").doUpdateSet(row))
        .execute();
    },

    rollout: (id: string): Promise<AppRollouts | null> =>
      db.selectFrom("app_rollouts").selectAll().where("id", "=", id).executeTakeFirst().then((r) => r ?? null),
    /** The artifact's ACTIVE or PAUSED rollout of `version`, or null. */
    openRollout: (appId: string, artifactName: string, version: string): Promise<AppRollouts | null> =>
      db
        .selectFrom("app_rollouts")
        .selectAll()
        .where("app_id", "=", appId)
        .where("artifact_name", "=", artifactName)
        .where("version", "=", version)
        .where("status", "in", ["ACTIVE", "PAUSED"])
        .orderBy("promoted_at", "desc")
        .executeTakeFirst()
        .then((r) => r ?? null),
    /** Newest promotion first. */
    rolloutsOf: (appId: string): Promise<AppRollouts[]> =>
      db.selectFrom("app_rollouts").selectAll().where("app_id", "=", appId)
        .orderBy("promoted_at", "desc").orderBy("id", "desc").execute(),
    activeRollouts: (appId: string): Promise<AppRollouts[]> =>
      db.selectFrom("app_rollouts").selectAll().where("app_id", "=", appId).where("status", "=", "ACTIVE").execute(),
    /**
     * Every ACTIVE or PAUSED rollout of the artifact becomes SUPERSEDED and
     * `row` is inserted, in one transaction. Their PENDING updates stay: the
     * keeper supersedes each when it inserts its successor, keeping the
     * earlier deadline (decision 9).
     */
    async promote(row: AppRollouts): Promise<void> {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("app_rollouts")
          .set({ status: "SUPERSEDED" })
          .where("app_id", "=", row.app_id)
          .where("artifact_name", "=", row.artifact_name)
          .where("status", "in", ["ACTIVE", "PAUSED"])
          .execute();
        await trx.insertInto("app_rollouts").values(row).execute();
      });
    },
    /** ACTIVE -> PAUSED; false when it was not ACTIVE (already paused, superseded...). */
    async pause(id: string, reason: string, now: string): Promise<boolean> {
      const r = await db
        .updateTable("app_rollouts")
        .set({ status: "PAUSED", paused_at: now, paused_reason: reason })
        .where("id", "=", id)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },
    /** PAUSED -> ACTIVE, and its FAILED updates back to PENDING, in one transaction. */
    async resume(id: string): Promise<boolean> {
      return db.transaction().execute(async (trx) => {
        const r = await trx
          .updateTable("app_rollouts")
          .set({ status: "ACTIVE", paused_at: null, paused_reason: null })
          .where("id", "=", id)
          .where("status", "=", "PAUSED")
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) === 0) return false;
        await trx
          .updateTable("environment_updates")
          .set({ status: "PENDING", error: null, started_at: null, finished_at: null })
          .where("rollout_id", "=", id)
          .where("status", "=", "FAILED")
          .execute();
        return true;
      });
    },
    async complete(id: string): Promise<void> {
      await db.updateTable("app_rollouts").set({ status: "COMPLETE" }).where("id", "=", id)
        .where("status", "=", "ACTIVE").execute();
    },
    /** PENDING and APPLYING updates of the rollout. */
    openCount: async (rolloutId: string): Promise<number> =>
      Number(
        (
          await db
            .selectFrom("environment_updates")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("rollout_id", "=", rolloutId)
            .where("status", "in", OPEN)
            .executeTakeFirstOrThrow()
        ).n,
      ),
    countsByStatus: async (rolloutId: string): Promise<{ status: UpdateStatus; count: number }[]> =>
      (
        await db
          .selectFrom("environment_updates")
          .select((eb) => ["status", eb.fn.countAll<string>().as("n")])
          .where("rollout_id", "=", rolloutId)
          .groupBy("status")
          .orderBy("status")
          .execute()
      ).map((r) => ({ status: r.status, count: Number(r.n) })),

    update: (id: string): Promise<EnvironmentUpdates | null> =>
      first(db.selectFrom("environment_updates").selectAll().where("id", "=", id).executeTakeFirst()),
    /** The environment's row of a rollout (there is at most one). */
    updateFor: (rolloutId: string, environmentId: string): Promise<EnvironmentUpdates | null> =>
      first(updates().where("rollout_id", "=", rolloutId).where("environment_id", "=", environmentId).executeTakeFirst()),
    /** The environment's newest row without a rollout to `toVersion` that is not SUPERSEDED. */
    unrolledUpdate: (environmentId: string, toVersion: string): Promise<EnvironmentUpdates | null> =>
      first(
        updates()
          .where("environment_id", "=", environmentId)
          .where("rollout_id", "is", null)
          .where("to_version", "=", toVersion)
          .where("status", "!=", "SUPERSEDED")
          .executeTakeFirst(),
      ),
    /** The environment's newest PENDING or APPLYING row other than `exceptId`. */
    openExcept: (environmentId: string, exceptId: string | null): Promise<EnvironmentUpdates | null> => {
      let q = updates().where("environment_id", "=", environmentId).where("status", "in", OPEN);
      if (exceptId !== null) q = q.where("id", "!=", exceptId);
      return first(q.executeTakeFirst());
    },
    /** Whether another environment of the app has an APPLYING update. */
    anotherApplying: async (appId: string, environmentId: string): Promise<boolean> =>
      (await db
        .selectFrom("environment_updates")
        .select("id")
        .where("app_id", "=", appId)
        .where("environment_id", "!=", environmentId)
        .where("status", "=", "APPLYING")
        .executeTakeFirst()) !== undefined,
    applyingOf: (appId: string): Promise<EnvironmentUpdates[]> =>
      updates().where("app_id", "=", appId).where("status", "=", "APPLYING").execute(),
    pendingOf: (appId: string): Promise<EnvironmentUpdates[]> =>
      updates().where("app_id", "=", appId).where("status", "=", "PENDING").execute(),
    /** The environment's newest row that is not SUPERSEDED. */
    latest: (environmentId: string): Promise<EnvironmentUpdates | null> =>
      first(updates().where("environment_id", "=", environmentId).where("status", "!=", "SUPERSEDED").executeTakeFirst()),
    /** Newest first. */
    history: (environmentId: string, limit: number): Promise<EnvironmentUpdates[]> =>
      updates().where("environment_id", "=", environmentId).limit(limit).execute(),

    async insertUpdate(row: EnvironmentUpdates): Promise<void> {
      await db.insertInto("environment_updates").values(row).execute();
    },
    async patchUpdate(id: string, patch: UpdatePatch): Promise<void> {
      await db.updateTable("environment_updates").set(patch).where("id", "=", id).execute();
    },
    /** APPLYING -> PENDING: an admitted update whose actions never went out. */
    async releaseApplying(id: string): Promise<void> {
      await db
        .updateTable("environment_updates")
        .set({ status: "PENDING", started_at: null })
        .where("id", "=", id)
        .where("status", "=", "APPLYING")
        .execute();
    },
    /** `from` (APPLYING unless given) -> SUCCEEDED or FAILED. */
    async finishUpdate(
      id: string,
      status: "SUCCEEDED" | "FAILED",
      error: string | null,
      now: string,
      from: UpdateStatus = "APPLYING",
    ): Promise<void> {
      await db
        .updateTable("environment_updates")
        .set({ status, error, finished_at: now })
        .where("id", "=", id)
        .where("status", "=", from)
        .execute();
    },
  };
}
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/rollout-db.test.ts && npm run tsc 2>&1 | tail -3 && npm run lint 2>&1 | grep rollout-db`
Expected: 8 tests PASS; nothing from `tsc` or `lint` about `rollout-db.ts`.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/rollout-db.ts subgraphs/vetra-licensing/__tests__/rollout-db.test.ts
git commit -m "feat(licensing): rollout and environment update row module" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: A gated app's CI build moves STAGING (4.1)

**Files:**
- Modify: `subgraphs/vetra-apps/service.ts` (`AppsDeps`, `ciRecordArtifact`)
- Modify: `subgraphs/vetra-apps/index.ts` (imports; before the observability namespace; the `deps` literal)
- Test: `subgraphs/vetra-apps/__tests__/ci-artifacts.test.ts` (appended describe)

**Interfaces:**
- Consumes: `releasePolicyOf(db, appId)` (Task 2).
- Produces: `AppsDeps.releasePolicy?: ((appId: string) => Promise<"AUTO" | "GATED">) | null`. `ciRecordArtifact`'s return value is unchanged.

- [ ] **Step 1: Write the failing test.** Append to `subgraphs/vetra-apps/__tests__/ci-artifacts.test.ts`:

```ts
describe("ciRecordArtifact under a release policy (spec 4.1)", () => {
  const channelOf = (docs: ReturnType<typeof fakeDocs>) =>
    docs.executed[0]!.actions.find((a) => a.type === "SET_ARTIFACT_CHANNEL")?.input as
      | { channel: string; version: string }
      | undefined;

  it("moves STAGING instead of LATEST for a gated App's FUSION image", async () => {
    const app = await seedActiveApp(h);
    const docs = fakeDocs(new Set([app.id]));
    h.deps.docs = docs;
    const asked: string[] = [];
    h.deps.releasePolicy = async (id) => {
      asked.push(id);
      return "GATED";
    };
    await ciRecordArtifact(h.deps, ci(), input({ appId: app.id, channel: "LATEST" }));
    expect(asked).toStrictEqual([app.id]);
    expect(channelOf(docs)).toMatchObject({ channel: "STAGING", version: "1.2.3" });
  });

  it("leaves every other combination as it was", async () => {
    const app = await seedActiveApp(h);
    h.deps.releasePolicy = async () => "GATED";
    for (const [over, want] of [
      [{ channel: "DEV" }, "DEV"],
      [{ channel: "STAGING" }, "STAGING"],
      [{ kind: "PACKAGE", channel: "LATEST", reference: "https://registry.vetra.io/p" }, "LATEST"],
    ] as const) {
      const docs = fakeDocs(new Set([app.id]));
      h.deps.docs = docs;
      await ciRecordArtifact(h.deps, ci(), input({ appId: app.id, ...over }));
      expect(channelOf(docs)?.channel).toBe(want);
    }
    const docs = fakeDocs(new Set([app.id]));
    h.deps.docs = docs;
    h.deps.releasePolicy = async () => "AUTO";
    await ciRecordArtifact(h.deps, ci(), input({ appId: app.id, channel: "LATEST" }));
    expect(channelOf(docs)?.channel).toBe("LATEST");
  });

  it("asks for the policy only when a channel could move, and fails loudly when it cannot be read", async () => {
    const app = await seedActiveApp(h);
    h.deps.docs = fakeDocs(new Set([app.id]));
    let asked = 0;
    h.deps.releasePolicy = async () => {
      asked++;
      throw new Error("licensing db down");
    };
    await ciRecordArtifact(h.deps, ci(), input({ appId: app.id }));
    expect(asked).toBe(0);
    await expect(
      ciRecordArtifact(h.deps, ci(), input({ appId: app.id, channel: "LATEST" })),
    ).rejects.toThrow("licensing db down");
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-apps/__tests__/ci-artifacts.test.ts`
Expected: the first new test FAILS (`expected [] to strictly equal [ '<app id>' ]`); the third FAILS (the promise resolves). Requires the `pnpm install` from "Before You Start"; without it the file does not load at all.

- [ ] **Step 3: Redirect the channel, and wire the policy.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-apps/service.ts b/subgraphs/vetra-apps/service.ts
--- a/subgraphs/vetra-apps/service.ts
+++ b/subgraphs/vetra-apps/service.ts
@@ -184,6 +184,12 @@ export interface AppsDeps {
     | null;
   /** Called after a deployment row changes state (GitHub feedback). Best effort. */
   onDeploymentChanged?: (deploymentId: string) => Promise<void>;
+  /**
+   * The App's release policy (vetra-licensing's app_release_settings, through
+   * releasePolicyOf). GATED: a FUSION image CI aims at LATEST moves STAGING
+   * instead. Absent: every App is AUTO, as before.
+   */
+  releasePolicy?: ((appId: string) => Promise<"AUTO" | "GATED">) | null;
   /** Called after a preview was removed (sticky PR comment → Removed). Best effort. */
   onPreviewRemoved?: (
     app: AppRow,
@@ -4559,6 +4565,17 @@ export async function ciRecordArtifact(
     throw appsError("BAD_USER_INPUT", "channel must be DEV, STAGING or LATEST");
   if (!deps.docs) throw notConfigured("The App document store");
 
+  // A gated App's build reaches customers only when its publisher promotes
+  // it (spec 4.1): a FUSION image aimed at LATEST moves STAGING, which the
+  // App's canary environments follow. Any other kind or channel is unchanged.
+  const requested = input.channel ?? null;
+  const channel =
+    requested === "LATEST" &&
+    input.kind === "FUSION_IMAGE" &&
+    (await deps.releasePolicy?.(app.id)) === "GATED"
+      ? "STAGING"
+      : requested;
+
   const actions: Action[] = [
     recordArtifactVersion({
       kind: input.kind,
@@ -4570,12 +4587,12 @@ export async function ciRecordArtifact(
       publishedAt: deps.now().toISOString(),
     }),
   ];
-  if (input.channel != null) {
+  if (channel !== null) {
     actions.push(
       setArtifactChannel({
         kind: input.kind,
         name: input.name.trim(),
-        channel: input.channel,
+        channel,
         version: input.version.trim(),
       }),
     );
@@ -4590,7 +4607,8 @@ export async function ciRecordArtifact(
 
   deps.logger.info(
     `[vetra-apps] App ${app.slug}: recorded ${input.kind} ${input.name}@${input.version}` +
-      (input.channel ? ` and pointed ${input.channel} at it` : ""),
+      (channel ? ` and pointed ${channel} at it` : "") +
+      (channel !== requested ? ` (the App is gated; ${requested} moves on promotion)` : ""),
   );
   return { appId: app.id, recorded: true as const };
 }
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-apps/index.ts b/subgraphs/vetra-apps/index.ts
--- a/subgraphs/vetra-apps/index.ts
+++ b/subgraphs/vetra-apps/index.ts
@@ -33,6 +33,7 @@ import {
   reactorLedgerSource,
 } from "../vetra-licensing/licensing-ledger.js";
 import type { VetraLicensingDB } from "../vetra-licensing/db/schema.js";
+import { releasePolicyOf } from "../vetra-licensing/rollout-db.js";
 import {
   DRIFT_INTERVAL_MS,
   reportAppDocumentDrift,
@@ -126,6 +127,24 @@ export class VetraAppsSubgraph extends BaseSubgraph {
       }
     });
 
+    // The release policy lives beside the ledger, in the "vetra-licensing"
+    // namespace: a gated App's CI build moves STAGING, not LATEST. Opened on
+    // first use and retried after a failure, like the ledger; releasePolicyOf
+    // reads AUTO until that subgraph has created its tables.
+    let releaseDb: Promise<Kysely<VetraLicensingDB>> | null = null;
+    const releasePolicy = (appId: string) => {
+      releaseDb ??= this.relationalDb
+        .createNamespace("vetra-licensing")
+        .then((d) => d as unknown as Kysely<VetraLicensingDB>);
+      return releaseDb.then(
+        (d) => releasePolicyOf(d, appId),
+        (err: unknown) => {
+          releaseDb = null;
+          throw err;
+        },
+      );
+    };
+
     // Organisation moves of envs are announced in the observability namespace
     // (its tables are created by that subgraph; until it has booted a move
     // fails and is retried on the next read).
@@ -188,6 +207,7 @@ export class VetraAppsSubgraph extends BaseSubgraph {
         appLedger,
         console,
       ),
+      releasePolicy,
     };
     deps.onDeploymentChanged = (id) => reportDeploymentToGithub(deps, id);
     // A Studio launch/rollback is applied right after it was recorded (the
PATCH
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-apps/__tests__/ci-artifacts.test.ts subgraphs/vetra-apps/__tests__/ci.test.ts && npm run tsc 2>&1 | tail -3`
Expected: PASS, including every existing `ciRecordArtifact` test (no `releasePolicy` dep: AUTO); `tsc` clean.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-apps/service.ts subgraphs/vetra-apps/index.ts subgraphs/vetra-apps/__tests__/ci-artifacts.test.ts
git commit -m "feat(apps): a gated App's CI build moves STAGING instead of LATEST" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 4: A canary chain resolves on its own channel (4.2)

**Files:**
- Modify: `subgraphs/vetra-licensing/artifact-resolution.ts` (`resolveTemplateArtifacts`)
- Create: `subgraphs/vetra-licensing/channel-override.ts`
- Modify: `subgraphs/vetra-licensing/chain-plan.ts` (`planChains` input `resolve`)
- Modify: `subgraphs/vetra-licensing/handler.ts` (`reconcileApp`, `runChain`, `apply`)
- Modify: `subgraphs/vetra-licensing/resolvers.ts` (`applyEnvironmentTemplate`)
- Test: `__tests__/artifact-resolution.test.ts`, `__tests__/chain-plan.test.ts`, `__tests__/handler.test.ts` (appended), `__tests__/channel-override.test.ts` (new)

**Interfaces:**
- Consumes: `LicenseEnvironments.channel_override` (Task 1).
- Produces: `resolveTemplateArtifacts(template, artifacts, channelOverride: string | null = null)`; `CANARY_CHANNEL = "STAGING"`; `resolveChainKind(app: AppDocView, kind: string | null, channel: string | null): KindResolution`; `planChains({ resolve(kind: string | null, root: string): PlanResolution, ... })` (a one-argument resolver still fits). Inside `handler.ts`: `type ChainResolver = (kind: string | null, root: string) => KindResolution`, passed to `runChain` and `apply`.

- [ ] **Step 1: Write the failing tests.** Append to `artifact-resolution.test.ts`, `chain-plan.test.ts` and `handler.test.ts`, and create `channel-override.test.ts`:

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/artifact-resolution.test.ts b/subgraphs/vetra-licensing/__tests__/artifact-resolution.test.ts
--- a/subgraphs/vetra-licensing/__tests__/artifact-resolution.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/artifact-resolution.test.ts
@@ -366,3 +366,37 @@ describe("rendering a resolved FUSION service", () => {
     });
   });
 });
+
+describe("resolveTemplateArtifacts on a channel override (a canary, spec 4.2)", () => {
+  const artifacts = catalogue(["1.0.0", "1.1.0"], [
+    { channel: "LATEST", version: "1.0.0" },
+    { channel: "STAGING", version: "1.1.0" },
+  ]);
+
+  it("resolves every service on the override channel and keeps the service's own channel", () => {
+    const resolved = resolveTemplateArtifacts(withImage(), artifacts, "STAGING");
+    expect(resolved.services[0]).toMatchObject({
+      artifactChannel: "LATEST",
+      resolvedVersion: "1.1.0",
+      resolvedRepository: "cr.vetra.io/app-dtbau/dtbau-psb",
+    });
+    // A service following DEV (or naming no channel) follows the override too.
+    expect(resolveTemplateArtifacts(withImage({ artifactChannel: "DEV" }), artifacts, "STAGING").services[0]!.resolvedVersion).toBe("1.1.0");
+    expect(resolveTemplateArtifacts(withImage({ artifactChannel: null }), artifacts, "STAGING").services[0]!.resolvedVersion).toBe("1.1.0");
+  });
+
+  it("hashes like the template's own resolution when both channels point at one version", () => {
+    const same = catalogue(["1.0.0"], [{ channel: "LATEST", version: "1.0.0" }, { channel: "STAGING", version: "1.0.0" }]);
+    expect(templateHash(resolveTemplateArtifacts(withImage(), same, "STAGING"))).toBe(
+      templateHash(resolveTemplateArtifacts(withImage(), same)),
+    );
+    expect(templateHash(resolveTemplateArtifacts(withImage(), artifacts, "STAGING"))).not.toBe(
+      templateHash(resolveTemplateArtifacts(withImage(), artifacts)),
+    );
+  });
+
+  it("refuses an override channel with no build, naming it", () => {
+    const latestOnly = catalogue(["1.0.0"], [{ channel: "LATEST", version: "1.0.0" }]);
+    expect(() => resolveTemplateArtifacts(withImage(), latestOnly, "STAGING")).toThrow(/has no STAGING build yet/);
+  });
+});
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/chain-plan.test.ts b/subgraphs/vetra-licensing/__tests__/chain-plan.test.ts
--- a/subgraphs/vetra-licensing/__tests__/chain-plan.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/chain-plan.test.ts
@@ -327,3 +327,24 @@ describe("planChains: app integrity", () => {
     expect(withApp(app, [L("l1")], [], true)).toStrictEqual(plan([L("l1")]));
   });
 });
+
+describe("planChains: per-chain resolution (a canary, spec 4.2)", () => {
+  it("resolves each chain's head with its root, so a canary chain can re-template alone", () => {
+    const seen: [string | null, string][] = [];
+    const canaryHash = (k: string | null, root: string): PlanResolution => {
+      seen.push([k, root]);
+      const r = resolve(k);
+      return r.ok && root === "l2" ? { ...r, templateHash: "h-pro-staging" } : r;
+    };
+    const steps = planChains({
+      licences: [L("l1", { stage: "e1" }), L("l2", { stage: "e2" })],
+      environments: [E("e1", "l1"), E("e2", "l2")],
+      resolve: canaryHash,
+      app: CLEAN,
+    });
+    expect(seen).toStrictEqual([["pro", "l1"], ["pro", "l2"]]);
+    expect(steps).toStrictEqual([
+      { kind: "provision", root: "l2", licence: L("l2", { stage: "e2" }), templateId: "t-pro", templateHash: "h-pro-staging", label: "Pro", environmentId: "e2" },
+    ]);
+  });
+});
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/handler.test.ts b/subgraphs/vetra-licensing/__tests__/handler.test.ts
--- a/subgraphs/vetra-licensing/__tests__/handler.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/handler.test.ts
@@ -822,3 +822,40 @@ describe("AppLicenseHandler", () => {
     });
   });
 });
+
+describe("AppLicenseHandler: canary chains (spec 4.2)", () => {
+  const fusionTemplate = {
+    ...tpl("ded", "DEDICATED"),
+    template: {
+      services: [{ id: "f", type: "FUSION", prefix: "sektar", artifactName: "host", artifactChannel: "LATEST", resolvedVersion: "1.0.0", resolvedRepository: "cr.vetra.io/p/host" }],
+      packages: [], size: null, baseDomain: null, packageRegistry: null,
+    },
+  };
+  const WITH_STAGING: AppDocView = {
+    ...APP,
+    templates: [fusionTemplate, tpl("sh", "SHARED")],
+    artifacts: [{
+      kind: "FUSION_IMAGE", name: "host",
+      versions: [{ version: "1.0.0", reference: "cr.vetra.io/p/host:1.0.0" }, { version: "1.1.0", reference: "cr.vetra.io/p/host:1.1.0" }],
+      channels: [{ channel: "LATEST", version: "1.0.0" }, { channel: "STAGING", version: "1.1.0" }],
+    }],
+  };
+
+  it("re-templates a canary onto STAGING and leaves a customer on the template's hash alone", async () => {
+    const h = harness(
+      {
+        app: async (id) => (id === "app-1" ? WITH_STAGING : null),
+        environments: async () => [
+          envRow({ environment_id: "e1", root_license_id: "l1", license_id: "l1", channel_override: "STAGING" }),
+          envRow({ environment_id: "e2", root_license_id: "l2", license_id: "l2" }),
+        ],
+      },
+      [lic("l1", { stage: "e1" }), lic("l2", { stage: "e2" })],
+    );
+    await h.handler.reconcileOnce();
+    expect(h.provisioned).toStrictEqual(["l1"]);
+    const input = vi.mocked(h.deps.provision).mock.calls[0]![0];
+    expect(input.template.services[0]).toMatchObject({ artifactChannel: "LATEST", resolvedVersion: "1.1.0" });
+    expect(input.templateHash).not.toBe("h-ded");
+  });
+});
PATCH
```

Create `subgraphs/vetra-licensing/__tests__/channel-override.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAppDocument, resolveKind } from "../app-reads.js";
import { CANARY_CHANNEL, resolveChainKind } from "../channel-override.js";

/** A parsed vetra-app document: a DEDICATED template whose FUSION service follows LATEST. */
function appWith(channels: { channel: string; version: string }[]) {
  const doc = {
    header: { id: "app-1", documentType: "powerhouse/vetra-app" },
    state: {
      global: {
        name: "Sektar", status: "ACTIVE",
        templates: [{
          id: "t", mode: "DEDICATED", size: null, baseDomain: null, packageRegistry: null, packages: [],
          services: [{ id: "f", type: "FUSION", prefix: "sektar", artifactName: "host", artifactChannel: "LATEST" }],
        }],
        terms: [{ id: "k", kind: "pro", label: "Pro", templateId: "t", validityDays: null, issuers: [], status: "ACTIVE" }],
        artifacts: [{
          kind: "FUSION_IMAGE", name: "host",
          versions: [
            { version: "1.0.0", reference: "cr.vetra.io/app-sektar/host:1.0.0" },
            { version: "1.1.0", reference: "cr.vetra.io/app-sektar/host:1.1.0" },
          ],
          channels,
        }],
      },
    },
  };
  const app = parseAppDocument(doc);
  if (!app) throw new Error("fixture did not parse");
  return { ...app, unverified: false };
}
const versionOf = (r: ReturnType<typeof resolveKind>) =>
  r.ok ? r.template.template.services[0]!.resolvedVersion : r.reason;

describe("resolveChainKind", () => {
  const both = appWith([{ channel: "LATEST", version: "1.0.0" }, { channel: "STAGING", version: "1.1.0" }]);

  it("is resolveKind for a chain without an override", () => {
    expect(resolveChainKind(both, "pro", null)).toStrictEqual(resolveKind(both, "pro"));
  });

  it("resolves a canary on STAGING, with its own hash", () => {
    const canary = resolveChainKind(both, "pro", CANARY_CHANNEL);
    const own = resolveKind(both, "pro");
    expect(versionOf(canary)).toBe("1.1.0");
    expect(versionOf(own)).toBe("1.0.0");
    expect(canary.ok && own.ok && canary.template.templateHash !== own.template.templateHash).toBe(true);
  });

  it("resolves a canary whose app has no LATEST build yet (a gated app's first release)", () => {
    const stagingOnly = appWith([{ channel: "STAGING", version: "1.1.0" }]);
    expect(resolveKind(stagingOnly, "pro").ok).toBe(false);
    expect(versionOf(resolveChainKind(stagingOnly, "pro", CANARY_CHANNEL))).toBe("1.1.0");
  });

  it("holds a canary whose channel has no build", () => {
    const latestOnly = appWith([{ channel: "LATEST", version: "1.0.0" }]);
    const r = resolveChainKind(latestOnly, "pro", CANARY_CHANNEL);
    expect(r).toStrictEqual({ ok: false, reason: expect.stringContaining("has no STAGING build yet") });
  });
});
```

- [ ] **Step 2: Run them and see them fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/{artifact-resolution,chain-plan,handler,channel-override}.test.ts`
Expected: `channel-override.test.ts` FAILS to load (`../channel-override.js`); the new artifact-resolution tests FAIL (`resolvedVersion` is `"1.0.0"`, expected `"1.1.0"`); the chain-plan test FAILS (`seen` holds `["pro", undefined]`); the handler canary test FAILS (`provisioned` is `[]`).

- [ ] **Step 3: Implement the override and pass each chain's root.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/artifact-resolution.ts b/subgraphs/vetra-licensing/artifact-resolution.ts
--- a/subgraphs/vetra-licensing/artifact-resolution.ts
+++ b/subgraphs/vetra-licensing/artifact-resolution.ts
@@ -21,10 +21,15 @@ const DEFAULT_CHANNEL = "LATEST";
  * Throws when a reference cannot be resolved. The caller holds the licence
  * rather than provisioning something arbitrary: an environment running last
  * week's image because this week's is missing is worse than one that waits.
+ *
+ * `channelOverride` (a canary's, spec 4.2) replaces every service's channel
+ * for the lookup only: the service keeps its own artifactChannel, so the hash
+ * of the result differs from the template's exactly when the versions do.
  */
 export function resolveTemplateArtifacts(
   template: TemplateShape,
   artifacts: AppArtifact[],
+  channelOverride: string | null = null,
 ): TemplateShape {
   const services = template.services.map((s) => {
     if (!s.artifactName) return s;
@@ -38,7 +43,7 @@ export function resolveTemplateArtifacts(
       );
     }
 
-    const channel = s.artifactChannel ?? DEFAULT_CHANNEL;
+    const channel = channelOverride ?? s.artifactChannel ?? DEFAULT_CHANNEL;
     const pointer = artifact.channels.find((c) => c.channel === channel);
     if (!pointer) {
       throw new UnresolvableArtifactError(
PATCH
```

Create `subgraphs/vetra-licensing/channel-override.ts`:

```ts
import { resolveKind, type AppDocView, type AppTemplateView, type KindResolution } from "./app-reads.js";
import { resolveTemplateArtifacts, templateNeedsArtifacts } from "./artifact-resolution.js";
import { templateHash } from "./template.js";

/** The channel a canary environment follows instead of its template's (spec 4.2). */
export const CANARY_CHANNEL = "STAGING";

/** The template with every artifact resolved on `channel`; a failure is its resolutionError, as for the template's own. */
function onChannel(t: AppTemplateView, app: AppDocView, channel: string): AppTemplateView {
  if (!templateNeedsArtifacts(t.template)) return t;
  try {
    const template = resolveTemplateArtifacts(t.template, app.artifacts, channel);
    return { ...t, template, templateHash: templateHash(template), resolutionError: null };
  } catch (err) {
    return { ...t, resolutionError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * resolveKind for one chain. A chain whose environment carries a channel
 * override (license_environments.channel_override: a canary) resolves every
 * artifact reference on that channel, and its hash is taken over that
 * resolved set, so it re-templates when the channel moves. Without one, this
 * is resolveKind.
 */
export function resolveChainKind(
  app: AppDocView,
  kind: string | null,
  channel: string | null,
): KindResolution {
  if (!channel) return resolveKind(app, kind);
  return resolveKind({ ...app, templates: app.templates.map((t) => onChannel(t, app, channel)) }, kind);
}
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/chain-plan.ts b/subgraphs/vetra-licensing/chain-plan.ts
--- a/subgraphs/vetra-licensing/chain-plan.ts
+++ b/subgraphs/vetra-licensing/chain-plan.ts
@@ -87,7 +87,8 @@ function appHold(app: PlanApp, holdUnverified: boolean): string | null {
 export function planChains(input: {
   licences: PlanLicence[];
   environments: PlanEnvironment[];
-  resolve(kind: string | null): PlanResolution;
+  /** A chain's head kind -> template; per chain, as a canary resolves on its own channel. */
+  resolve(kind: string | null, root: string): PlanResolution;
   /** Required: omitting the integrity of the app must not fail open. */
   app: PlanApp;
   holdUnverified?: boolean;
@@ -163,7 +164,7 @@ export function planChains(input: {
       }
     }
 
-    const r = input.resolve(head.kind);
+    const r = input.resolve(head.kind, root);
     if (!r.ok) {
       steps.push({ kind: "hold", root, reason: r.reason });
       continue;
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/handler.ts b/subgraphs/vetra-licensing/handler.ts
--- a/subgraphs/vetra-licensing/handler.ts
+++ b/subgraphs/vetra-licensing/handler.ts
@@ -1,5 +1,6 @@
 import type { LicensingConfig } from "./config.js";
-import { resolveKind, type AppDocView } from "./app-reads.js";
+import type { AppDocView, KindResolution } from "./app-reads.js";
+import { resolveChainKind } from "./channel-override.js";
 import {
   planChains,
   type ChainStep,
@@ -170,6 +171,9 @@ function rotate<T>(list: T[], offset: number): T[] {
 
 type ProvisionKind = "create" | "retemplate" | "repoint";
 
+/** A chain's head kind -> template, on the chain's channel override (spec 4.2). */
+type ChainResolver = (kind: string | null, root: string) => KindResolution;
+
 /**
  * AppLicenseHandler: licence -> app.terms[kind] -> app.templates[templateId]
  * -> by mode. Timer-driven, re-entrancy guarded, every app (and every step)
@@ -405,8 +409,11 @@ export class AppLicenseHandler {
       );
     }
     const environments = await this.timed(this.d.environments(appId), `environments of app ${appId}`);
-    const resolve = (kind: string | null): PlanResolution => {
-      const r = resolveKind(app, kind);
+    // A canary chain resolves every artifact on its own channel (spec 4.2).
+    const channelOf = new Map(environments.map((e) => [e.root_license_id, e.channel_override ?? null]));
+    const resolveFor: ChainResolver = (kind, root) => resolveChainKind(app, kind, channelOf.get(root) ?? null);
+    const resolve = (kind: string | null, root: string): PlanResolution => {
+      const r = resolveFor(kind, root);
       return r.ok
         ? {
             ok: true,
@@ -465,7 +472,7 @@ export class AppLicenseHandler {
     }
     const confirmedEnded = new Set<string>();
     for (const [root, group] of rotate([...groups], this.tickNo)) {
-      if (await this.runChain(app, root, group, provisionKind)) confirmedEnded.add(root);
+      if (await this.runChain(app, root, group, provisionKind, resolveFor)) confirmedEnded.add(root);
     }
     if (!held) {
       const after = await this.timed(this.d.environments(appId), `environments of app ${appId}`);
@@ -497,6 +504,7 @@ export class AppLicenseHandler {
     root: string,
     steps: ChainStep[],
     provisionKind: (step: Extract<ChainStep, { kind: "provision" }>) => ProvisionKind,
+    resolveFor: ChainResolver,
   ): Promise<boolean> {
     const appId = app.id;
     const key = `${appId}:${root}`;
@@ -528,7 +536,7 @@ export class AppLicenseHandler {
         this.retemplateBudget--;
         budgeted = true;
       }
-      const running = this.apply(app, step);
+      const running = this.apply(app, step, resolveFor);
       this.inFlight.add(key);
       const settled = () => this.inFlight.delete(key);
       void running.then(settled, settled);
@@ -603,7 +611,7 @@ export class AppLicenseHandler {
     return out;
   }
 
-  private async apply(app: AppDocView, step: ChainStep): Promise<void> {
+  private async apply(app: AppDocView, step: ChainStep, resolveFor: ChainResolver): Promise<void> {
     switch (step.kind) {
       case "hold":
       case "anomaly":
@@ -619,9 +627,9 @@ export class AppLicenseHandler {
         await this.d.onResumed(app.id, step.environmentId);
         return;
       case "provision": {
-        // The same app snapshot the plan resolved from: the planner only
-        // emits a provision for a kind that resolved.
-        const resolved = resolveKind(app, step.licence.kind);
+        // The same app snapshot (and channel) the plan resolved from: the
+        // planner only emits a provision for a kind that resolved.
+        const resolved = resolveFor(step.licence.kind, step.root);
         if (!resolved.ok) {
           throw new Error(`kind ${step.licence.kind ?? "(none)"} no longer resolves: ${resolved.reason}`);
         }
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/resolvers.ts b/subgraphs/vetra-licensing/resolvers.ts
--- a/subgraphs/vetra-licensing/resolvers.ts
+++ b/subgraphs/vetra-licensing/resolvers.ts
@@ -1,5 +1,6 @@
 import { resolveCallerApp, type AuthContext, type AuthDeps } from "./auth.js";
 import { resolveKind, type AppReads } from "./app-reads.js";
+import { resolveChainKind } from "./channel-override.js";
 import type { LicensingConfig } from "./config.js";
 import type { LicenseEnvironments } from "./db/schema.js";
 import { normaliseUserDid } from "./did.js";
@@ -285,6 +286,10 @@ export function createResolvers(deps: ResolverDeps): Record<string, unknown> {
               `licence ${licence.id} is not the newest licence of its chain; upgrade the newest licence`,
             );
           }
+          // As the handler: a canary chain resolves on its own channel (spec 4.2).
+          const channel = (await deps.envRows.forApp(appId)).find((e) => e.root_license_id === root)?.channel_override ?? null;
+          const chained = channel ? resolveChainKind(app, licence.kind, channel) : r;
+          if (!chained.ok) throw new InvalidPublisherInputError(chained.reason);
           try {
             const row = await deps.provision(
               {
@@ -293,10 +298,10 @@ export function createResolvers(deps: ResolverDeps): Record<string, unknown> {
                 licenseId: licence.id,
                 // The grant row's holder, never the document's.
                 userDid: licence.userDid,
-                templateId: r.template.id,
-                template: r.template.template,
-                templateHash: r.template.templateHash,
-                fusionVersions: r.template.fusionVersions,
+                templateId: chained.template.id,
+                template: chained.template.template,
+                templateHash: chained.template.templateHash,
+                fusionVersions: chained.template.fusionVersions,
                 // As the handler: the project name chosen at issue wins.
                 label: (await deps.grants.chainLabel(root)) ?? a.input.label,
                 now: deps.now(),
PATCH
```

- [ ] **Step 4: Run them and see them pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/{artifact-resolution,chain-plan,handler,channel-override,resolvers,reference-handler,handler-reactor.integration}.test.ts && npm run tsc 2>&1 | tail -3`
Expected: all PASS (the existing handler, planner, machine-API and reactor-backed tests unchanged); `tsc` clean.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/{artifact-resolution,channel-override,chain-plan,handler,resolvers}.ts subgraphs/vetra-licensing/__tests__/{artifact-resolution,chain-plan,handler,channel-override}.test.ts
git commit -m "feat(licensing): a canary chain resolves its template on STAGING" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 5: The floor's FUSION version modes

**Files:**
- Modify: `subgraphs/vetra-licensing/template.ts` (before `FloorUpdateRenderInput`; `FloorUpdateRenderInput`; `floorFusionActions`; `renderFloorUpdateActions`)
- Test: `subgraphs/vetra-licensing/__tests__/template.test.ts` (import line, appended describe)

**Interfaces:**
- Consumes: `validateTemplate`, `isFusionUpgrade`, `isFusionStranded` (same file).
- Produces: `type FusionVersionMode = "floor" | "hold" | "force"`; `interface FusionMove { artifactName: string | null; from: string; to: string; stranded: boolean }`; `fusionMoveOf(template: TemplateShape, current: VetraCloudEnvironmentState, fusionVersions?: readonly string[]): FusionMove | null`; `FloorUpdateRenderInput.fusionVersion?: FusionVersionMode` (default `"floor"`, today's behaviour).

- [ ] **Step 1: Write the failing test.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/template.test.ts b/subgraphs/vetra-licensing/__tests__/template.test.ts
--- a/subgraphs/vetra-licensing/__tests__/template.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/template.test.ts
@@ -11,6 +11,7 @@ import {
   renderFloorUpdateActions,
   isVersionUpgrade,
   isFusionUpgrade,
+  fusionMoveOf,
   templateHash,
   validateTemplate,
   MissingPackageNameError,
@@ -731,3 +732,62 @@ describe("renderCreateActions without an owner", () => {
     expect(cfg.input.env).toContainEqual({ name: "ADMINS", value: "", isSecret: false });
   });
 });
+
+describe("the floor's FUSION version modes and fusionMoveOf (spec 4.3)", () => {
+  const SHA_A = "sha-56e1fd7497fc";
+  const SHA_B = "sha-6141b974fc38";
+  const shaTemplate: TemplateShape = {
+    ...template,
+    size: null,
+    services: [
+      ...template.services,
+      { id: "f", type: "FUSION", prefix: "sektar", artifactName: "app", artifactChannel: "LATEST", resolvedRepository: "registry/app", resolvedVersion: SHA_B },
+    ],
+  };
+  const onFusion = (version: string | null): VetraCloudEnvironmentState => {
+    const current = deployedState();
+    current.services.push({ ...enabled("FUSION", "sektar"), version });
+    current.fusion = { image: "registry/app", env: [], autoUpdate: false, autoUpdateTagPattern: null };
+    return current;
+  };
+  const render = (current: VetraCloudEnvironmentState, fusionVersions: string[] | undefined, fusionVersion?: "floor" | "hold" | "force") =>
+    types(renderFloorUpdateActions({ template: shaTemplate, current, fusionVersions, fusionVersion }));
+
+  it("names the move the floor would make, and whether it cannot order it", () => {
+    expect(fusionMoveOf(shaTemplate, onFusion(SHA_A), [SHA_A, SHA_B])).toStrictEqual({ artifactName: "app", from: SHA_A, to: SHA_B, stranded: false });
+    expect(fusionMoveOf(shaTemplate, onFusion(SHA_A), [SHA_B])).toStrictEqual({ artifactName: "app", from: SHA_A, to: SHA_B, stranded: true });
+  });
+
+  it("names no move when the version is current, newer, unordered, missing, or not FUSION", () => {
+    expect(fusionMoveOf(shaTemplate, onFusion(SHA_B), [SHA_A, SHA_B])).toBeNull();
+    expect(fusionMoveOf(shaTemplate, onFusion(SHA_A), [SHA_B, SHA_A])).toBeNull();
+    expect(fusionMoveOf(shaTemplate, onFusion(SHA_A), undefined)).toBeNull();
+    expect(fusionMoveOf(shaTemplate, onFusion(null), [SHA_A, SHA_B])).toBeNull();
+    expect(fusionMoveOf(template, deployedState())).toBeNull();
+  });
+
+  it("hold leaves the version where it is and applies everything else", () => {
+    const current = onFusion(SHA_A);
+    current.packages = [];
+    expect(render(current, [SHA_A, SHA_B], "hold")).toEqual(["ADD_PACKAGE", "APPROVE_CHANGES"]);
+    expect(render(onFusion(SHA_A), [SHA_A, SHA_B], "hold")).toEqual([]);
+    // A service with no version yet still gets one: nothing runs to protect.
+    expect(render(onFusion(null), [SHA_A, SHA_B], "hold")).toEqual(["SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
+  });
+
+  it("force sets a version the floor cannot order, and never one provably older", () => {
+    const held = vi.fn();
+    expect(types(renderFloorUpdateActions({ template: shaTemplate, current: onFusion(SHA_A), fusionVersions: [SHA_B], fusionVersion: "force", onFusionHeld: held })))
+      .toEqual(["SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
+    expect(held).not.toHaveBeenCalled();
+    expect(render(onFusion(SHA_A), [SHA_A, SHA_B], "force")).toEqual(["SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
+    // Current recorded after the template's: a downgrade, refused even forced.
+    expect(render(onFusion(SHA_A), [SHA_B, SHA_A], "force")).toEqual([]);
+    expect(render(onFusion(SHA_B), [SHA_A, SHA_B], "force")).toEqual([]);
+    const semver: TemplateShape = {
+      ...shaTemplate,
+      services: shaTemplate.services.map((s) => (s.type === "FUSION" ? { ...s, resolvedVersion: "1.0.0" } : s)),
+    };
+    expect(types(renderFloorUpdateActions({ template: semver, current: onFusion("2.0.0"), fusionVersion: "force" }))).toEqual([]);
+  });
+});
PATCH
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/template.test.ts`
Expected: the new tests FAIL (`fusionMoveOf is not a function`; "hold" still emits `SET_SERVICE_VERSION`).

- [ ] **Step 3: Implement the modes.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/template.ts b/subgraphs/vetra-licensing/template.ts
--- a/subgraphs/vetra-licensing/template.ts
+++ b/subgraphs/vetra-licensing/template.ts
@@ -485,6 +485,45 @@ export function isFusionStranded(
   return !recorded.includes(current) && recorded.includes(wanted);
 }
 
+/**
+ * What the floor does with a live environment's FUSION version (spec 4.3):
+ * "floor" moves it only up (isFusionUpgrade); "hold" leaves it (a gated
+ * update not yet due); "force" also sets a version the floor cannot order
+ * (isFusionStranded; the publisher's forceEnvironmentUpdate), but never one
+ * provably older than the current.
+ */
+export type FusionVersionMode = "floor" | "hold" | "force";
+
+/** A FUSION version move the floor would make on a live environment (fusionMoveOf). */
+export interface FusionMove {
+  /** The app artifact the template's FUSION service runs. */
+  artifactName: string | null;
+  from: string;
+  to: string;
+  /** The record lists `to` but not `from`: the floor cannot prove `from` older (isFusionStranded). */
+  stranded: boolean;
+}
+
+/**
+ * The FUSION version move the floor would make, or null when it moves none:
+ * the template runs no FUSION, the service has no version yet (the floor
+ * sets one; nothing is updated), the version is current, or it is newer or
+ * cannot be ordered at all. Pure; the template must validate.
+ */
+export function fusionMoveOf(
+  template: TemplateShape,
+  current: VetraCloudEnvironmentState,
+  fusionVersions?: readonly string[],
+): FusionMove | null {
+  const wanted = validateTemplate(template).services.find((s) => s.type === "FUSION")?.version;
+  const from = current.services.find((s) => s.type === "FUSION")?.version ?? null;
+  if (!wanted || from === null) return null;
+  const artifactName = template.services.find((s) => s.type === "FUSION")?.artifactName ?? null;
+  if (isFusionUpgrade(from, wanted, fusionVersions)) return { artifactName, from, to: wanted, stranded: false };
+  if (isFusionStranded(from, wanted, fusionVersions)) return { artifactName, from, to: wanted, stranded: true };
+  return null;
+}
+
 export interface FloorUpdateRenderInput {
   template: TemplateShape;
   /** The environment's current global state, as EnvGateway.getState returns it. */
@@ -503,6 +542,8 @@ export interface FloorUpdateRenderInput {
    * wanted version but not the current one (see isFusionStranded).
    */
   onFusionHeld?: (held: { current: string; wanted: string }) => void;
+  /** What to do with the FUSION version (FusionVersionMode); default "floor". */
+  fusionVersion?: FusionVersionMode;
 }
 
 /**
@@ -532,6 +573,7 @@ function floorFusionActions(
   includedKey: boolean,
   fusionVersions: readonly string[] | undefined,
   onFusionHeld: FloorUpdateRenderInput["onFusionHeld"],
+  mode: FusionVersionMode,
 ): Action[] {
   const { repository, version } = s;
   const actions: Action[] = [];
@@ -554,9 +596,17 @@ function floorFusionActions(
     );
   }
   const currentVersion = have?.version ?? null;
-  if (currentVersion === null || isFusionUpgrade(currentVersion, version, fusionVersions)) {
+  if (currentVersion === null) {
+    actions.push(setServiceVersion({ type: "FUSION", version }));
+  } else if (mode !== "hold" && isFusionUpgrade(currentVersion, version, fusionVersions)) {
+    actions.push(setServiceVersion({ type: "FUSION", version }));
+  } else if (
+    mode === "force" &&
+    currentVersion !== version &&
+    !isFusionUpgrade(version, currentVersion, fusionVersions)
+  ) {
     actions.push(setServiceVersion({ type: "FUSION", version }));
-  } else if (isFusionStranded(currentVersion, version, fusionVersions)) {
+  } else if (mode === "floor" && isFusionStranded(currentVersion, version, fusionVersions)) {
     onFusionHeld?.({ current: currentVersion, wanted: version });
   }
   return actions;
@@ -588,6 +638,7 @@ export function renderFloorUpdateActions(input: FloorUpdateRenderInput): Action[
           input.includedKey === true,
           input.fusionVersions,
           input.onFusionHeld,
+          input.fusionVersion ?? "floor",
         ),
       );
     }
PATCH
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/template.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 81 tests PASS (every existing floor test unchanged: the default mode is `"floor"`).

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/template.ts subgraphs/vetra-licensing/__tests__/template.test.ts
git commit -m "feat(licensing): floor update can hold or force the FUSION version, never downgrade it" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 6: The release gate decision

**Files:**
- Create: `subgraphs/vetra-licensing/release-gate.ts`
- Test: `subgraphs/vetra-licensing/__tests__/release-gate.test.ts`

**Interfaces:**
- Consumes: `AppRollouts`, `EnvironmentUpdates`, `ReleasePolicy` (Task 1); `FusionMove`, `FusionVersionMode` (Task 5).
- Produces: `interface GateInput { policy; canary: boolean; move: FusionMove; rollout: AppRollouts | null; existing: EnvironmentUpdates | null; open: EnvironmentUpdates | null; otherApplying: boolean; environmentId: string; appId: string; newId: string; now: string }`; `type GateWrite = { kind: "insert"; row: EnvironmentUpdates } | { kind: "start"; id } | { kind: "supersede"; id } | { kind: "note"; id; error }`; `interface GateDecision { version: FusionVersionMode; updateId: string | null; writes: GateWrite[]; reason: string | null }`; `decideRelease(i: GateInput): GateDecision`; `strandedError(move: FusionMove): string`.

- [ ] **Step 1: Write the failing test.** Create `subgraphs/vetra-licensing/__tests__/release-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AppRollouts, EnvironmentUpdates } from "../db/schema.js";
import { decideRelease, strandedError, type GateInput } from "../release-gate.js";

const NOW = "2026-11-10T12:00:00.000Z";
const BEFORE = "2026-11-10T11:00:00.000Z";
const LATER = "2026-11-13T12:00:00.000Z";
const MOVE = { artifactName: "host", from: "1.0.0", to: "1.1.0", stranded: false };
const STRANDED = { artifactName: "host", from: "sha-aaaaaaaaaaaa", to: "sha-bbbbbbbbbbbb", stranded: true };

const rollout = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1", app_id: "a", artifact_name: "host", version: "1.1.0", status: "ACTIVE", apply_after: LATER,
  promoted_by: "0xp", promoted_at: BEFORE, paused_at: null, paused_reason: null, ...over,
});
const row = (over: Partial<EnvironmentUpdates> = {}): EnvironmentUpdates => ({
  id: "u1", rollout_id: "r1", environment_id: "e1", app_id: "a", from_version: "1.0.0", to_version: "1.1.0",
  status: "PENDING", due_at: LATER, requested_at: null, started_at: null, finished_at: null, pre_update_dump_id: null,
  error: null, forced_at: null, created_at: BEFORE, ...over,
});
const gate = (over: Partial<GateInput> = {}) =>
  decideRelease({
    policy: "GATED", canary: false, move: MOVE, rollout: rollout(), existing: null, open: null, otherApplying: false,
    environmentId: "e1", appId: "a", newId: "new", now: NOW, ...over,
  });
const inserted = (d: ReturnType<typeof gate>) => d.writes.find((w) => w.kind === "insert")?.row;

describe("decideRelease: AUTO keeps today's behaviour", () => {
  it("moves at once and records the update APPLYING, with no rollout", () => {
    const d = gate({ policy: "AUTO", rollout: null });
    expect(d).toMatchObject({ version: "floor", updateId: "new", reason: null });
    expect(inserted(d)).toMatchObject({ id: "new", rollout_id: null, status: "APPLYING", started_at: NOW, due_at: NOW, from_version: "1.0.0", to_version: "1.1.0", error: null });
  });

  it("ignores another environment applying and moves on from an older update still applying", () => {
    const d = gate({ policy: "AUTO", rollout: null, otherApplying: true, open: row({ id: "old", to_version: "1.0.5", status: "APPLYING", rollout_id: null }) });
    expect(d.version).toBe("floor");
    expect(d.writes.map((w) => w.kind)).toStrictEqual(["supersede", "insert"]);
  });

  it("re-attempts after a settled update, and leaves one in flight to the tracker", () => {
    expect(inserted(gate({ policy: "AUTO", rollout: null, existing: row({ status: "FAILED", rollout_id: null }) }))?.status).toBe("APPLYING");
    expect(gate({ policy: "AUTO", rollout: null, existing: row({ status: "APPLYING", rollout_id: null }) })).toStrictEqual({ version: "floor", updateId: "u1", writes: [], reason: null });
  });
});

describe("decideRelease: a stranded version waits for the publisher (both policies)", () => {
  it("holds and records the update PENDING with the error", () => {
    const d = gate({ policy: "AUTO", rollout: null, move: STRANDED });
    expect(d.version).toBe("hold");
    expect(inserted(d)).toMatchObject({ status: "PENDING", started_at: null, error: strandedError(STRANDED) });
  });

  it("notes the error once on an existing update, not again", () => {
    const fresh = gate({ policy: "AUTO", rollout: null, move: STRANDED, existing: row({ rollout_id: null, to_version: STRANDED.to }) });
    expect(fresh.writes).toStrictEqual([{ kind: "note", id: "u1", error: strandedError(STRANDED) }]);
    const noted = gate({ policy: "AUTO", rollout: null, move: STRANDED, existing: row({ rollout_id: null, to_version: STRANDED.to, error: strandedError(STRANDED) }) });
    expect(noted.writes).toStrictEqual([]);
  });

  it("forces a forced one, past the hold", () => {
    const d = gate({ move: STRANDED, existing: row({ to_version: STRANDED.to, forced_at: NOW, requested_at: NOW }) });
    expect(d).toMatchObject({ version: "force", updateId: "u1", writes: [{ kind: "start", id: "u1" }] });
  });
});

describe("decideRelease: GATED customers", () => {
  it("holds a version that was never promoted, writing nothing", () => {
    expect(gate({ rollout: null })).toStrictEqual({ version: "hold", updateId: null, writes: [], reason: "1.1.0 has not been promoted" });
  });

  it("creates a PENDING update due at the end of the notice period", () => {
    const d = gate();
    expect(d).toMatchObject({ version: "hold", reason: `due at ${LATER}` });
    expect(inserted(d)).toMatchObject({ rollout_id: "r1", status: "PENDING", due_at: LATER, started_at: null });
  });

  it("supersedes a PENDING update of an older version and keeps its earlier deadline", () => {
    const d = gate({ open: row({ id: "older", rollout_id: "r0", to_version: "1.0.5", due_at: BEFORE }) });
    expect(d.writes[0]).toStrictEqual({ kind: "supersede", id: "older" });
    // The earlier deadline has passed: due, so it starts at once.
    expect(inserted(d)).toMatchObject({ due_at: BEFORE, status: "APPLYING" });
    expect(d.version).toBe("floor");
  });

  it("starts an update when it is due, or when the holder asked", () => {
    expect(gate({ existing: row({ due_at: BEFORE }) })).toMatchObject({ version: "floor", updateId: "u1", writes: [{ kind: "start", id: "u1" }] });
    expect(gate({ existing: row({ requested_at: NOW }) })).toMatchObject({ version: "floor", writes: [{ kind: "start", id: "u1" }] });
    expect(gate({ existing: row() })).toMatchObject({ version: "hold", writes: [], reason: `due at ${LATER}` });
  });

  it("holds while the rollout is paused, unless forced", () => {
    const paused = rollout({ status: "PAUSED" });
    expect(gate({ rollout: paused, existing: row({ due_at: BEFORE }) })).toMatchObject({ version: "hold", reason: "its rollout is paused" });
    expect(gate({ rollout: paused, existing: row({ forced_at: NOW, requested_at: NOW }) }).version).toBe("floor");
  });

  it("holds while another environment of the app is updating, even forced", () => {
    expect(gate({ otherApplying: true, existing: row({ due_at: BEFORE }) })).toMatchObject({ version: "hold", reason: "another environment of the app is updating" });
    expect(gate({ otherApplying: true, existing: row({ forced_at: NOW }) }).version).toBe("hold");
  });

  it("holds while its own earlier update is still applying", () => {
    expect(gate({ open: row({ id: "older", to_version: "1.0.5", status: "APPLYING" }), existing: row({ due_at: BEFORE }) }))
      .toMatchObject({ version: "hold", writes: [], reason: "its update to 1.0.5 is still applying" });
  });

  it("keeps a FAILED update failed until the rollout is resumed", () => {
    expect(gate({ existing: row({ status: "FAILED", due_at: BEFORE }) })).toMatchObject({ version: "hold", writes: [], reason: "its update to 1.1.0 is FAILED" });
  });
});

describe("decideRelease: GATED canaries", () => {
  it("need no rollout and are due at once", () => {
    const d = gate({ canary: true, rollout: null });
    expect(d).toMatchObject({ version: "floor", updateId: "new" });
    expect(inserted(d)).toMatchObject({ rollout_id: null, status: "APPLYING", due_at: NOW });
  });

  it("still wait for another environment of the app", () => {
    const d = gate({ canary: true, rollout: null, otherApplying: true });
    expect(d.version).toBe("hold");
    expect(inserted(d)).toMatchObject({ status: "PENDING", due_at: NOW });
    expect(gate({ canary: true, rollout: null, existing: row({ rollout_id: null, due_at: NOW }) }).writes).toStrictEqual([{ kind: "start", id: "u1" }]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release-gate.test.ts`
Expected: FAIL, `Failed to load url ../release-gate.js`.

- [ ] **Step 3: Write the decision.** Create `subgraphs/vetra-licensing/release-gate.ts`:

```ts
import type { AppRollouts, EnvironmentUpdates, ReleasePolicy } from "./db/schema.js";
import type { FusionMove, FusionVersionMode } from "./template.js";

/** Everything the gate decides from; the update-gate reads it under one transaction. */
export interface GateInput {
  policy: ReleasePolicy;
  /** The environment resolves on a channel override (a canary): no rollout gates it. */
  canary: boolean;
  move: FusionMove;
  /** GATED, not a canary: the ACTIVE or PAUSED rollout of move.to; null when it was never promoted. */
  rollout: AppRollouts | null;
  /**
   * This environment's row for this move: its row of `rollout`, or (canary,
   * AUTO) its newest row without a rollout to move.to that is not SUPERSEDED.
   */
  existing: EnvironmentUpdates | null;
  /** This environment's newest PENDING or APPLYING row other than `existing`. */
  open: EnvironmentUpdates | null;
  /** Another environment of the same app has an APPLYING update. */
  otherApplying: boolean;
  environmentId: string;
  appId: string;
  /** The id a row inserted by this decision gets. */
  newId: string;
  now: string;
}

export type GateWrite =
  | { kind: "insert"; row: EnvironmentUpdates }
  /** PENDING -> APPLYING, started now. */
  | { kind: "start"; id: string }
  | { kind: "supersede"; id: string }
  /** A PENDING row gets (or changes) its error: logged once, shown as "needs attention". */
  | { kind: "note"; id: string; error: string };

export interface GateDecision {
  version: FusionVersionMode;
  /** The update that is APPLYING for this move when the version is set; null when it is held. */
  updateId: string | null;
  writes: GateWrite[];
  /** Why the version waits; null when it moves. */
  reason: string | null;
}

/** The error a stranded move's update carries (and the keeper logs once per version). */
export function strandedError(move: FusionMove): string {
  return `FUSION ${move.from} is not in the app's record (it keeps the last 50 versions, or it was pinned by hand), so it cannot be proven older than ${move.to}; the publisher can force the update`;
}

const at = (iso: string): number => Date.parse(iso);
const earlier = (a: string, b: string | null): string => (b !== null && at(b) < at(a) ? b : a);

/**
 * Pure. May the keeper move this live environment's FUSION version now, and
 * which update rows record that (spec 4.3)?
 *
 * AUTO (the default) always moves, as the floor did before; it only records
 * an update, created APPLYING. GATED moves a customer only when its update is
 * PENDING and due (requested, or past due_at), its rollout ACTIVE and no
 * other update of the app APPLYING; a canary needs no rollout and is due at
 * once. A version the floor cannot order (stranded) waits for the
 * publisher's force under either policy, its update carrying the error. A
 * forced update skips the deadline, the pause and the stranded hold, never
 * the one-at-a-time rule. A new version supersedes a PENDING update of an
 * older one and keeps its earlier deadline (decision 9).
 */
export function decideRelease(i: GateInput): GateDecision {
  const gated = i.policy === "GATED";
  const rolledOut = gated && !i.canary;
  const writes: GateWrite[] = [];
  const hold = (reason: string): GateDecision => ({ version: "hold", updateId: null, writes, reason });

  if (i.open?.status === "APPLYING") {
    // Gated: one update at a time, so the earlier one settles first.
    if (gated) return hold(`its update to ${i.open.to_version} is still applying`);
    // AUTO moves on to the newer version, as the floor always has.
    writes.push({ kind: "supersede", id: i.open.id });
  }
  if (rolledOut && !i.rollout) return hold(`${i.move.to} has not been promoted`);

  const existing = i.existing;
  if (existing?.status === "APPLYING") {
    // In flight (a re-send after a crash is harmless): the tracker settles it.
    const version = existing.forced_at !== null && i.move.stranded ? "force" : "floor";
    return { version, updateId: existing.id, writes, reason: null };
  }
  if (existing && existing.status !== "PENDING" && gated) {
    // FAILED waits for resumeRollout or a force; anything else is settled.
    return hold(`its update to ${i.move.to} is ${existing.status}`);
  }

  const pending = existing?.status === "PENDING" ? existing : null;
  const forced = pending !== null && pending.forced_at !== null;
  const stranded = i.move.stranded ? strandedError(i.move) : null;
  const openPending = i.open?.status === "PENDING" ? i.open : null;
  const dueAt =
    pending?.due_at ??
    (rolledOut && i.rollout ? earlier(i.rollout.apply_after, openPending?.due_at ?? null) : i.now);

  let reason: string | null = null;
  if (stranded && !forced) {
    reason = stranded;
  } else if (gated) {
    const requested = pending !== null && pending.requested_at !== null;
    if (rolledOut && !forced && !requested && at(dueAt) > at(i.now)) reason = `due at ${dueAt}`;
    else if (rolledOut && !forced && i.rollout?.status !== "ACTIVE") reason = "its rollout is paused";
    else if (i.otherApplying) reason = "another environment of the app is updating";
  }

  if (!pending) {
    if (openPending) writes.push({ kind: "supersede", id: openPending.id });
    writes.push({
      kind: "insert",
      row: {
        id: i.newId,
        rollout_id: rolledOut && i.rollout ? i.rollout.id : null,
        environment_id: i.environmentId,
        app_id: i.appId,
        from_version: i.move.from,
        to_version: i.move.to,
        status: reason ? "PENDING" : "APPLYING",
        due_at: dueAt,
        requested_at: null,
        started_at: reason ? null : i.now,
        finished_at: null,
        pre_update_dump_id: null,
        error: stranded,
        forced_at: null,
        created_at: i.now,
      },
    });
    return reason ? hold(reason) : { version: "floor", updateId: i.newId, writes, reason: null };
  }
  if (reason) {
    if (stranded && !forced && pending.error !== stranded) writes.push({ kind: "note", id: pending.id, error: stranded });
    return hold(reason);
  }
  writes.push({ kind: "start", id: pending.id });
  return { version: stranded ? "force" : "floor", updateId: pending.id, writes, reason: null };
}
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release-gate.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 16 tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/release-gate.ts subgraphs/vetra-licensing/__tests__/release-gate.test.ts
git commit -m "feat(licensing): pure release gate decision" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 7: The update gate over the database

**Files:**
- Create: `subgraphs/vetra-licensing/update-gate.ts`
- Test: `subgraphs/vetra-licensing/__tests__/update-gate.test.ts`

**Interfaces:**
- Consumes: `createRolloutStore` / `RolloutStore` (Task 2), `decideRelease` (Task 6), `FusionMove`, `FusionVersionMode` (Task 5).
- Produces: `interface UpdateGate { admit(q: { row: LicenseEnvironments; move: FusionMove; now: string }): Promise<{ version: FusionVersionMode; updateId: string | null }>; release(updateId: string): Promise<void> }`; `createUpdateGate(deps: { store: RolloutStore; logger: Pick<Console, "warn">; newId?: () => string }): UpdateGate`. A stranded version is logged once, as `[licensing] environment <id> of chain <root> stays on FUSION <from>: <error>` (the wording the spec's open item searches the logs for).

- [ ] **Step 1: Write the failing test.** Create `subgraphs/vetra-licensing/__tests__/update-gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import { createRolloutStore, type RolloutStore } from "../rollout-db.js";
import { createUpdateGate, type UpdateGate } from "../update-gate.js";

const NOW = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-13T12:00:00.000Z";
const MOVE = { artifactName: "host", from: "1.0.0", to: "1.1.0", stranded: false };
const envRow = (over: Partial<LicenseEnvironments> = {}): LicenseEnvironments => ({
  environment_id: "e1", root_license_id: "l1", app_id: "a", user_did: "did:pkh:eip155:1:0x1", license_id: "l1",
  template_id: "t", label: null, template_hash: "h", channel_override: null, ended_at: null, stopped_at: null,
  delete_after: null, created_at: NOW, updated_at: NOW, ...over,
});

let db: Kysely<VetraLicensingDB>;
let store: RolloutStore;
let gate: UpdateGate;
let warn: ReturnType<typeof vi.fn>;
let n: number;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  store = createRolloutStore(db);
  warn = vi.fn();
  n = 0;
  gate = createUpdateGate({ store, logger: { warn }, newId: () => `u${++n}` });
});
afterEach(async () => { await db.destroy(); });

const gated = () => store.saveSettings({ appId: "a", policy: "GATED", defaultNoticeHours: 72 }, NOW);
const promote = (over: { apply_after?: string; status?: "ACTIVE" | "PAUSED" } = {}) =>
  store.promote({
    id: "r1", app_id: "a", artifact_name: "host", version: "1.1.0", status: over.status ?? "ACTIVE",
    apply_after: over.apply_after ?? LATER, promoted_by: "0xp", promoted_at: NOW, paused_at: null, paused_reason: null,
  });

describe("createUpdateGate", () => {
  it("records an AUTO app's update APPLYING and lets the floor move it", async () => {
    expect(await gate.admit({ row: envRow(), move: MOVE, now: NOW })).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({ rollout_id: null, status: "APPLYING", started_at: NOW, environment_id: "e1", app_id: "a" });
  });

  it("holds a gated customer until due, then starts it on a later admit", async () => {
    await gated();
    await promote();
    expect(await gate.admit({ row: envRow(), move: MOVE, now: NOW })).toStrictEqual({ version: "hold", updateId: null });
    expect(await store.updateFor("r1", "e1")).toMatchObject({ id: "u1", status: "PENDING", due_at: LATER });
    expect(await gate.admit({ row: envRow(), move: MOVE, now: LATER })).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({ status: "APPLYING", started_at: LATER });
    expect(await store.history("e1", 20)).toHaveLength(1);
  });

  it("starts only one environment of a gated app at a time", async () => {
    await gated();
    await promote({ apply_after: NOW });
    expect((await gate.admit({ row: envRow(), move: MOVE, now: NOW })).version).toBe("floor");
    const second = envRow({ environment_id: "e2", root_license_id: "l2" });
    expect((await gate.admit({ row: second, move: MOVE, now: NOW })).version).toBe("hold");
    expect(await store.updateFor("r1", "e2")).toMatchObject({ status: "PENDING" });
  });

  it("lets a canary of a gated app through without a rollout", async () => {
    await gated();
    expect(await gate.admit({ row: envRow({ channel_override: "STAGING" }), move: MOVE, now: NOW })).toStrictEqual({ version: "floor", updateId: "u1" });
    expect(await store.update("u1")).toMatchObject({ rollout_id: null, status: "APPLYING" });
  });

  it("logs a stranded version once, however often it is admitted", async () => {
    const stranded = { artifactName: "host", from: "sha-aaaaaaaaaaaa", to: "sha-bbbbbbbbbbbb", stranded: true };
    expect((await gate.admit({ row: envRow(), move: stranded, now: NOW })).version).toBe("hold");
    expect((await gate.admit({ row: envRow(), move: stranded, now: LATER })).version).toBe("hold");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/environment e1 of chain l1 stays on FUSION sha-aaaaaaaaaaaa: .*cannot be proven older than sha-bbbbbbbbbbbb/);
    expect(await store.history("e1", 20)).toHaveLength(1);
  });

  it("puts a released update back to PENDING", async () => {
    const { updateId } = await gate.admit({ row: envRow(), move: MOVE, now: NOW });
    await gate.release(updateId!);
    expect(await store.update(updateId!)).toMatchObject({ status: "PENDING", started_at: null });
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/update-gate.test.ts`
Expected: FAIL, `Failed to load url ../update-gate.js`.

- [ ] **Step 3: Write the gate.** Create `subgraphs/vetra-licensing/update-gate.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { LicenseEnvironments } from "./db/schema.js";
import { decideRelease } from "./release-gate.js";
import type { RolloutStore } from "./rollout-db.js";
import type { FusionMove, FusionVersionMode } from "./template.js";

/** What provisionChain asks before it moves a live environment's FUSION version (spec 4.3). */
export interface UpdateGate {
  /**
   * Decides (decideRelease) and records the update, in one transaction.
   * `updateId` is the update now APPLYING when the version moves.
   */
  admit(q: { row: LicenseEnvironments; move: FusionMove; now: string }): Promise<{
    version: FusionVersionMode;
    updateId: string | null;
  }>;
  /** An admitted update whose actions were never dispatched goes back to PENDING. */
  release(updateId: string): Promise<void>;
}

export function createUpdateGate(deps: {
  store: RolloutStore;
  logger: Pick<Console, "warn">;
  newId?: () => string;
}): UpdateGate {
  const newId = deps.newId ?? randomUUID;
  // Once per version: logged when the error is first written to the update.
  const warnHeld = (row: LicenseEnvironments, move: FusionMove, error: string) =>
    deps.logger.warn(
      `[licensing] environment ${row.environment_id} of chain ${row.root_license_id} stays on FUSION ${move.from}: ${error}`,
    );
  return {
    admit: ({ row, move, now }) =>
      deps.store.inTransaction(async (q) => {
        const policy = (await q.settings(row.app_id)).policy;
        const canary = (row.channel_override ?? null) !== null;
        const rolledOut = policy === "GATED" && !canary;
        const rollout =
          rolledOut && move.artifactName ? await q.openRollout(row.app_id, move.artifactName, move.to) : null;
        const existing = rolledOut
          ? rollout
            ? await q.updateFor(rollout.id, row.environment_id)
            : null
          : await q.unrolledUpdate(row.environment_id, move.to);
        const d = decideRelease({
          policy,
          canary,
          move,
          rollout,
          existing,
          open: await q.openExcept(row.environment_id, existing?.id ?? null),
          otherApplying: await q.anotherApplying(row.app_id, row.environment_id),
          environmentId: row.environment_id,
          appId: row.app_id,
          newId: newId(),
          now,
        });
        for (const w of d.writes) {
          if (w.kind === "insert") {
            await q.insertUpdate(w.row);
            if (w.row.error) warnHeld(row, move, w.row.error);
          } else if (w.kind === "start") {
            await q.patchUpdate(w.id, { status: "APPLYING", started_at: now });
          } else if (w.kind === "supersede") {
            await q.patchUpdate(w.id, { status: "SUPERSEDED", finished_at: now });
          } else {
            await q.patchUpdate(w.id, { error: w.error });
            warnHeld(row, move, w.error);
          }
        }
        return { version: d.version, updateId: d.updateId };
      }),
    release: (updateId) => deps.store.releaseApplying(updateId),
  };
}
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/update-gate.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/update-gate.ts subgraphs/vetra-licensing/__tests__/update-gate.test.ts
git commit -m "feat(licensing): update gate records every FUSION version move" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 8: provisionChain asks the gate, and a held version no longer marks the template applied (4.3)

**Files:**
- Modify: `subgraphs/vetra-licensing/environments.ts` (imports, `ChainEnvDeps`, new `ProvisionResult`, `provisionChain`'s live branch and tail, `provisionChainExclusive`)
- Test: `subgraphs/vetra-licensing/__tests__/environments.test.ts` (imports, the one stranded assertion, appended describe)

**Interfaces:**
- Consumes: `fusionMoveOf`, `FusionVersionMode` (Task 5), `UpdateGate` (Task 7).
- Produces: `ChainEnvDeps.updates?: UpdateGate`; `type ProvisionResult = LicenseEnvironments & { versionHeld?: true }`; `provisionChain(...)` and `provisionChainExclusive(...)` return `Promise<ProvisionResult>`. Without `deps.updates` the floor behaves as before, except that a stranded version no longer advances `template_hash`.

- [ ] **Step 1: Write the failing tests and change the one assertion that encoded the bug.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/environments.test.ts b/subgraphs/vetra-licensing/__tests__/environments.test.ts
--- a/subgraphs/vetra-licensing/__tests__/environments.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/environments.test.ts
@@ -13,6 +13,8 @@ import {
 } from "../environments.js";
 import { UNAPPLIED_TEMPLATE_HASH } from "../environments.js";
 import { createWarmPoolStore, type WarmPoolStore } from "../warm-pool-db.js";
+import { createRolloutStore } from "../rollout-db.js";
+import { createUpdateGate } from "../update-gate.js";
 import { renderCreateActions } from "../template.js";
 import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
 
@@ -249,7 +251,10 @@ describe("provisionChain moves a FUSION commit tag up by the app's recording ord
     states.set("env-1", liveOnShaA() as never);
     const row = await provisionChain(deps, input({ templateHash: "h2", template: shaTemplate, fusionVersions: [SHA_B] }));
     expect(executed).toHaveLength(1);
-    expect(row.template_hash).toBe("h2");
+    // Held, so not applied: the hash stays, and the next call retries (spec 4.3).
+    expect(row.template_hash).toBe("h1");
+    expect(row.versionHeld).toBe(true);
+    expect((await deps.rows.byRoot("l1"))!.template_hash).toBe("h1");
     expect(warn).toHaveBeenCalledOnce();
     const msg = String(warn.mock.calls[0]![0]);
     expect(msg).toContain("env-1");
@@ -613,3 +618,63 @@ describe("the included AI key (spec 3.11)", () => {
   });
 });
 
+
+describe("provisionChain asks the update gate before it moves a FUSION version (spec 4.3)", () => {
+  const REPO = "cr.vetra.io/app-sektar/host";
+  const v110 = {
+    services: [{ id: "h", type: "FUSION", prefix: "sektar", artifactName: "host", artifactChannel: "LATEST", resolvedRepository: REPO, resolvedVersion: "1.1.0" }],
+    packages: [{ id: "p", packageName: "@sektar/extra", version: "1.0.0" }], size: null, baseDomain: null, packageRegistry: null,
+  };
+  const liveOn100 = () => ({
+    status: "READY", owner: "0x1111111111111111111111111111111111111111", label: "My vault", packages: [],
+    services: [{ type: "FUSION", prefix: "sektar", enabled: true, version: "1.0.0", selectedRessource: null }],
+    fusion: { image: REPO, env: [{ name: "PH_HOST", value: "cli", isSecret: false }, { name: "ADMINS", value: "0x1111111111111111111111111111111111111111", isSecret: false }], autoUpdate: false, autoUpdateTagPattern: null },
+  });
+  const updates = () => createRolloutStore(db);
+  const live = async () => {
+    await provisionChain(deps, input());
+    states.set("env-1", liveOn100() as never);
+    executed.length = 0;
+  };
+
+  beforeEach(() => {
+    deps.updates = createUpdateGate({ store: createRolloutStore(db), logger: { warn: () => {} } });
+  });
+
+  it("an AUTO app moves the version as before, records the update and advances the hash", async () => {
+    await live();
+    const row = await provisionChain(deps, input({ templateHash: "h2", template: v110 }));
+    expect(executed[0]!.actions.map((a) => a.type)).toStrictEqual(["ADD_PACKAGE", "SET_SERVICE_VERSION", "APPROVE_CHANGES"]);
+    expect(row).toMatchObject({ template_hash: "h2" });
+    expect(row.versionHeld).toBeUndefined();
+    expect(await updates().latest("env-1")).toMatchObject({ status: "APPLYING", from_version: "1.0.0", to_version: "1.1.0", rollout_id: null });
+  });
+
+  it("a held version applies everything else, keeps the hash and repoints the row", async () => {
+    await updates().saveSettings({ appId: "app-1", policy: "GATED", defaultNoticeHours: 72 }, "2026-10-08T00:00:00.000Z");
+    await live();
+    const row = await provisionChain(deps, input({ licenseId: "l2", templateHash: "h2", template: v110 }));
+    expect(executed[0]!.actions.map((a) => a.type)).toStrictEqual(["ADD_PACKAGE", "APPROVE_CHANGES"]);
+    expect(row).toMatchObject({ template_hash: "h1", license_id: "l2", versionHeld: true });
+    expect(await deps.rows.byRoot("l1")).toMatchObject({ template_hash: "h1", license_id: "l2" });
+    // Not promoted: nothing recorded yet, and the next call (floor met) dispatches nothing.
+    expect(await updates().latest("env-1")).toBeNull();
+    states.get("env-1")!.packages = [{ registry: "r", name: "@sektar/extra", version: "1.0.0" }];
+    await provisionChain(deps, input({ licenseId: "l2", templateHash: "h2", template: v110 }));
+    expect(executed).toHaveLength(1);
+  });
+
+  it("puts an admitted update back to PENDING when its actions were not dispatched", async () => {
+    await live();
+    deps.envs.execute = async () => { throw new Error("reactor down"); };
+    await expect(provisionChain(deps, input({ templateHash: "h2", template: v110 }))).rejects.toThrow("reactor down");
+    expect(await updates().latest("env-1")).toMatchObject({ status: "PENDING", started_at: null });
+    expect((await deps.rows.byRoot("l1"))!.template_hash).toBe("h1");
+  });
+
+  it("never asks the gate for a new environment", async () => {
+    const admit = vi.spyOn(deps.updates!, "admit");
+    await provisionChain(deps, input({ template: v110 }));
+    expect(admit).not.toHaveBeenCalled();
+  });
+});
PATCH
```

- [ ] **Step 2: Run them and see them fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/environments.test.ts`
Expected: the changed stranded test FAILS (`expected 'h2' to be 'h1'`); the new describe FAILS (the GATED test sees `SET_SERVICE_VERSION` dispatched; `latest("env-1")` is `null` for AUTO).

- [ ] **Step 3: Ask the gate in provisionChain.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/environments.ts b/subgraphs/vetra-licensing/environments.ts
--- a/subgraphs/vetra-licensing/environments.ts
+++ b/subgraphs/vetra-licensing/environments.ts
@@ -9,11 +9,14 @@ import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";
 import { addressOfDid } from "./did.js";
 import { keyedMutex, LockTimeoutError, type AcquireOptions } from "./keyed-mutex.js";
 import {
+  fusionMoveOf,
   renderCreateActions,
   renderFloorUpdateActions,
   validateTemplate,
+  type FusionVersionMode,
   type TemplateShape,
 } from "./template.js";
+import type { UpdateGate } from "./update-gate.js";
 import type { WarmPoolStore, WarmRow } from "./warm-pool-db.js";
 
 export class AppEnvironmentCapReachedError extends Error {
@@ -168,8 +171,22 @@ export interface ChainEnvDeps {
   appKey?: (input: AppKeyInput) => Promise<boolean>;
   /** Releases an environment's included key (a failed claim); idempotent. */
   releaseAppKey?: (environmentId: string) => Promise<void>;
+  /**
+   * Records every FUSION version move of a live environment and decides
+   * whether it may happen now (spec 4.3). Absent: the floor moves it as it
+   * always has, and nothing is recorded.
+   */
+  updates?: UpdateGate;
 }
 
+/**
+ * provisionChain's row. `versionHeld`: the floor left the FUSION version
+ * where it is (a gated update not yet due, or a version it cannot order), so
+ * the template is not fully met and template_hash did not advance; the next
+ * tick provisions the chain again.
+ */
+export type ProvisionResult = LicenseEnvironments & { versionHeld?: true };
+
 export interface ProvisionChainInput {
   appId: string;
   root: string;
@@ -239,7 +256,7 @@ function assertSameOwner(row: LicenseEnvironments, input: ProvisionChainInput):
 export async function provisionChain(
   deps: ChainEnvDeps,
   input: ProvisionChainInput,
-): Promise<LicenseEnvironments> {
+): Promise<ProvisionResult> {
   const existing = await deps.rows.byRoot(input.root);
   if (existing) assertSameOwner(existing, input);
   if (existing && existing.template_hash === input.templateHash) {
@@ -344,12 +361,25 @@ export async function provisionChain(
   // A create carries the included key (spec 3.11); a live environment's key
   // was given when it was created or claimed.
   let actions: Action[];
+  // The FUSION version the floor would move, and what the gate allows.
+  let held = false;
+  let admitted: string | null = null;
   if (state.status !== "DRAFT") {
+    const move = fusionMoveOf(input.template, state, input.fusionVersions);
+    let fusionVersion: FusionVersionMode = "floor";
+    if (move && deps.updates) {
+      const gate = await deps.updates.admit({ row, move, now: input.now });
+      fusionVersion = gate.version;
+      admitted = gate.updateId;
+    }
+    held = move !== null && (fusionVersion === "hold" || (fusionVersion === "floor" && move.stranded));
     actions = renderFloorUpdateActions({
       template: input.template,
       current: state,
       fusionVersions: input.fusionVersions,
-      onFusionHeld: ({ current, wanted }) => {
+      fusionVersion,
+      // With a gate, the stranded version is recorded and logged once there.
+      onFusionHeld: deps.updates ? undefined : ({ current, wanted }) => {
         const msg = `[licensing] environment ${row.environment_id} of chain ${row.root_license_id} stays on FUSION ${current}: the app's record no longer lists it (only its last 50 versions are kept, or it was pinned by hand), so it cannot be proven older than ${wanted}; move it by hand if it should follow the template`;
         if (deps.logger?.warn) deps.logger.warn(msg);
         else (deps.logger ?? console).error(msg);
@@ -365,17 +395,32 @@ export async function provisionChain(
       includedKey: await writeIncludedKey(deps, row.environment_id, subdomain, row.root_license_id, input),
     });
   }
-  if (actions.length > 0) await deps.envs.execute(row.environment_id, actions);
+  if (actions.length > 0) {
+    try {
+      await deps.envs.execute(row.environment_id, actions);
+    } catch (err) {
+      // Nothing went out: the admitted update waits again.
+      if (admitted && deps.updates) {
+        await deps.updates.release(admitted).catch((releaseErr: unknown) => {
+          (deps.logger ?? console).error(
+            `[licensing] update ${admitted} of environment ${row.environment_id} was not dispatched and could not be released: ${String(releaseErr)}`,
+          );
+        });
+      }
+      throw err;
+    }
+  }
 
-  // The row's label is the one the environment was created with.
+  // The row's label is the one the environment was created with. A held
+  // version is not the template: the hash advances only once it is met.
   const patch = {
     license_id: input.licenseId,
     template_id: input.templateId,
-    template_hash: input.templateHash,
+    ...(held ? {} : { template_hash: input.templateHash }),
     updated_at: input.now,
   };
   await deps.rows.update(row.environment_id, patch);
-  return { ...row, ...patch };
+  return { ...row, ...patch, ...(held ? { versionHeld: true as const } : {}) };
 }
 
 /** The warm environment cannot be used; it is discarded and the chain built cold. */
@@ -599,6 +644,6 @@ export function provisionChainExclusive(
   deps: ChainEnvDeps,
   input: ProvisionChainInput,
   opts: AcquireOptions = {},
-): Promise<LicenseEnvironments> {
+): Promise<ProvisionResult> {
   return lockChain(input.root, () => provisionChain(deps, input), opts);
 }
PATCH
```

- [ ] **Step 4: Run them and see them pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/environments.test.ts subgraphs/vetra-licensing/__tests__/handler-reactor.integration.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 47 environments tests PASS; the reactor-backed handler test PASSES unchanged.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/environments.ts subgraphs/vetra-licensing/__tests__/environments.test.ts
git commit -m "fix(licensing): a held FUSION version no longer marks the template applied" -m "provisionChain asks the update gate before it moves a live environment's FUSION version; template_hash advances only once the template is met." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 9: The handler gives a held chain's budget back and runs release work

**Files:**
- Modify: `subgraphs/vetra-licensing/handler.ts` (imports, `HandlerDeps`, `reconcileApp`, `runChain`, `apply`)
- Test: `subgraphs/vetra-licensing/__tests__/handler.test.ts` (appended describe)

**Interfaces:**
- Consumes: `ProvisionResult` (Task 8).
- Produces: `HandlerDeps.provision(input): Promise<ProvisionResult>`; `HandlerDeps.afterChains?(app: AppDocView, environments: LicenseEnvironments[]): Promise<void>` (after the chains, before `afterApp`, never for a held app; its failure is logged once per change and does not stop `afterApp`). `apply` returns `Promise<"held" | void>`.

- [ ] **Step 1: Write the failing test.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/handler.test.ts b/subgraphs/vetra-licensing/__tests__/handler.test.ts
--- a/subgraphs/vetra-licensing/__tests__/handler.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/handler.test.ts
@@ -859,3 +859,66 @@ describe("AppLicenseHandler: canary chains (spec 4.2)", () => {
     expect(input.templateHash).not.toBe("h-ded");
   });
 });
+
+describe("AppLicenseHandler: release work (spec 4.3)", () => {
+  /** Two live chains whose environments are behind the template. */
+  const behind = () => ({
+    licences: [lic("l0", { stage: "e0" }), lic("l1", { stage: "e1" })],
+    envs: [
+      envRow({ environment_id: "e0", root_license_id: "l0", license_id: "l0", template_hash: "old" }),
+      envRow({ environment_id: "e1", root_license_id: "l1", license_id: "l1", template_hash: "old" }),
+    ],
+  });
+
+  it("gives the re-template budget back for a chain whose FUSION version was held", async () => {
+    const { licences, envs } = behind();
+    const provision = vi.fn(async (input: { root: string }) => ({ environment_id: `e${input.root.slice(1)}`, versionHeld: true }) as LicenseEnvironments & { versionHeld: true });
+    const h = harness({
+      environments: async () => envs,
+      provision,
+      cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, retemplatePerTick: 1 },
+    }, licences);
+    await h.handler.reconcileOnce();
+    expect(provision).toHaveBeenCalledTimes(2);
+    expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("deferred to later ticks"));
+  });
+
+  it("still spends it on a chain that re-templated", async () => {
+    const { licences, envs } = behind();
+    const h = harness({
+      environments: async () => envs,
+      cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, retemplatePerTick: 1 },
+    }, licences);
+    await h.handler.reconcileOnce();
+    expect(h.provisioned).toHaveLength(1);
+  });
+
+  it("runs afterChains with the app and its re-read rows, before afterApp", async () => {
+    const order: string[] = [];
+    const rows = [envRow({ environment_id: "e1", root_license_id: "l1", license_id: "l1", template_hash: "h-ded" })];
+    const afterChains = vi.fn(async () => { order.push("chains"); });
+    const h = harness({
+      environments: async () => rows,
+      afterChains,
+      afterApp: vi.fn(async () => { order.push("app"); }),
+    }, [lic("l1", { stage: "e1" })]);
+    await h.handler.reconcileOnce();
+    expect(afterChains).toHaveBeenCalledWith(APP, rows);
+    expect(order).toStrictEqual(["chains", "app"]);
+  });
+
+  it("logs a failing afterChains once and still runs afterApp", async () => {
+    const h = harness({ afterChains: async () => { throw new Error("db down"); } });
+    await h.handler.reconcileOnce();
+    await h.handler.reconcileOnce();
+    expect(h.deps.afterApp).toHaveBeenCalledTimes(2);
+    expect(h.logger.warn.mock.calls.filter(([m]) => String(m).includes("release work of app app-1 failed: Error: db down"))).toHaveLength(1);
+  });
+
+  it("never runs afterChains for a held app", async () => {
+    const afterChains = vi.fn(async () => {});
+    const h = harness({ app: async () => ({ ...APP, tampered: true, tamperReason: "x" }), afterChains });
+    await h.handler.reconcileOnce();
+    expect(afterChains).not.toHaveBeenCalled();
+  });
+});
PATCH
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/handler.test.ts`
Expected: "gives the re-template budget back" FAILS (`provision` called once, expected twice); the `afterChains` tests FAIL (never called).

- [ ] **Step 3: Implement the refund and the hook.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/handler.ts b/subgraphs/vetra-licensing/handler.ts
--- a/subgraphs/vetra-licensing/handler.ts
+++ b/subgraphs/vetra-licensing/handler.ts
@@ -13,6 +13,7 @@ import {
   EnvironmentNotReadyError,
   EnvironmentOwnershipMismatchError,
   type ProvisionChainInput,
+  type ProvisionResult,
 } from "./environments.js";
 import type { GrantProvenance } from "./grants.js";
 import type { LifecycleRecord } from "./lifecycle.js";
@@ -40,7 +41,7 @@ export interface HandlerDeps {
   app(appId: string): Promise<AppDocView | null>;
   environments(appId: string): Promise<LicenseEnvironments[]>;
   environmentAppIds(): Promise<string[]>;
-  provision(input: ProvisionChainInput): Promise<LicenseEnvironments>;
+  provision(input: ProvisionChainInput): Promise<ProvisionResult>;
   setStage(licenseId: string, stage: string): Promise<void>;
   /** Task 10 wires the offboarding clock here; until then they only log. */
   onEnded(appId: string, environmentId: string): Promise<void>;
@@ -57,6 +58,13 @@ export interface HandlerDeps {
     environments: LicenseEnvironments[],
     confirmedEndedRoots: ReadonlySet<string>,
   ): Promise<void>;
+  /**
+   * Runs after an app's chains, before afterApp, never for a held app: the
+   * release work that reads the environments the chains just moved (update
+   * outcomes, rollout completion, the managed-by marker). Its failure is
+   * logged and does not stop afterApp.
+   */
+  afterChains?(app: AppDocView, environments: LicenseEnvironments[]): Promise<void>;
   /**
    * Called once per tick before any app is reconciled, and once after all of
    * them: lets afterApp work share a budget across every app of one tick
@@ -484,6 +492,17 @@ export class AppLicenseHandler {
           `[licensing] offboarding of environment ${row.environment_id} (chain ${row.root_license_id}) is frozen: this tick did not confirm the chain as ended`,
         );
       }
+      if (this.d.afterChains) {
+        try {
+          await this.timed(this.d.afterChains(app, after), `release work of app ${appId}`);
+        } catch (err) {
+          this.notices.note(
+            `app:${appId}:release`,
+            "warn",
+            `[licensing] release work of app ${appId} failed: ${String(err)}`,
+          );
+        }
+      }
       await this.timed(
         this.d.afterApp(appId, after, confirmedEnded),
         `after-app work of app ${appId}`,
@@ -541,7 +560,11 @@ export class AppLicenseHandler {
       const settled = () => this.inFlight.delete(key);
       void running.then(settled, settled);
       try {
-        await this.timed(running, `${step.kind} of ${root} (app ${appId})`);
+        // A held FUSION version re-templated nothing that needs the budget
+        // (spec 4.3): the chain is provisioned again next tick anyway.
+        if ((await this.timed(running, `${step.kind} of ${root} (app ${appId})`)) === "held" && budgeted) {
+          this.retemplateBudget++;
+        }
       } catch (err) {
         // Refused before anything was dispatched: the budget was not spent.
         if (
@@ -611,7 +634,8 @@ export class AppLicenseHandler {
     return out;
   }
 
-  private async apply(app: AppDocView, step: ChainStep, resolveFor: ChainResolver): Promise<void> {
+  /** "held": a provision whose FUSION version the gate held (ProvisionResult.versionHeld). */
+  private async apply(app: AppDocView, step: ChainStep, resolveFor: ChainResolver): Promise<"held" | void> {
     switch (step.kind) {
       case "hold":
       case "anomaly":
@@ -648,7 +672,7 @@ export class AppLicenseHandler {
         if (step.licence.stage !== row.environment_id) {
           await this.d.setStage(step.licence.id, row.environment_id);
         }
-        return;
+        return row.versionHeld ? "held" : undefined;
       }
     }
   }
PATCH
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/handler.test.ts subgraphs/vetra-licensing/__tests__/handler-reactor.integration.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 63 handler tests PASS, including the existing budget tests (their fakes return no `versionHeld`).

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/handler.ts subgraphs/vetra-licensing/__tests__/handler.test.ts
git commit -m "feat(licensing): held chains keep the re-template budget; afterChains hook" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 10: Update outcomes, pause on failure, rollout completion

**Files:**
- Modify: `subgraphs/vetra-licensing/config.ts` (`LicensingConfig`, `loadLicensingConfig`)
- Create: `subgraphs/vetra-licensing/update-outcome.ts`
- Create: `subgraphs/vetra-licensing/release-tracker.ts`
- Test: `__tests__/config.test.ts` (appended), `__tests__/update-outcome.test.ts`, `__tests__/release-tracker.test.ts` (new)

**Interfaces:**
- Consumes: `RolloutStore` (Task 2: `applyingOf`, `pendingOf`, `finishUpdate`, `pause`, `activeRollouts`, `openCount`, `complete`).
- Produces: `LicensingConfig.updateTimeoutMs` (`LICENSING_UPDATE_TIMEOUT_MS`, default 1 200 000); `interface ObservedEnvironment { status: string; fusionVersion: string | null }`; `observe(state: VetraCloudEnvironmentState | null): ObservedEnvironment | null`; `type UpdateOutcome = { status: "SUCCEEDED"; error: null } | { status: "FAILED"; error: string }`; `updateOutcome(update: Pick<EnvironmentUpdates, "to_version" | "started_at">, env: ObservedEnvironment | null, now: string, timeoutMs: number): UpdateOutcome | null`; `interface ReleaseTrackerDeps { store: RolloutStore; envState(id): Promise<VetraCloudEnvironmentState | null>; cfg: Pick<LicensingConfig, "updateTimeoutMs">; logger: Pick<Console, "info" | "warn">; now(): string }`; `trackReleases(deps, app: AppDocView, rows: LicenseEnvironments[]): Promise<void>` (D11, D12).

- [ ] **Step 1: Write the failing tests.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/__tests__/config.test.ts b/subgraphs/vetra-licensing/__tests__/config.test.ts
--- a/subgraphs/vetra-licensing/__tests__/config.test.ts
+++ b/subgraphs/vetra-licensing/__tests__/config.test.ts
@@ -57,3 +57,11 @@ describe("loadLicensingConfig", () => {
     })).toMatchObject({ warmPoolScanIntervalMs: 30_000, warmPoolCreatesPerTick: 3, warmPoolMaxPerTemplate: 10 });
   });
 });
+
+describe("loadLicensingConfig: the update timeout (spec 4.3)", () => {
+  it("defaults to 20 minutes and reads LICENSING_UPDATE_TIMEOUT_MS", () => {
+    expect(loadLicensingConfig({}).updateTimeoutMs).toBe(20 * 60 * 1000);
+    expect(loadLicensingConfig({ LICENSING_UPDATE_TIMEOUT_MS: "60000" }).updateTimeoutMs).toBe(60_000);
+    expect(loadLicensingConfig({ LICENSING_UPDATE_TIMEOUT_MS: "0" }).updateTimeoutMs).toBe(20 * 60 * 1000);
+  });
+});
PATCH
```

Create `subgraphs/vetra-licensing/__tests__/update-outcome.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { observe, updateOutcome } from "../update-outcome.js";

const STARTED = "2026-11-10T12:00:00.000Z";
const SOON = "2026-11-10T12:05:00.000Z";
const LATE = "2026-11-10T12:21:00.000Z";
const TIMEOUT = 20 * 60 * 1000;
const u = { to_version: "1.1.0", started_at: STARTED };
const env = (status: string, fusionVersion: string | null = "1.1.0") => ({ status, fusionVersion });

describe("updateOutcome", () => {
  it("succeeds once the environment is READY on the new version", () => {
    expect(updateOutcome(u, env("READY"), SOON, TIMEOUT)).toStrictEqual({ status: "SUCCEEDED", error: null });
  });

  it("fails when the new version's deployment failed", () => {
    expect(updateOutcome(u, env("DEPLOYMENt_FAILED"), SOON, TIMEOUT)).toStrictEqual({ status: "FAILED", error: "the deployment of 1.1.0 failed" });
  });

  it("waits while it deploys, and for a READY or failed status that is not yet the new version's", () => {
    for (const e of [env("CHANGES_APPROVED"), env("DEPLOYING"), env("READY", "1.0.0"), env("DEPLOYMENt_FAILED", "1.0.0"), null]) {
      expect(updateOutcome(u, e, SOON, TIMEOUT)).toBeNull();
    }
  });

  it("fails when it is not READY on the new version within the timeout", () => {
    expect(updateOutcome(u, env("DEPLOYING"), LATE, TIMEOUT)).toStrictEqual({ status: "FAILED", error: "not READY on 1.1.0 within 20 minutes" });
    expect(updateOutcome(u, null, LATE, TIMEOUT)?.status).toBe("FAILED");
    expect(updateOutcome({ ...u, started_at: null }, env("DEPLOYING"), LATE, TIMEOUT)).toBeNull();
  });

  it("reads the status and the FUSION version off a document", () => {
    expect(observe(null)).toBeNull();
    expect(observe({ status: "READY", services: [{ type: "CONNECT", version: "v6" }, { type: "FUSION", version: "1.1.0" }] } as never))
      .toStrictEqual({ status: "READY", fusionVersion: "1.1.0" });
    expect(observe({ status: "READY", services: [] } as never)).toStrictEqual({ status: "READY", fusionVersion: null });
  });
});
```

Create `subgraphs/vetra-licensing/__tests__/release-tracker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { AppRollouts, EnvironmentUpdates, LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import type { AppDocView } from "../app-reads.js";
import { createRolloutStore, type RolloutStore } from "../rollout-db.js";
import { trackReleases, type ReleaseTrackerDeps } from "../release-tracker.js";

const T0 = "2026-11-10T12:00:00.000Z";
const T1 = "2026-11-10T12:05:00.000Z";
const LATE = "2026-11-10T13:00:00.000Z";
const APP: AppDocView = {
  id: "a", name: "Sektar", slug: "sektar", owner: "0xo", status: "ACTIVE", identityDid: null, productionEnvironmentId: null,
  templates: [{
    id: "t", name: null, mode: "DEDICATED", sharedEnvironment: null, warmPoolSize: 0, templateHash: "h-new", resolutionError: null,
    template: { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null },
  }],
  terms: [],
  artifacts: [{ kind: "FUSION_IMAGE", name: "host", versions: [{ version: "1.1.0", reference: "cr.vetra.io/p/host:1.1.0" }], channels: [{ channel: "LATEST", version: "1.1.0" }] }],
  tampered: false, tamperReason: null, licensingStateHash: "x", unverified: false,
};
const rollout = (over: Partial<AppRollouts> = {}): AppRollouts => ({
  id: "r1", app_id: "a", artifact_name: "host", version: "1.1.0", status: "ACTIVE", apply_after: T0,
  promoted_by: "0xp", promoted_at: T0, paused_at: null, paused_reason: null, ...over,
});
const update = (over: Partial<EnvironmentUpdates> = {}): EnvironmentUpdates => ({
  id: "u1", rollout_id: "r1", environment_id: "e1", app_id: "a", from_version: "1.0.0", to_version: "1.1.0",
  status: "APPLYING", due_at: T0, requested_at: null, started_at: T0, finished_at: null, pre_update_dump_id: null,
  error: null, forced_at: null, created_at: T0, ...over,
});
const envRow = (over: Partial<LicenseEnvironments> = {}): LicenseEnvironments => ({
  environment_id: "e1", root_license_id: "l1", app_id: "a", user_did: "u", license_id: "l1", template_id: "t",
  label: null, template_hash: "h-new", channel_override: null, ended_at: null, stopped_at: null, delete_after: null,
  created_at: T0, updated_at: T0, ...over,
});

let db: Kysely<VetraLicensingDB>;
let store: RolloutStore;
let states: Map<string, { status: string; version: string | null }>;
let deps: ReleaseTrackerDeps;
let clock: string;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  store = createRolloutStore(db);
  states = new Map();
  clock = T1;
  deps = {
    store,
    envState: async (id) => {
      const s = states.get(id);
      return s ? ({ status: s.status, services: [{ type: "FUSION", version: s.version }] } as never) : null;
    },
    cfg: { updateTimeoutMs: 20 * 60 * 1000 },
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => clock,
  };
});
afterEach(async () => { await db.destroy(); });

describe("trackReleases", () => {
  it("marks an update SUCCEEDED once its environment is READY on the version, and completes the rollout", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.update("u1"))!.status).toBe("APPLYING");
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({ status: "SUCCEEDED", finished_at: T1, error: null });
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
  });

  it("fails a deployment that failed and pauses its rollout, naming the environment", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update());
    await store.insertUpdate(update({ id: "u2", environment_id: "e2", status: "PENDING", started_at: null }));
    states.set("e1", { status: "DEPLOYMENt_FAILED", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow(), envRow({ environment_id: "e2", root_license_id: "l2" })]);
    expect(await store.update("u1")).toMatchObject({ status: "FAILED", error: "the deployment of 1.1.0 failed" });
    expect(await store.rollout("r1")).toMatchObject({ status: "PAUSED", paused_reason: "environment e1: the deployment of 1.1.0 failed" });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("rollout r1 of app a is paused"));
  });

  it("fails an update that is not READY within the timeout", async () => {
    await store.insertUpdate(update({ rollout_id: null }));
    states.set("e1", { status: "DEPLOYING", version: "1.1.0" });
    clock = LATE;
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({ status: "FAILED", error: "not READY on 1.1.0 within 20 minutes" });
  });

  it("does not complete a rollout while a customer is still PENDING, or behind its template", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ status: "PENDING", started_at: null }));
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    await store.patchUpdate("u1", { status: "SUCCEEDED" });
    // An environment the keeper has not visited since the promotion.
    await trackReleases(deps, APP, [envRow(), envRow({ environment_id: "e2", root_license_id: "l2", template_hash: "h-old" })]);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
    // Canaries and ended chains do not count.
    await trackReleases(deps, APP, [
      envRow(),
      envRow({ environment_id: "e2", root_license_id: "l2", template_hash: "h-old", channel_override: "STAGING" }),
      envRow({ environment_id: "e3", root_license_id: "l3", template_hash: "h-old", ended_at: T0 }),
    ]);
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
  });

  it("does not complete a rollout LATEST does not point at yet (promoted after the app was read)", async () => {
    await store.promote(rollout({ version: "1.2.0" }));
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.rollout("r1"))!.status).toBe("ACTIVE");
  });
});

describe("trackReleases: a resumed update whose environment already runs its version", () => {
  it("succeeds once that environment is READY again, and only then", async () => {
    await store.promote(rollout());
    await store.insertUpdate(update({ status: "PENDING", started_at: null }));
    states.set("e1", { status: "DEPLOYMENt_FAILED", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect((await store.update("u1"))!.status).toBe("PENDING");
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow()]);
    expect(await store.update("u1")).toMatchObject({ status: "SUCCEEDED", finished_at: T1 });
    expect((await store.rollout("r1"))!.status).toBe("COMPLETE");
  });

  it("leaves a PENDING update of an environment that is behind to the keeper", async () => {
    await store.insertUpdate(update({ status: "PENDING", started_at: null, rollout_id: null }));
    states.set("e1", { status: "READY", version: "1.1.0" });
    await trackReleases(deps, APP, [envRow({ template_hash: "h-old" })]);
    expect((await store.update("u1"))!.status).toBe("PENDING");
  });
});
```

- [ ] **Step 2: Run them and see them fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/{config,update-outcome,release-tracker}.test.ts`
Expected: the config test FAILS (`updateTimeoutMs` is `undefined`); the two new files FAIL to load.

- [ ] **Step 3: Add the timeout, the outcome function and the tracker.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/config.ts b/subgraphs/vetra-licensing/config.ts
--- a/subgraphs/vetra-licensing/config.ts
+++ b/subgraphs/vetra-licensing/config.ts
@@ -43,6 +43,11 @@ export interface LicensingConfig {
   tokensPerTick: number;
   /** A handler step (or read) that takes longer fails, so a hung call cannot stall every later tick. */
   stepTimeoutMs: number;
+  /**
+   * An APPLYING environment update not READY on its version within this
+   * long has failed (LICENSING_UPDATE_TIMEOUT_MS, spec 4.3).
+   */
+  updateTimeoutMs: number;
   /** How often the app warm pool keeper runs (APP_WARM_POOL_SCAN_INTERVAL_MS). */
   warmPoolScanIntervalMs: number;
   /** Warm environments created per keeper tick, across all pools (APP_WARM_POOL_CREATES_PER_TICK). 0 pauses filling. */
@@ -101,6 +106,7 @@ export function loadLicensingConfig(
     licensingPublicUrl: trimmed("VETRA_LICENSING_URL"),
     retemplatePerTick: nonNegative("LICENSING_RETEMPLATE_PER_TICK", 5),
     stepTimeoutMs: int("LICENSING_STEP_TIMEOUT_MS", 120 * 1000),
+    updateTimeoutMs: int("LICENSING_UPDATE_TIMEOUT_MS", 20 * 60 * 1000),
     tokensPerTick: nonNegative("LICENSING_TOKENS_PER_TICK", 5),
     warmPoolScanIntervalMs: int("APP_WARM_POOL_SCAN_INTERVAL_MS", 30 * 1000),
     warmPoolCreatesPerTick: nonNegative("APP_WARM_POOL_CREATES_PER_TICK", 3),
PATCH
```

Create `subgraphs/vetra-licensing/update-outcome.ts`:

```ts
import type { VetraCloudEnvironmentState, VetraCloudEnvironmentStatus } from "document-models/vetra-cloud-environment";
import type { EnvironmentUpdates } from "./db/schema.js";

/** "DEPLOYMENt_FAILED" is the environment model's own (misspelt) status value. */
const DEPLOYMENT_FAILED: VetraCloudEnvironmentStatus = "DEPLOYMENt_FAILED";

/** What the tracker reads off an environment document: its status and FUSION version. */
export interface ObservedEnvironment {
  status: string;
  fusionVersion: string | null;
}

export function observe(state: VetraCloudEnvironmentState | null): ObservedEnvironment | null {
  if (!state) return null;
  return { status: state.status, fusionVersion: state.services.find((s) => s.type === "FUSION")?.version ?? null };
}

export type UpdateOutcome = { status: "SUCCEEDED"; error: null } | { status: "FAILED"; error: string };

/**
 * Pure. Where an APPLYING update stands (spec 4.3): SUCCEEDED once the
 * environment is READY on its version; FAILED when that deployment failed,
 * or when it is not READY on it `timeoutMs` after it started (a missing
 * document, a sleep or a stuck rollout included). Otherwise null: still
 * applying. Phase 2 turns FAILED into a recovery; here it only pauses.
 */
export function updateOutcome(
  update: Pick<EnvironmentUpdates, "to_version" | "started_at">,
  env: ObservedEnvironment | null,
  now: string,
  timeoutMs: number,
): UpdateOutcome | null {
  if (env?.fusionVersion === update.to_version) {
    if (env.status === "READY") return { status: "SUCCEEDED", error: null };
    if (env.status === DEPLOYMENT_FAILED) {
      return { status: "FAILED", error: `the deployment of ${update.to_version} failed` };
    }
  }
  const started = update.started_at === null ? Number.NaN : Date.parse(update.started_at);
  if (!Number.isNaN(started) && Date.parse(now) - started > timeoutMs) {
    return {
      status: "FAILED",
      error: `not READY on ${update.to_version} within ${Math.round(timeoutMs / 60_000)} minutes`,
    };
  }
  return null;
}
```

Create `subgraphs/vetra-licensing/release-tracker.ts`:

```ts
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { AppDocView } from "./app-reads.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments } from "./db/schema.js";
import type { RolloutStore } from "./rollout-db.js";
import { observe, updateOutcome } from "./update-outcome.js";

export interface ReleaseTrackerDeps {
  store: RolloutStore;
  envState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
  cfg: Pick<LicensingConfig, "updateTimeoutMs">;
  logger: Pick<Console, "info" | "warn">;
  now(): string;
}

/**
 * The handler's afterChains release work for one app (spec 4.3): settles its
 * APPLYING updates (a failure pauses the rollout, naming the environment),
 * then completes each ACTIVE rollout that has no PENDING or APPLYING update
 * left, once LATEST points at its version and every live customer
 * environment meets its template (an environment the keeper has not visited
 * since the promotion has no update yet, but is behind).
 *
 * A resumed update whose environment already runs its version (its
 * deployment failed after the version was set: phase 1 does not revert) is
 * never moved again, as its environment meets the template; it succeeds once
 * that environment is READY again.
 */
export async function trackReleases(
  deps: ReleaseTrackerDeps,
  app: AppDocView,
  rows: LicenseEnvironments[],
): Promise<void> {
  const now = deps.now();
  for (const u of await deps.store.applyingOf(app.id)) {
    const outcome = updateOutcome(u, observe(await deps.envState(u.environment_id)), now, deps.cfg.updateTimeoutMs);
    if (!outcome) continue;
    await deps.store.finishUpdate(u.id, outcome.status, outcome.error, now);
    if (outcome.status === "SUCCEEDED") {
      deps.logger.info(`[licensing] environment ${u.environment_id} of app ${app.id} runs FUSION ${u.to_version}`);
      continue;
    }
    deps.logger.warn(`[licensing] update of environment ${u.environment_id} to FUSION ${u.to_version} failed: ${outcome.error}`);
    if (u.rollout_id && (await deps.store.pause(u.rollout_id, `environment ${u.environment_id}: ${outcome.error}`, now))) {
      deps.logger.warn(`[licensing] rollout ${u.rollout_id} of app ${app.id} is paused until the publisher resumes it`);
    }
  }

  const templateHashes = new Map(app.templates.filter((t) => t.mode === "DEDICATED").map((t) => [t.id, t.templateHash]));
  const isBehind = (r: LicenseEnvironments) =>
    r.template_id !== null && templateHashes.has(r.template_id) && templateHashes.get(r.template_id) !== r.template_hash;
  const met = new Set(rows.filter((r) => !isBehind(r)).map((r) => r.environment_id));
  for (const u of await deps.store.pendingOf(app.id)) {
    if (!met.has(u.environment_id)) continue;
    const env = observe(await deps.envState(u.environment_id));
    if (env?.fusionVersion !== u.to_version || env.status !== "READY") continue;
    await deps.store.finishUpdate(u.id, "SUCCEEDED", null, now, "PENDING");
    deps.logger.info(`[licensing] environment ${u.environment_id} of app ${app.id} runs FUSION ${u.to_version}`);
  }

  if (rows.some((r) => r.ended_at === null && (r.channel_override ?? null) === null && isBehind(r))) return;
  for (const r of await deps.store.activeRollouts(app.id)) {
    const latest = app.artifacts
      .find((a) => a.kind === "FUSION_IMAGE" && a.name === r.artifact_name)
      ?.channels.find((c) => c.channel === "LATEST")?.version;
    if (latest !== r.version || (await deps.store.openCount(r.id)) > 0) continue;
    await deps.store.complete(r.id);
    deps.logger.info(`[licensing] rollout ${r.id} of app ${app.id} (${r.artifact_name} ${r.version}) is complete`);
  }
}
```

- [ ] **Step 4: Run them and see them pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/{config,update-outcome,release-tracker}.test.ts && npm run tsc 2>&1 | tail -3`
Expected: all PASS (release-tracker: 7 tests).

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/{config,update-outcome,release-tracker}.ts subgraphs/vetra-licensing/__tests__/{config,update-outcome,release-tracker}.test.ts
git commit -m "feat(licensing): track update outcomes, pause a rollout on failure, complete it" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 11: The managed-by marker and the template locks in the environment model (4.4)

**Files:**
- Modify: `document-models/vetra-cloud-environment/vetra-cloud-environment.json` (by the script below)
- Regenerate: `document-models/vetra-cloud-environment/v1/gen/**`, `document-models/vetra-cloud-environment/v1/schema.graphql`
- Modify: `document-models/vetra-cloud-environment/v1/src/reducers/{utils,services,data-management}.ts`
- Modify: `subgraphs/vetra-cloud-observability/env-protection.ts` (`SYSTEM_ONLY_OPERATIONS`)
- Modify (type-check only, no assertion changes): `processors/vetra-cloud-environment/{app-link,fusion,gitops.dirs,gitops}.test.ts`
- Test: `document-models/vetra-cloud-environment/v1/tests/managed-by.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (exported from `document-models/vetra-cloud-environment`): state field `managedBy: Maybe<VetraCloudManagedBy>` with `type VetraCloudManagedBy = { appId: string; templateId: string; rootLicenseId: string; services: VetraCloudEnvironmentServiceType[] }` (D2); action creator `setManagedBy(input: SetManagedByInput)` (same four fields), operation `SET_MANAGED_BY` (system-only, rejected with `AppLinkSystemOnlyError` when user-signed, no status change); error `ManagedByTemplateError` (code `MANAGED_BY_TEMPLATE`) on `ENABLE_SERVICE`, `DISABLE_SERVICE`, `TOGGLE_SERVICE`, `SET_SERVICE_VERSION`, `SET_FUSION_CONFIG` (D3); reducer helper `assertNotTemplateManaged(state, action, what, serviceType)` in `src/reducers/utils.ts`.

This model is changed by editing its JSON spec and running the generator, as every earlier change to it was (`git log -- document-models/vetra-cloud-environment/vetra-cloud-environment.json`; `reactor-mcp` is not needed). Two traps: `--dir` in `ph-cli generate document-model` builds a wrong path, so use `--document`; and the generator reformats existing `src/reducers` files and injects generated tests into the existing `tests/*.test.ts` files, which Step 4 throws away. `document-models/vetra-app/v1/tests/spec-sync.test.ts` checks that each operation's JSON `reducer` string appears (whitespace-squashed) in its `src/reducers` file; the script sets both strings that test reads.

- [ ] **Step 1: Write the failing test.** Create `document-models/vetra-cloud-environment/v1/tests/managed-by.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  reducer,
  utils,
  setManagedBy,
  setOwner,
  enableService,
  disableService,
  toggleService,
  setServiceVersion,
  setFusionConfig,
} from "document-models/vetra-cloud-environment/v1";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE = "cr.vetra.io/app-sektar/host";

const userSigner = (address: string) => ({
  context: {
    signer: {
      user: { address, networkId: "eip155:1", chainId: 1 },
      app: { name: "test", key: "test" },
      signatures: [],
    },
  },
});

const MANAGED = {
  appId: "app-1",
  templateId: "t-1",
  rootLicenseId: "l-1",
  services: ["FUSION" as const],
};

/** Alice's environment, FUSION enabled at sha-a, CONNECT disabled, managed by app-1's template (FUSION only). */
function managed() {
  let doc = reducer(utils.createDocument(), { ...setOwner({ address: ALICE }), ...userSigner(ALICE) });
  doc = reducer(doc, enableService({ type: "FUSION", prefix: "sektar" }));
  doc = reducer(doc, enableService({ type: "CONNECT", prefix: "connect" }));
  doc = reducer(doc, disableService({ type: "CONNECT", prefix: "connect" }));
  doc = reducer(doc, setServiceVersion({ type: "FUSION", version: "sha-a" }));
  doc = reducer(doc, setFusionConfig({ image: IMAGE, env: [], autoUpdate: false, autoUpdateTagPattern: null }));
  doc = reducer(doc, setManagedBy(MANAGED));
  return doc;
}
const lastError = (doc: ReturnType<typeof managed>) => doc.operations.global.at(-1)?.error;
const fusion = (doc: ReturnType<typeof managed>) => doc.state.global.services.find((s) => s.type === "FUSION")!;

describe("SET_MANAGED_BY", () => {
  it("starts as null on a new document", () => {
    expect(utils.createDocument().state.global.managedBy ?? null).toBeNull();
  });

  it("lets a system action set it, and does not move a deployed env to CHANGES_PENDING", () => {
    const doc = managed();
    expect(lastError(doc)).toBeUndefined();
    expect(doc.state.global.managedBy).toStrictEqual(MANAGED);
    const status = doc.state.global.status;
    const again = reducer(doc, setManagedBy({ ...MANAGED, templateId: "t-2" }));
    expect(again.state.global.managedBy).toStrictEqual({ ...MANAGED, templateId: "t-2" });
    expect(again.state.global.status).toBe(status);
  });

  it("rejects a user-signed SET_MANAGED_BY, even from the owner", () => {
    const doc = reducer(utils.createDocument(), { ...setOwner({ address: ALICE }), ...userSigner(ALICE) });
    const out = reducer(doc, { ...setManagedBy(MANAGED), ...userSigner(ALICE) });
    expect(lastError(out)).toMatch(/AppLinkSystemOnly: SET_MANAGED_BY/);
    expect(out.state.global.managedBy ?? null).toBeNull();
  });
});

describe("the template lock on a managed environment", () => {
  it("rejects the owner's SET_SERVICE_VERSION of a declared service; a system action passes", () => {
    const signed = reducer(managed(), { ...setServiceVersion({ type: "FUSION", version: "sha-old" }), ...userSigner(ALICE) });
    expect(lastError(signed)).toMatch(/ManagedByTemplate: the FUSION version/);
    expect(fusion(signed).version).toBe("sha-a");
    const system = reducer(managed(), setServiceVersion({ type: "FUSION", version: "sha-b" }));
    expect(lastError(system)).toBeUndefined();
    expect(fusion(system).version).toBe("sha-b");
  });

  it("rejects disabling or toggling a declared service, and enabling one that is off", () => {
    const disabled = reducer(managed(), { ...disableService({ type: "FUSION", prefix: "sektar" }), ...userSigner(ALICE) });
    expect(lastError(disabled)).toMatch(/ManagedByTemplate: disabling FUSION/);
    expect(fusion(disabled).enabled).toBe(true);
    const toggled = reducer(managed(), { ...toggleService({ type: "FUSION" }), ...userSigner(ALICE) });
    expect(lastError(toggled)).toMatch(/ManagedByTemplate: toggling FUSION/);
    let off = reducer(managed(), disableService({ type: "FUSION", prefix: "sektar" }));
    off = reducer(off, { ...enableService({ type: "FUSION", prefix: "sektar" }), ...userSigner(ALICE) });
    expect(lastError(off)).toMatch(/ManagedByTemplate: enabling FUSION/);
    expect(fusion(off).enabled).toBe(false);
  });

  it("lets the owner re-state an enabled declared service (a size or prefix change)", () => {
    const doc = reducer(managed(), {
      ...enableService({ type: "FUSION", prefix: "sektar", selectedRessource: "VETRA_AGENT_L" }),
      ...userSigner(ALICE),
    });
    expect(lastError(doc)).toBeUndefined();
    expect(fusion(doc).selectedRessource).toBe("VETRA_AGENT_L");
  });

  it("leaves services the template does not declare to the owner", () => {
    let doc = reducer(managed(), { ...enableService({ type: "CONNECT", prefix: "connect" }), ...userSigner(ALICE) });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, { ...setServiceVersion({ type: "CONNECT", version: "v6" }), ...userSigner(ALICE) });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, { ...toggleService({ type: "CONNECT" }), ...userSigner(ALICE) });
    expect(lastError(doc)).toBeUndefined();
    doc = reducer(doc, { ...disableService({ type: "CONNECT", prefix: "connect" }), ...userSigner(ALICE) });
    expect(lastError(doc)).toBeUndefined();
  });

  it("rejects a SET_FUSION_CONFIG that changes the image or auto-update, but not one that only changes env", () => {
    const image = reducer(managed(), {
      ...setFusionConfig({ image: "cr.vetra.io/other/app", env: [], autoUpdate: false, autoUpdateTagPattern: null }),
      ...userSigner(ALICE),
    });
    expect(lastError(image)).toMatch(/ManagedByTemplate: the FUSION image and auto-update/);
    const auto = reducer(managed(), {
      ...setFusionConfig({ image: IMAGE, env: [], autoUpdate: true, autoUpdateTagPattern: null }),
      ...userSigner(ALICE),
    });
    expect(lastError(auto)).toMatch(/ManagedByTemplate/);
    const pattern = reducer(managed(), {
      ...setFusionConfig({ image: IMAGE, env: [], autoUpdate: false, autoUpdateTagPattern: "^v" }),
      ...userSigner(ALICE),
    });
    expect(lastError(pattern)).toMatch(/ManagedByTemplate/);
    const env = reducer(managed(), {
      ...setFusionConfig({ image: IMAGE, env: [{ name: "FOO", value: "1", isSecret: false }], autoUpdate: false, autoUpdateTagPattern: null }),
      ...userSigner(ALICE),
    });
    expect(lastError(env)).toBeUndefined();
    expect(env.state.global.fusion!.env).toStrictEqual([{ name: "FOO", value: "1", isSecret: false }]);
  });

  it("does not lock an environment no template manages", () => {
    let doc = reducer(utils.createDocument(), { ...setOwner({ address: ALICE }), ...userSigner(ALICE) });
    doc = reducer(doc, { ...enableService({ type: "FUSION", prefix: "sektar" }), ...userSigner(ALICE) });
    doc = reducer(doc, { ...setServiceVersion({ type: "FUSION", version: "sha-x" }), ...userSigner(ALICE) });
    doc = reducer(doc, {
      ...setFusionConfig({ image: IMAGE, env: [], autoUpdate: true, autoUpdateTagPattern: null }),
      ...userSigner(ALICE),
    });
    doc = reducer(doc, { ...toggleService({ type: "FUSION" }), ...userSigner(ALICE) });
    expect(doc.operations.global.every((o) => o.error === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run document-models/vetra-cloud-environment/v1/tests/managed-by.test.ts`
Expected: FAIL, `setManagedBy is not a function` (not exported yet).

- [ ] **Step 3: Patch the JSON spec.** Run this from the repo root. It adds the state field and type, the operation and the errors, and sets the two reducer strings spec-sync reads; it refuses to run twice. It writes the file back exactly as it is formatted now (2-space JSON, no trailing newline).

```bash
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";

const file = "document-models/vetra-cloud-environment/vetra-cloud-environment.json";
const doc = JSON.parse(readFileSync(file, "utf8"));
const spec = doc.specifications.at(-1);
const g = spec.state.global;

if (g.schema.includes("managedBy:")) throw new Error("already patched");
g.schema = g.schema
  .replace(
    "  backupSchedule: BackupSchedule\n}",
    "  backupSchedule: BackupSchedule\n  managedBy: VetraCloudManagedBy\n}",
  )
  .concat(
    "\n\ntype VetraCloudManagedBy {\n  appId: String!\n  templateId: String!\n  rootLicenseId: String!\n  services: [VetraCloudEnvironmentServiceType!]!\n}",
  );
const initial = JSON.parse(g.initialValue);
initial.managedBy = null;
g.initialValue = JSON.stringify(initial, null, 2);

const dm = spec.modules.find((m) => m.name === "data_management");
dm.operations.push({
  id: "op-set-managed-by",
  name: "SET_MANAGED_BY",
  description:
    "Record which App template manages this environment (a licence holder environment). System-only: rejected unless the action is system-signed. While set, the template's image, version and services are locked against user-signed actions.",
  schema:
    "input SetManagedByInput {\n  appId: String!\n  templateId: String!\n  rootLicenseId: String!\n  services: [VetraCloudEnvironmentServiceType!]!\n}",
  template: "",
  // The body of setManagedByOperation in src/reducers/data-management.ts
  // (spec-sync.test.ts checks the two match).
  reducer:
    'assertSystemOnly(action, "SET_MANAGED_BY");\nconst { appId, templateId, rootLicenseId, services } = action.input;\nstate.managedBy = { appId, templateId, rootLicenseId, services: [...services] };',
  errors: [
    {
      id: "err-managed-by-system-only",
      name: "AppLinkSystemOnlyError",
      code: "APP_LINK_SYSTEM_ONLY",
      description:
        "AppLinkSystemOnly: the managed-by marker can only be set by a system-signed action (the licensing keeper)",
      template: "",
    },
  ],
  examples: [],
  scope: "global",
});

const services = spec.modules.find((m) => m.name === "services");
for (const name of ["ENABLE_SERVICE", "DISABLE_SERVICE", "TOGGLE_SERVICE", "SET_SERVICE_VERSION", "SET_FUSION_CONFIG"]) {
  const op = services.operations.find((o) => o.name === name);
  op.errors.push({
    id: `err-managed-by-template-${name.toLowerCase().replaceAll("_", "-")}`,
    name: "ManagedByTemplateError",
    code: "MANAGED_BY_TEMPLATE",
    description:
      "ManagedByTemplate: a user-signed action may not change what the managing App template owns (its services, their versions, the FUSION image and auto-update)",
    template: "",
  });
}

// SET_SERVICE_VERSION is not in spec-sync's KNOWN_DRIFT: its string must
// carry the lock src now has.
const setVersion = services.operations.find((o) => o.name === "SET_SERVICE_VERSION");
setVersion.reducer = setVersion.reducer.replace(
  "service.version = action.input.version;",
  "assertNotTemplateManaged(state, action, `the ${service.type} version`, service.type);\nservice.version = action.input.version;",
);
if (!setVersion.reducer.includes("assertNotTemplateManaged")) throw new Error("SET_SERVICE_VERSION reducer not patched");

writeFileSync(file, JSON.stringify(doc, null, 2));
JS
```

Then check: `git diff --stat document-models/vetra-cloud-environment/vetra-cloud-environment.json` shows about 58 insertions and 2 deletions in that one file.

- [ ] **Step 4: Regenerate, then keep only the generated code.**
```bash
npx ph-cli generate document-model --document document-models/vetra-cloud-environment/vetra-cloud-environment.json
git checkout -- document-models/vetra-cloud-environment/v1/src document-models/vetra-cloud-environment/v1/tests
git status --short document-models
```
Expected `git status` (exactly these, plus the untracked `tests/managed-by.test.ts`): `M` on `vetra-cloud-environment.json`, `v1/schema.graphql`, and under `v1/gen/`: `data-management/{actions,creators,error,operations}.ts`, `document-model.ts`, `ph-factories.ts`, `reducer.ts`, `schema/types.ts`, `schema/zod.ts`, `services/error.ts`, `utils.ts`. If anything else under `document-models/` changed, restore it with `git checkout -- <path>`.

- [ ] **Step 5: Write the reducers (the `src` half the generator does not own).**

```bash
git apply <<'PATCH'
diff --git a/document-models/vetra-cloud-environment/v1/src/reducers/utils.ts b/document-models/vetra-cloud-environment/v1/src/reducers/utils.ts
--- a/document-models/vetra-cloud-environment/v1/src/reducers/utils.ts
+++ b/document-models/vetra-cloud-environment/v1/src/reducers/utils.ts
@@ -2,6 +2,7 @@ import {
   AppLinkSystemOnlyError,
   NotOwnerError,
 } from "../../gen/data-management/error.js";
+import { ManagedByTemplateError } from "../../gen/services/error.js";
 
 type MaybeSigner = {
   context?: {
@@ -80,6 +81,29 @@ export function assertSystemOnly(action: MaybeSigner, opName: string) {
   }
 }
 
+/**
+ * Template lock (spec 4.4). On an environment a licence template manages
+ * (state.managedBy, set by the licensing keeper), a user-signed action may not
+ * change what the template owns: the services it declares, their versions and
+ * the FUSION image and auto-update. System actions (no user signer) pass, so
+ * the keeper itself is unaffected. The lock applies only to a service type
+ * the template declares (`serviceType`); every other service stays the
+ * holder's.
+ */
+export function assertNotTemplateManaged(
+  state: { managedBy?: { appId: string; services: readonly string[] } | null },
+  action: MaybeSigner,
+  what: string,
+  serviceType: string,
+) {
+  const managed = state.managedBy;
+  if (!managed || !action.context?.signer?.user?.address) return;
+  if (!managed.services.includes(serviceType)) return;
+  throw new ManagedByTemplateError(
+    `ManagedByTemplate: ${what} is set by the template of app ${managed.appId}`,
+  );
+}
+
 const NO_PENDING_STATUSES = new Set([
   "DRAFT",
   "CHANGES_PENDING",
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/document-models/vetra-cloud-environment/v1/src/reducers/services.ts b/document-models/vetra-cloud-environment/v1/src/reducers/services.ts
--- a/document-models/vetra-cloud-environment/v1/src/reducers/services.ts
+++ b/document-models/vetra-cloud-environment/v1/src/reducers/services.ts
@@ -7,6 +7,7 @@ import {
   ServiceNotFoundError,
 } from "../../gen/services/error.js";
 import {
+  assertNotTemplateManaged,
   assertOwner,
   markPendingIfDeployed,
   regenerateDnsRecords,
@@ -25,6 +26,9 @@ export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServi
       if (!state.services) {
         state.services = [];
       }
+      if (!state.services.find((s) => s.type === type)?.enabled) {
+        assertNotTemplateManaged(state, action, `enabling ${type}`, type);
+      }
       const collision = state.services.find(
         (s) => s.prefix === prefix && s.type !== type,
       );
@@ -100,6 +104,9 @@ export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServi
         type === "CLINT" && prefix
           ? state.services.find((s) => s.type === type && s.prefix === prefix)
           : state.services.find((s) => s.type === type);
+      if (service?.enabled) {
+        assertNotTemplateManaged(state, action, `disabling ${type}`, type);
+      }
       if (service) {
         service.enabled = false;
         regenerateDnsRecords(state);
@@ -114,6 +121,7 @@ export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServi
           "Service " + action.input.type + " not found",
         );
       }
+      assertNotTemplateManaged(state, action, `toggling ${service.type}`, service.type);
       service.enabled = !service.enabled;
       regenerateDnsRecords(state);
       markPendingIfDeployed(state);
@@ -158,6 +166,7 @@ export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServi
           "Service " + action.input.type + " not found",
         );
       }
+      assertNotTemplateManaged(state, action, `the ${service.type} version`, service.type);
       service.version = action.input.version;
       markPendingIfDeployed(state);
     },
@@ -227,6 +236,15 @@ export const vetraCloudEnvironmentServicesOperations: VetraCloudEnvironmentServi
         }
       }
       const pattern = autoUpdateTagPattern?.trim() || null;
+      // The holder keeps the env (and its secrets); the image and how it
+      // follows new tags belong to the template.
+      if (
+        (state.fusion?.image ?? null) !== repo ||
+        (state.fusion?.autoUpdate ?? false) !== autoUpdate ||
+        (state.fusion?.autoUpdateTagPattern ?? null) !== pattern
+      ) {
+        assertNotTemplateManaged(state, action, "the FUSION image and auto-update", "FUSION");
+      }
       if (pattern !== null) {
         // The poller runs this on the shared switchboard: keep it short and
         // free of nested quantifiers (catastrophic backtracking).
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/document-models/vetra-cloud-environment/v1/src/reducers/data-management.ts b/document-models/vetra-cloud-environment/v1/src/reducers/data-management.ts
--- a/document-models/vetra-cloud-environment/v1/src/reducers/data-management.ts
+++ b/document-models/vetra-cloud-environment/v1/src/reducers/data-management.ts
@@ -216,4 +216,13 @@ export const vetraCloudEnvironmentDataManagementOperations: VetraCloudEnvironmen
       // The schedule is read by the observability subgraph's runner, not the
       // chart, so no markPendingIfDeployed — same as setAutoUpdateChannel.
     },
+    setManagedByOperation(state, action) {
+      // Written only by the licensing keeper: it is what locks the template's
+      // services, versions and image (assertNotTemplateManaged), so no user
+      // (not even the owner) may set it.
+      assertSystemOnly(action, "SET_MANAGED_BY");
+      const { appId, templateId, rootLicenseId, services } = action.input;
+      state.managedBy = { appId, templateId, rootLicenseId, services: [...services] };
+      // Metadata: renders nothing into the chart, so no markPendingIfDeployed.
+    },
   };
PATCH
```

- [ ] **Step 6: Make SET_MANAGED_BY system-only at reactor-api, and give the four full-state test fixtures the new field.** The generated state type makes `managedBy` a required (nullable) key, so these literals stop type-checking; nothing they assert changes.

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-cloud-observability/env-protection.ts b/subgraphs/vetra-cloud-observability/env-protection.ts
--- a/subgraphs/vetra-cloud-observability/env-protection.ts
+++ b/subgraphs/vetra-cloud-observability/env-protection.ts
@@ -66,6 +66,7 @@ export const SYSTEM_ONLY_OPERATIONS = [
   ...ORG_SYSTEM_OPERATIONS,
   "SET_APP_LINK",
   "CLEAR_APP_LINK",
+  "SET_MANAGED_BY",
 ] as const;
 
 /**
PATCH
```

```bash
sed -i 's/^    backupSchedule: null,$/    backupSchedule: null,\n    managedBy: null,/' processors/vetra-cloud-environment/{app-link,fusion,gitops.dirs,gitops}.test.ts
git diff --stat processors
```
Expected: four files, one insertion each.

- [ ] **Step 7: Run and see it pass.**
Run: `npx vitest run document-models processors subgraphs/vetra-cloud-observability && npm run test:coverage 2>&1 | grep -E "All files|ERROR" && npm run tsc 2>&1 | tail -3`
Expected: `managed-by.test.ts` 9 tests PASS; `spec-sync.test.ts` PASSES (`SET_MANAGED_BY`, `SET_SERVICE_VERSION`); every existing document-model, processor and observability test PASSES; coverage of `src/reducers` stays at or above 95% (measured 100 / 99.79 / 100 / 100 in a trial run); `tsc` clean.

- [ ] **Step 8: Commit.**
```bash
git add document-models/vetra-cloud-environment subgraphs/vetra-cloud-observability/env-protection.ts processors/vetra-cloud-environment/{app-link,fusion,gitops.dirs,gitops}.test.ts
git commit -m "feat(model): managedBy marker and template locks on vetra-cloud-environment" -m "SET_MANAGED_BY is system-only. While it is set, user-signed actions may not change the template's services, their versions, or the FUSION image and auto-update." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 12: The keeper keeps every chain environment marked (4.4)

**Files:**
- Create: `subgraphs/vetra-licensing/managed-by.ts`
- Test: `subgraphs/vetra-licensing/__tests__/managed-by.test.ts`

**Interfaces:**
- Consumes: `setManagedBy`, `VetraCloudEnvironmentServiceType`, `VetraCloudEnvironmentState["managedBy"]` (Task 11).
- Produces: `interface ManagedBy { appId; templateId; rootLicenseId; services: VetraCloudEnvironmentServiceType[] }`; `wantedManagedBy(row: LicenseEnvironments, app: AppDocView): ManagedBy | null`; `sameManagedBy(current, wanted): boolean`; `createManagedBySync(deps: { envs: { getState; execute }; logger: Pick<Console, "warn"> }): (app: AppDocView, rows: LicenseEnvironments[]) => Promise<void>` (D4).

- [ ] **Step 1: Write the failing test.** Create `subgraphs/vetra-licensing/__tests__/managed-by.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Action } from "document-model";
import type { AppDocView } from "../app-reads.js";
import type { LicenseEnvironments } from "../db/schema.js";
import { createManagedBySync, wantedManagedBy } from "../managed-by.js";

const T = "2026-11-10T00:00:00.000Z";
const tpl = (id: string, mode: "SHARED" | "DEDICATED", types: string[]) => ({
  id, name: null, mode, sharedEnvironment: null, warmPoolSize: 0, templateHash: `h-${id}`, resolutionError: null,
  template: { services: types.map((type, i) => ({ id: `s${i}`, type, prefix: null })), packages: [], size: null, baseDomain: null, packageRegistry: null },
});
const app = (types = ["FUSION", "CONNECT"]): AppDocView => ({
  id: "a", name: "Sektar", slug: "sektar", owner: "0xo", status: "ACTIVE", identityDid: null, productionEnvironmentId: null,
  templates: [tpl("t", "DEDICATED", types), tpl("sh", "SHARED", ["CONNECT"])], terms: [], artifacts: [],
  tampered: false, tamperReason: null, licensingStateHash: "x", unverified: false,
});
const row = (over: Partial<LicenseEnvironments> = {}): LicenseEnvironments => ({
  environment_id: "e1", root_license_id: "l1", app_id: "a", user_did: "u", license_id: "l1", template_id: "t",
  label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: T, updated_at: T, ...over,
});
const WANTED = { appId: "a", templateId: "t", rootLicenseId: "l1", services: ["CONNECT", "FUSION"] };

describe("wantedManagedBy", () => {
  it("names the app, template, chain and the template's service types in model order", () => {
    expect(wantedManagedBy(row(), app())).toStrictEqual(WANTED);
  });
  it("is null for an unknown or SHARED template", () => {
    expect(wantedManagedBy(row({ template_id: "gone" }), app())).toBeNull();
    expect(wantedManagedBy(row({ template_id: "sh" }), app())).toBeNull();
  });
});

describe("createManagedBySync", () => {
  function setup(state: Record<string, unknown> | null) {
    const executed: Action[][] = [];
    const getState = vi.fn(async () => state as never);
    const warn = vi.fn();
    const sync = createManagedBySync({
      envs: { getState, execute: async (_id, actions) => { executed.push(actions); } },
      logger: { warn },
    });
    return { sync, executed, getState, warn };
  }

  it("backfills a live environment without the marker, once", async () => {
    const s = setup({ status: "READY", managedBy: null });
    await s.sync(app(), [row()]);
    await s.sync(app(), [row()]);
    expect(s.executed).toHaveLength(1);
    expect(s.executed[0]!.map((a) => a.type)).toStrictEqual(["SET_MANAGED_BY"]);
    expect(s.executed[0]![0]!.input).toStrictEqual(WANTED);
    expect(s.getState).toHaveBeenCalledOnce();
  });

  it("leaves a document that already carries the marker, and re-marks it when the template's services change", async () => {
    const s = setup({ status: "READY", managedBy: WANTED });
    await s.sync(app(), [row()]);
    expect(s.executed).toHaveLength(0);
    await s.sync(app(["FUSION", "CONNECT", "SWITCHBOARD"]), [row()]);
    expect(s.executed[0]![0]!.input).toMatchObject({ services: ["CONNECT", "SWITCHBOARD", "FUSION"] });
  });

  it("skips a DRAFT or missing document and tries again next time", async () => {
    const draft = setup({ status: "DRAFT", managedBy: null });
    await draft.sync(app(), [row()]);
    await draft.sync(app(), [row()]);
    expect(draft.executed).toHaveLength(0);
    expect(draft.getState).toHaveBeenCalledTimes(2);
    const gone = setup(null);
    await gone.sync(app(), [row()]);
    expect(gone.executed).toHaveLength(0);
  });

  it("logs a failed write and retries it", async () => {
    const getState = vi.fn(async () => ({ status: "READY", managedBy: null }) as never);
    const warn = vi.fn();
    let calls = 0;
    const sync = createManagedBySync({
      envs: { getState, execute: async () => { if (++calls === 1) throw new Error("reactor down"); } },
      logger: { warn },
    });
    await sync(app(), [row()]);
    await sync(app(), [row()]);
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("marking environment e1 as managed by app a failed: Error: reactor down"));
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/managed-by.test.ts`
Expected: FAIL, `Failed to load url ../managed-by.js`.

- [ ] **Step 3: Write the sync.** Create `subgraphs/vetra-licensing/managed-by.ts`:

```ts
import type { Action } from "document-model";
import {
  setManagedBy,
  type VetraCloudEnvironmentServiceType,
  type VetraCloudEnvironmentState,
} from "document-models/vetra-cloud-environment";
import type { AppDocView } from "./app-reads.js";
import type { LicenseEnvironments } from "./db/schema.js";

/** The environment model's service types, in its own order. */
const SERVICE_TYPES: readonly VetraCloudEnvironmentServiceType[] = [
  "CONNECT", "SWITCHBOARD", "FUSION", "CLINT", "DOCLING", "PAPERLESS", "SPECKLE",
];

export interface ManagedBy {
  appId: string;
  templateId: string;
  rootLicenseId: string;
  /** The service types the template declares: what the reducer locks (spec 4.4). */
  services: VetraCloudEnvironmentServiceType[];
}

/** The marker a chain's environment should carry, or null when its template is unknown or SHARED. */
export function wantedManagedBy(row: LicenseEnvironments, app: AppDocView): ManagedBy | null {
  const template = app.templates.find((t) => t.id === row.template_id);
  if (!template || template.mode !== "DEDICATED") return null;
  const declared = new Set(template.template.services.map((s) => s.type));
  return {
    appId: row.app_id,
    templateId: template.id,
    rootLicenseId: row.root_license_id,
    services: SERVICE_TYPES.filter((t) => declared.has(t)),
  };
}

export function sameManagedBy(current: VetraCloudEnvironmentState["managedBy"] | undefined, wanted: ManagedBy): boolean {
  return (
    !!current &&
    current.appId === wanted.appId &&
    current.templateId === wanted.templateId &&
    current.rootLicenseId === wanted.rootLicenseId &&
    current.services.length === wanted.services.length &&
    current.services.every((s, i) => s === wanted.services[i])
  );
}

export interface ManagedBySyncDeps {
  envs: {
    getState(id: string): Promise<VetraCloudEnvironmentState | null>;
    execute(id: string, actions: Action[]): Promise<unknown>;
  };
  logger: Pick<Console, "warn">;
}

/**
 * Keeps every chain environment's managedBy marker on its template (spec
 * 4.4): set right after a create or a warm claim (the tick that made it),
 * backfilled for environments built before the marker existed, and moved when
 * the chain changes template or the template its services. SET_MANAGED_BY is
 * system-only and leaves the status alone, so it never restarts anything.
 * Each environment's document is read once per process and marker; a DRAFT
 * (not initialised yet) is left for the next tick. Failures are logged per
 * environment and retried next tick.
 */
export function createManagedBySync(deps: ManagedBySyncDeps) {
  /** environment id -> the marker this process confirmed on its document. */
  const confirmed = new Map<string, string>();
  return async (app: AppDocView, rows: LicenseEnvironments[]): Promise<void> => {
    for (const row of rows) {
      const wanted = wantedManagedBy(row, app);
      if (!wanted) continue;
      const key = JSON.stringify(wanted);
      if (confirmed.get(row.environment_id) === key) continue;
      try {
        const state = await deps.envs.getState(row.environment_id);
        if (!state || state.status === "DRAFT") continue;
        if (!sameManagedBy(state.managedBy, wanted)) {
          await deps.envs.execute(row.environment_id, [setManagedBy(wanted)]);
        }
        confirmed.set(row.environment_id, key);
      } catch (err) {
        deps.logger.warn(
          `[licensing] marking environment ${row.environment_id} as managed by app ${app.id} failed: ${String(err)}`,
        );
      }
    }
  };
}
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/managed-by.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/managed-by.ts subgraphs/vetra-licensing/__tests__/managed-by.test.ts
git commit -m "feat(licensing): keep every chain environment's managedBy marker on its template" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 13: managedBy in the read model and myEnvironments (4.4)

**Files:**
- Modify: `processors/vetra-cloud-environment/{schema,migrations,processor}.ts`
- Modify: `subgraphs/vetra-cloud-observability/schema.ts` (`VetraCloudEnvironmentSummary`, new `VetraCloudEnvManagedBy`), `resolvers.ts` (`VetraCloudEnvironmentSummary.managedBy`, `parseManagedBy`)
- Test: `processors/vetra-cloud-environment/read-model.test.ts`, `subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts` (import line, appended describe)

**Interfaces:**
- Consumes: `VetraCloudManagedBy` (Task 11).
- Produces: read-model column `environments.managedBy text` (JSON); `managedByColumn(state): { managedBy: string | null }`; GraphQL `VetraCloudEnvironmentSummary.managedBy: VetraCloudEnvManagedBy` (`appId`, `templateId`, `rootLicenseId`, `services: [String!]!`); `parseManagedBy(raw: string | null)` (D15).

- [ ] **Step 1: Write the failing tests.**

```bash
git apply <<'PATCH'
diff --git a/processors/vetra-cloud-environment/read-model.test.ts b/processors/vetra-cloud-environment/read-model.test.ts
--- a/processors/vetra-cloud-environment/read-model.test.ts
+++ b/processors/vetra-cloud-environment/read-model.test.ts
@@ -3,7 +3,7 @@ import { PGlite } from "@electric-sql/pglite";
 import { Kysely } from "kysely";
 import { PGliteDialect } from "kysely-pglite-dialect";
 import { up } from "./migrations.js";
-import { appLinkColumns, backupScheduleColumn, hostColumns, orgColumns } from "./processor.js";
+import { appLinkColumns, backupScheduleColumn, hostColumns, managedByColumn, orgColumns } from "./processor.js";
 import type { DB } from "./schema.js";
 
 describe("environments read model — App link columns", () => {
@@ -156,3 +156,23 @@ describe("environments read model — host lookup columns", () => {
     });
   });
 });
+
+describe("environments read model — managedBy column", () => {
+  const MANAGED = { appId: "app-1", templateId: "t-1", rootLicenseId: "l-1", services: ["FUSION" as const] };
+
+  it("adds managedBy (idempotently) and round-trips it", async () => {
+    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
+    await up(db as Kysely<any>);
+    await up(db as Kysely<any>);
+    await db.insertInto("environments").values({ id: "e1", ...managedByColumn({ managedBy: MANAGED }) } as never).execute();
+    const row = await db.selectFrom("environments").select(["managedBy"]).where("id", "=", "e1").executeTakeFirstOrThrow();
+    expect(JSON.parse(row.managedBy!)).toStrictEqual(MANAGED);
+    await db.destroy();
+  });
+
+  it("serializes state.managedBy, NULL when unset", () => {
+    expect(managedByColumn({ managedBy: MANAGED })).toStrictEqual({ managedBy: JSON.stringify(MANAGED) });
+    expect(managedByColumn({ managedBy: null })).toStrictEqual({ managedBy: null });
+    expect(managedByColumn({})).toStrictEqual({ managedBy: null });
+  });
+});
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts b/subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts
--- a/subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts
+++ b/subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts
@@ -4,7 +4,7 @@ import { Kysely } from "kysely";
 import { PGliteDialect } from "kysely-pglite-dialect";
 import { up } from "../db/migrations.js";
 import type { ObservabilityDB } from "../db/schema.js";
-import { createResolvers } from "../resolvers.js";
+import { createResolvers, parseManagedBy } from "../resolvers.js";
 
 const ME = "0xabc";
 
@@ -211,3 +211,26 @@ describe("myEnvironments", () => {
     expect(out[0].services).toEqual([]);
   });
 });
+
+describe("VetraCloudEnvironmentSummary.managedBy", () => {
+  const MANAGED = { appId: "app-1", templateId: "t-1", rootLicenseId: "l-1", services: ["FUSION"] };
+
+  it("reads the licence template that manages an environment, null for any other", async () => {
+    await envDb.schema.alterTable("environments").addColumn("managedBy", "text").execute();
+    await seedEnv({ id: "holder", owner: ME });
+    await seedEnv({ id: "standalone", owner: ME });
+    await envDb.updateTable("environments").set({ managedBy: JSON.stringify(MANAGED) }).where("id", "=", "holder").execute();
+    const field = (makeResolvers() as unknown as {
+      VetraCloudEnvironmentSummary: { managedBy: (p: { id: string }) => Promise<unknown> };
+    }).VetraCloudEnvironmentSummary.managedBy;
+    expect(await field({ id: "holder" })).toStrictEqual(MANAGED);
+    expect(await field({ id: "standalone" })).toBeNull();
+    expect(await field({ id: "missing" })).toBeNull();
+  });
+
+  it("reads a malformed value as null", () => {
+    expect(parseManagedBy("{not json")).toBeNull();
+    expect(parseManagedBy(JSON.stringify({ appId: "a" }))).toBeNull();
+    expect(parseManagedBy(JSON.stringify({ ...MANAGED, services: "FUSION" }))).toStrictEqual({ ...MANAGED, services: [] });
+  });
+});
PATCH
```

- [ ] **Step 2: Run them and see them fail.**
Run: `npx vitest run processors/vetra-cloud-environment/read-model.test.ts subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts`
Expected: FAIL (`managedByColumn is not a function`; `parseManagedBy is not a function`; `VetraCloudEnvironmentSummary` is undefined).

- [ ] **Step 3: Project the column and resolve the field.**

```bash
git apply <<'PATCH'
diff --git a/processors/vetra-cloud-environment/schema.ts b/processors/vetra-cloud-environment/schema.ts
--- a/processors/vetra-cloud-environment/schema.ts
+++ b/processors/vetra-cloud-environment/schema.ts
@@ -59,6 +59,12 @@ export interface Environments {
   appRole: string | null;
   /** PR number of a PREVIEW env, else NULL. */
   prNumber: number | null;
+  /**
+   * JSON of doc state's `managedBy` ({ appId, templateId, rootLicenseId,
+   * services }): the licence template that manages a holder's environment.
+   * NULL for every other environment.
+   */
+  managedBy: string | null;
   /**
    * Warm-pool tracking (NULL for ordinary, non-pool environments).
    * Written by the studio-pool-keeper service and the claim subgraph.
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/processors/vetra-cloud-environment/migrations.ts b/processors/vetra-cloud-environment/migrations.ts
--- a/processors/vetra-cloud-environment/migrations.ts
+++ b/processors/vetra-cloud-environment/migrations.ts
@@ -109,6 +109,17 @@ export async function up(db: Kysely<any>): Promise<void> {
     // Column already exists — expected for fresh installs
   }
 
+  // managedBy column — JSON mirror of state's `managedBy` (the licence
+  // template managing a holder's environment), read by myEnvironments.
+  try {
+    await db.schema
+      .alterTable("environments")
+      .addColumn("managedBy", "text")
+      .execute();
+  } catch {
+    // Column already exists — expected for fresh installs
+  }
+
   // Warm-pool columns (added 2026-06-15) — see
   // docs/superpowers/specs/2026-06-15-warm-pool-vetra-studio-design.md.
   // Written by the studio-pool-keeper service and the claim subgraph.
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/processors/vetra-cloud-environment/processor.ts b/processors/vetra-cloud-environment/processor.ts
--- a/processors/vetra-cloud-environment/processor.ts
+++ b/processors/vetra-cloud-environment/processor.ts
@@ -1,7 +1,7 @@
 import type { IProcessor, IProcessorHostModule, OperationWithContext } from "@powerhousedao/reactor-browser";
 import type { IDocumentView } from "@powerhousedao/reactor";
 import type { Kysely } from "kysely";
-import { markChangesPushed, type VetraCloudEnvironmentAction, type VetraCloudEnvironmentDocument, type VetraCloudEnvironmentState, type VetraCloudAppLink, type BackupSchedule } from "../../document-models/vetra-cloud-environment/index.js";
+import { markChangesPushed, type VetraCloudEnvironmentAction, type VetraCloudEnvironmentDocument, type VetraCloudEnvironmentState, type VetraCloudAppLink, type BackupSchedule, type VetraCloudManagedBy } from "../../document-models/vetra-cloud-environment/index.js";
 import { syncEnvironment, deleteEnvironmentFromGitops, getTenantId } from "./gitops.js";
 import { removeEnvironmentRecord, tenantIdOwner } from "./cleanup.js";
 import type { DB } from "./schema.js";
@@ -179,6 +179,7 @@ export class VetraCloudEnvironmentProcessor implements IProcessor {
         ...appLinkColumns(state),
         ...orgColumns(state),
         ...backupScheduleColumn(state),
+        ...managedByColumn(state),
       };
 
       // createdBy is INSERT-only — never overwritten by later updates.
@@ -344,6 +345,17 @@ export function backupScheduleColumn(state: {
   return { backupSchedule: schedule ? JSON.stringify(schedule) : null };
 }
 
+/**
+ * Read-model column mirroring the system-only `state.managedBy` as JSON. Read
+ * by myEnvironments; NULL for an environment no licence template manages.
+ */
+export function managedByColumn(state: {
+  managedBy?: VetraCloudManagedBy | null;
+}): { managedBy: string | null } {
+  const managed = state.managedBy ?? null;
+  return { managedBy: managed ? JSON.stringify(managed) : null };
+}
+
 /** Columns the public host lookup reads to rebuild an env's generated hosts. */
 export function hostColumns(state: {
   genericBaseDomain?: string | null;
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-cloud-observability/schema.ts b/subgraphs/vetra-cloud-observability/schema.ts
--- a/subgraphs/vetra-cloud-observability/schema.ts
+++ b/subgraphs/vetra-cloud-observability/schema.ts
@@ -424,6 +424,16 @@ export const schema: DocumentNode = gql`
     ownerOrgId: String
     """Addresses allowed to sign on an organisation environment (lowercased)."""
     orgOperators: [String!]!
+    """The licence template that manages this environment (a holder's App environment); null for every other environment."""
+    managedBy: VetraCloudEnvManagedBy
+  }
+
+  type VetraCloudEnvManagedBy {
+    appId: String!
+    templateId: String!
+    rootLicenseId: String!
+    """Service types the template owns (their versions and the FUSION image are locked for the holder)."""
+    services: [String!]!
   }
 
   type VetraCloudEnvPackage {
PATCH
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-cloud-observability/resolvers.ts b/subgraphs/vetra-cloud-observability/resolvers.ts
--- a/subgraphs/vetra-cloud-observability/resolvers.ts
+++ b/subgraphs/vetra-cloud-observability/resolvers.ts
@@ -1154,6 +1154,18 @@ export function createResolvers(
         packageRegistryResolvers.Mutation.setDefaultPackageRegistry,
     },
 
+    // Its own lookup, so the list query (and its read-model column set)
+    // stays as it was: only a client asking for managedBy pays for it.
+    VetraCloudEnvironmentSummary: {
+      managedBy: async (parent: { id: string }) => {
+        const row = (await envDb
+          .selectFrom("environments")
+          .select("managedBy")
+          .where("id", "=", parent.id)
+          .executeTakeFirst()) as { managedBy: string | null } | undefined;
+        return parseManagedBy(row?.managedBy ?? null);
+      },
+    },
     ReleaseHistoryEntry: {},
     ReleaseIndexEntry: {},
     ClintRuntimeEndpointsForPrefix: {},
@@ -1161,6 +1173,21 @@ export function createResolvers(
   };
 }
 
+/** The read model's managedBy JSON, or null when absent or unreadable. */
+export function parseManagedBy(
+  raw: string | null,
+): { appId: string; templateId: string; rootLicenseId: string; services: string[] } | null {
+  if (!raw) return null;
+  try {
+    const v = JSON.parse(raw) as Record<string, unknown>;
+    if (typeof v.appId !== "string" || typeof v.templateId !== "string" || typeof v.rootLicenseId !== "string") return null;
+    const services = Array.isArray(v.services) ? v.services.filter((s): s is string => typeof s === "string") : [];
+    return { appId: v.appId, templateId: v.templateId, rootLicenseId: v.rootLicenseId, services };
+  } catch {
+    return null;
+  }
+}
+
 /** Shape of environments-table row the bump helpers read. */
 export type EnvForBump = {
   id: string;
PATCH
```

- [ ] **Step 4: Run them and see them pass.**
Run: `npx vitest run processors subgraphs/vetra-cloud-observability && npm run tsc 2>&1 | tail -3`
Expected: all PASS, including every existing `myEnvironments` test (its own `environments` table has no `managedBy` column; the list query does not read it).

- [ ] **Step 5: Commit.**
```bash
git add processors/vetra-cloud-environment/{schema,migrations,processor,read-model.test}.ts subgraphs/vetra-cloud-observability/{schema,resolvers}.ts subgraphs/vetra-cloud-observability/__tests__/my-environments.test.ts
git commit -m "feat(observability): expose managedBy in the environment read model and myEnvironments" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 14: The release operations and the read side

**Files:**
- Modify: `subgraphs/vetra-licensing/publisher-errors.ts` (two `NOT_FOUND` classes)
- Create: `subgraphs/vetra-licensing/release-service.ts`
- Test: `subgraphs/vetra-licensing/__tests__/release-service.test.ts`

**Interfaces:**
- Consumes: `RolloutStore` (Task 2), `CANARY_CHANNEL` (Task 4), `ChainEnvRows` (`forApp`, `byEnvironment`, `update`), `AppReads`, `AppLicensingWriter`, `actions.setArtifactChannel` from `document-models/vetra-app`.
- Produces: `UnknownEnvironmentError`, `UnknownRolloutError` (code `NOT_FOUND`); `interface ReleaseServiceDeps { store; envRows; apps; appWriter; envState; kick?; newId; now }`; `MAX_NOTICE_HOURS = 720`, `HISTORY_LIMIT = 20`; `releaseSettings(deps, appId)`; `setReleasePolicy(deps, { appId, policy, defaultNoticeHours? }): Promise<ReleaseSettings>`; `setCanaryEnvironment(deps, { appId, environmentId, canary, callerDid }): Promise<boolean>`; `promoteRelease(deps, { appId, artifactName, version, noticeHours?, promotedBy }): Promise<AppRollouts>`; `resumeRollout(deps, { appId, rolloutId })`; `forceEnvironmentUpdate(deps, { appId, environmentId })`; `requestUpdateNow(deps, row: LicenseEnvironments)`; `releaseCandidates(deps, appId): Promise<ReleaseCandidate[]>`; `rolloutsOf(deps, appId): Promise<RolloutView[]>` (`RolloutView = AppRollouts & { counts }`); `environmentUpdate(deps, environmentId): Promise<EnvironmentUpdateView>` (`{ open: { toVersion, dueAt, status, canUpdateNow } | null; history: EnvironmentUpdates[] }`); `environmentRelease(deps, environmentId)` (`{ runningVersion, isCanary, update }`). See D8, D13, D14.

- [ ] **Step 1: Write the failing test.** Create `subgraphs/vetra-licensing/__tests__/release-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { Action } from "document-model";
import { up } from "../db/migrations.js";
import type { EnvironmentUpdates, LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import type { AppDocView } from "../app-reads.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import { createRolloutStore } from "../rollout-db.js";
import {
  environmentRelease, environmentUpdate, forceEnvironmentUpdate, promoteRelease, releaseCandidates,
  requestUpdateNow, resumeRollout, rolloutsOf, setCanaryEnvironment, setReleasePolicy, type ReleaseServiceDeps,
} from "../release-service.js";

const NOW = "2026-11-10T12:00:00.000Z";
const PUBLISHER = "did:pkh:eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSTOMER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";

let db: Kysely<VetraLicensingDB>;
let deps: ReleaseServiceDeps;
let app: AppDocView;
let written: Action[];
let states: Map<string, { status: string; version: string | null }>;
let kicks: number;

const envRow = (environment_id: string, user_did: string, over: Partial<LicenseEnvironments> = {}): LicenseEnvironments => ({
  environment_id, root_license_id: `l-${environment_id}`, app_id: "a", user_did, license_id: `l-${environment_id}`,
  template_id: "t", label: null, template_hash: "h", channel_override: null, ended_at: null, stopped_at: null,
  delete_after: null, created_at: NOW, updated_at: NOW, ...over,
});
const update = (over: Partial<EnvironmentUpdates> = {}): EnvironmentUpdates => ({
  id: "u1", rollout_id: null, environment_id: "cust", app_id: "a", from_version: "1.0.0", to_version: "1.1.0",
  status: "PENDING", due_at: NOW, requested_at: null, started_at: null, finished_at: null, pre_update_dump_id: null,
  error: null, forced_at: null, created_at: NOW, ...over,
});

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  app = {
    id: "a", name: "Sektar", slug: "sektar", owner: "0xo", status: "ACTIVE", identityDid: null, productionEnvironmentId: null,
    templates: [], terms: [],
    artifacts: [{
      kind: "FUSION_IMAGE", name: "host",
      versions: [{ version: "1.0.0", reference: "cr.vetra.io/p/host:1.0.0" }, { version: "1.1.0", reference: "cr.vetra.io/p/host:1.1.0" }],
      channels: [{ channel: "LATEST", version: "1.0.0" }],
    }],
    tampered: false, tamperReason: null, licensingStateHash: "x", unverified: false,
  };
  written = [];
  states = new Map();
  kicks = 0;
  let n = 0;
  deps = {
    store: createRolloutStore(db),
    envRows: createChainEnvironmentRows(db, loadLicensingConfig({})),
    apps: { app: async (id) => (id === "a" ? app : null) },
    appWriter: { appendLicensingOps: async (_id, actions) => { written.push(...actions); } },
    envState: async (id) => {
      const s = states.get(id);
      return s ? ({ status: s.status, services: [{ type: "FUSION", version: s.version }] } as never) : null;
    },
    kick: () => { kicks++; },
    newId: () => `r${++n}`,
    now: () => NOW,
  };
  await db.insertInto("license_environments").values([envRow("mine", PUBLISHER), envRow("cust", CUSTOMER)]).execute();
});
afterEach(async () => { await db.destroy(); });

const markCanary = () => setCanaryEnvironment(deps, { appId: "a", environmentId: "mine", canary: true, callerDid: PUBLISHER });

describe("setReleasePolicy", () => {
  it("refuses GATED without a canary", async () => {
    await expect(setReleasePolicy(deps, { appId: "a", policy: "GATED" })).rejects.toThrow(/canary/);
    expect((await deps.store.settings("a")).policy).toBe("AUTO");
  });

  it("gates with a canary and points STAGING at LATEST where it has no pointer", async () => {
    await markCanary();
    expect(await setReleasePolicy(deps, { appId: "a", policy: "GATED", defaultNoticeHours: 24 }))
      .toStrictEqual({ appId: "a", policy: "GATED", defaultNoticeHours: 24 });
    expect(written.map((a) => [a.type, a.input])).toStrictEqual([
      ["SET_ARTIFACT_CHANNEL", { kind: "FUSION_IMAGE", name: "host", channel: "STAGING", version: "1.0.0" }],
    ]);
    app.artifacts[0]!.channels.push({ channel: "STAGING", version: "1.1.0" });
    written.length = 0;
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    expect(written).toStrictEqual([]);
    expect((await deps.store.settings("a")).defaultNoticeHours).toBe(24);
  });

  it("refuses an unknown policy and a notice out of range", async () => {
    await expect(setReleasePolicy(deps, { appId: "a", policy: "SOMETIMES" })).rejects.toThrow(/policy must be one of AUTO, GATED/);
    await expect(setReleasePolicy(deps, { appId: "a", policy: "AUTO", defaultNoticeHours: -1 })).rejects.toThrow(/noticeHours/);
    await expect(setReleasePolicy(deps, { appId: "a", policy: "AUTO", defaultNoticeHours: 1.5 })).rejects.toThrow(/noticeHours/);
  });
});

describe("setCanaryEnvironment", () => {
  it("marks only the caller's own environment of the app", async () => {
    await expect(setCanaryEnvironment(deps, { appId: "a", environmentId: "cust", canary: true, callerDid: PUBLISHER })).rejects.toThrow(/hold yourself/);
    await expect(setCanaryEnvironment(deps, { appId: "b", environmentId: "mine", canary: true, callerDid: PUBLISHER })).rejects.toThrow("no such environment");
    expect(await markCanary()).toBe(true);
    expect((await deps.envRows.byEnvironment("mine"))!.channel_override).toBe("STAGING");
    expect(kicks).toBe(1);
  });

  it("keeps the last canary of a gated app", async () => {
    await markCanary();
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    await expect(setCanaryEnvironment(deps, { appId: "a", environmentId: "mine", canary: false, callerDid: PUBLISHER })).rejects.toThrow(/needs a canary/);
    await setReleasePolicy(deps, { appId: "a", policy: "AUTO" });
    await setCanaryEnvironment(deps, { appId: "a", environmentId: "mine", canary: false, callerDid: PUBLISHER });
    expect((await deps.envRows.byEnvironment("mine"))!.channel_override).toBeNull();
  });
});

describe("promoteRelease", () => {
  const promote = (over: { version?: string; noticeHours?: number | null } = {}) =>
    promoteRelease(deps, { appId: "a", artifactName: "host", version: "1.1.0", promotedBy: "0xAAAA", ...over });

  beforeEach(async () => {
    await markCanary();
  });

  it("refuses an app that is not gated", async () => {
    await expect(promote()).rejects.toThrow(/not gated/);
  });

  it("refuses until a canary is READY on the version", async () => {
    await setReleasePolicy(deps, { appId: "a", policy: "GATED" });
    states.set("mine", { status: "DEPLOYING", version: "1.1.0" });
    await expect(promote()).rejects.toThrow("no canary environment of this app is READY on 1.1.0");
    await expect(promote({ version: "9.9.9" })).rejects.toThrow("host has no published version 9.9.9");
  });

  it("moves LATEST, supersedes the previous rollout and is due after the notice", async () => {
    await setReleasePolicy(deps, { appId: "a", policy: "GATED", defaultNoticeHours: 72 });
    states.set("mine", { status: "READY", version: "1.1.0" });
    const first = await promote({ noticeHours: 0 });
    expect(first).toMatchObject({ id: "r1", status: "ACTIVE", apply_after: NOW, promoted_by: "0xaaaa" });
    const second = await promote();
    expect(second.apply_after).toBe("2026-11-13T12:00:00.000Z");
    expect((await deps.store.rollout("r1"))!.status).toBe("SUPERSEDED");
    expect(written.filter((a) => a.type === "SET_ARTIFACT_CHANNEL").at(-1)!.input)
      .toStrictEqual({ kind: "FUSION_IMAGE", name: "host", channel: "LATEST", version: "1.1.0" });
  });
});

describe("resumeRollout, forceEnvironmentUpdate and requestUpdateNow", () => {
  const rollout = (status: "ACTIVE" | "PAUSED") =>
    deps.store.promote({ id: "r1", app_id: "a", artifact_name: "host", version: "1.1.0", status, apply_after: NOW, promoted_by: "0xp", promoted_at: NOW, paused_at: null, paused_reason: null });

  it("resumes only the app's own PAUSED rollout", async () => {
    await rollout("ACTIVE");
    await expect(resumeRollout(deps, { appId: "b", rolloutId: "r1" })).rejects.toThrow("no such rollout");
    await expect(resumeRollout(deps, { appId: "a", rolloutId: "r1" })).rejects.toThrow(/is ACTIVE, not PAUSED/);
    await deps.store.pause("r1", "x", NOW);
    expect(await resumeRollout(deps, { appId: "a", rolloutId: "r1" })).toBe(true);
  });

  it("forces a waiting or failed update, and nothing else", async () => {
    await expect(forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" })).rejects.toThrow(/no update/);
    await deps.store.insertUpdate(update({ status: "FAILED", error: "boom", started_at: NOW, finished_at: NOW }));
    expect(await forceEnvironmentUpdate(deps, { appId: "a", environmentId: "cust" })).toBe(true);
    expect(await deps.store.update("u1")).toMatchObject({ status: "PENDING", forced_at: NOW, requested_at: NOW, started_at: null });
  });

  it("requests a PENDING update now, unless its rollout is paused", async () => {
    const row = (await deps.envRows.byEnvironment("cust"))!;
    await expect(requestUpdateNow(deps, row)).rejects.toThrow(/no update/);
    await rollout("PAUSED");
    await deps.store.insertUpdate(update({ rollout_id: "r1" }));
    await expect(requestUpdateNow(deps, row)).rejects.toThrow(/paused/);
    await deps.store.resume("r1");
    expect(await requestUpdateNow(deps, row)).toBe(true);
    expect((await deps.store.update("u1"))!.requested_at).toBe(NOW);
  });
});

describe("the read side", () => {
  it("lists each FUSION image's STAGING, LATEST and what the canaries run", async () => {
    await markCanary();
    app.artifacts[0]!.channels.push({ channel: "STAGING", version: "1.1.0" });
    states.set("mine", { status: "READY", version: "1.1.0" });
    expect(await releaseCandidates(deps, "a")).toStrictEqual([
      { artifactName: "host", staging: "1.1.0", latest: "1.0.0", canaries: [{ environmentId: "mine", version: "1.1.0", status: "READY" }] },
    ]);
    expect(await releaseCandidates(deps, "unknown")).toStrictEqual([]);
  });

  it("counts a rollout's updates by status", async () => {
    await deps.store.promote({ id: "r1", app_id: "a", artifact_name: "host", version: "1.1.0", status: "ACTIVE", apply_after: NOW, promoted_by: "0xp", promoted_at: NOW, paused_at: null, paused_reason: null });
    await deps.store.insertUpdate(update({ rollout_id: "r1" }));
    expect((await rolloutsOf(deps, "a"))[0]).toMatchObject({ id: "r1", counts: [{ status: "PENDING", count: 1 }] });
  });

  it("shows the holder the open update and whether it can be applied now", async () => {
    expect(await environmentUpdate(deps, "cust")).toStrictEqual({ open: null, history: [] });
    await deps.store.insertUpdate(update());
    expect((await environmentUpdate(deps, "cust")).open).toStrictEqual({ toVersion: "1.1.0", dueAt: NOW, status: "PENDING", canUpdateNow: true });
    await deps.store.patchUpdate("u1", { requested_at: NOW });
    expect((await environmentUpdate(deps, "cust")).open!.canUpdateNow).toBe(false);
  });

  it("gives the publisher an environment's running version, canary flag and update", async () => {
    await markCanary();
    states.set("mine", { status: "READY", version: "1.1.0" });
    await deps.store.insertUpdate(update({ environment_id: "mine", status: "SUCCEEDED" }));
    expect(await environmentRelease(deps, "mine")).toStrictEqual({
      runningVersion: "1.1.0", isCanary: true, update: { status: "SUCCEEDED", toVersion: "1.1.0", dueAt: NOW, error: null },
    });
    expect(await environmentRelease(deps, "cust")).toStrictEqual({ runningVersion: null, isCanary: false, update: null });
  });
});

describe("a tampered app", () => {
  it("is never written to", async () => {
    await markCanary();
    app = { ...app, tampered: true, tamperReason: "x" };
    await expect(setReleasePolicy(deps, { appId: "a", policy: "GATED" })).rejects.toThrow(/held/);
    expect(written).toStrictEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release-service.test.ts`
Expected: FAIL, `Failed to load url ../release-service.js`.

- [ ] **Step 3: Add the errors and the service.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/publisher-errors.ts b/subgraphs/vetra-licensing/publisher-errors.ts
--- a/subgraphs/vetra-licensing/publisher-errors.ts
+++ b/subgraphs/vetra-licensing/publisher-errors.ts
@@ -54,6 +54,19 @@ export class UnknownTermError extends Error {
     super("no such term");
   }
 }
+/** An environment id that is not a chain environment the caller may reach (spec 4.5). */
+export class UnknownEnvironmentError extends Error {
+  override name = "UnknownEnvironmentError";
+  constructor() {
+    super("no such environment");
+  }
+}
+export class UnknownRolloutError extends Error {
+  override name = "UnknownRolloutError";
+  constructor() {
+    super("no such rollout");
+  }
+}
 export class UnknownInviteCodeError extends Error {
   override name = "UnknownInviteCodeError";
   constructor() {
@@ -179,6 +192,8 @@ const byCode = (): Array<[string, Array<abstract new (...a: never[]) => Error>]>
       UnknownTermError,
       UnknownInviteCodeError,
       UnknownTenantError,
+      UnknownEnvironmentError,
+      UnknownRolloutError,
     ],
   ],
   ["FORBIDDEN", [ForbiddenError, UnknownAppIdentityError]],
PATCH
```

Create `subgraphs/vetra-licensing/release-service.ts`:

```ts
import { actions as appActions } from "document-models/vetra-app";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { AppDocView, AppReads } from "./app-reads.js";
import { CANARY_CHANNEL } from "./channel-override.js";
import type { AppRollouts, EnvironmentUpdates, LicenseEnvironments, ReleasePolicy, UpdateStatus } from "./db/schema.js";
import type { ChainEnvRows } from "./environments.js";
import type { AppLicensingWriter } from "./licensing-ledger.js";
import {
  AppTamperedError,
  ForbiddenError,
  InvalidPublisherInputError,
  OperationRejectedError,
  UnknownEnvironmentError,
  UnknownRolloutError,
} from "./publisher-errors.js";
import type { ReleaseSettings, RolloutStore } from "./rollout-db.js";

/** The longest notice a promotion may give: 30 days. */
export const MAX_NOTICE_HOURS = 24 * 30;
/** How many past updates environmentUpdate returns. */
export const HISTORY_LIMIT = 20;

export interface ReleaseServiceDeps {
  store: RolloutStore;
  envRows: Pick<ChainEnvRows, "forApp" | "byEnvironment" | "update">;
  /** Ledger-checked app reads: a tampered app is refused. */
  apps: Pick<AppReads, "app">;
  /** The only route for app document writes (SET_ARTIFACT_CHANNEL): keeps the ledger valid. */
  appWriter: AppLicensingWriter;
  envState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
  /** Asks the handler for a tick now; never throws. */
  kick?: () => void;
  newId(): string;
  now(): string;
}

const POLICIES: readonly ReleasePolicy[] = ["AUTO", "GATED"];
const fusionVersionOf = (state: VetraCloudEnvironmentState | null): string | null =>
  state?.services.find((s) => s.type === "FUSION")?.version ?? null;
const isCanary = (row: LicenseEnvironments): boolean => (row.channel_override ?? null) !== null;
const addHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

function noticeHours(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_NOTICE_HOURS) {
    throw new InvalidPublisherInputError(`noticeHours must be a whole number from 0 to ${MAX_NOTICE_HOURS}`);
  }
  return value;
}

async function writableApp(deps: ReleaseServiceDeps, appId: string): Promise<AppDocView> {
  const app = await deps.apps.app(appId);
  if (!app) throw new InvalidPublisherInputError(`app ${appId} has no readable document`);
  if (app.tampered) throw new AppTamperedError(app.id);
  return app;
}

const liveCanaries = async (deps: ReleaseServiceDeps, appId: string): Promise<LicenseEnvironments[]> =>
  (await deps.envRows.forApp(appId)).filter((r) => isCanary(r) && r.ended_at === null);

/** The app's environment, or UnknownEnvironmentError: another app's fails like a missing one. */
async function envOf(deps: ReleaseServiceDeps, appId: string, environmentId: string): Promise<LicenseEnvironments> {
  const row = await deps.envRows.byEnvironment(environmentId);
  if (!row || row.app_id !== appId) throw new UnknownEnvironmentError();
  return row;
}

const kick = (deps: ReleaseServiceDeps) => {
  try {
    deps.kick?.();
  } catch {
    // A failed kick only means the next scheduled tick does it.
  }
};

export const releaseSettings = (deps: ReleaseServiceDeps, appId: string): Promise<ReleaseSettings> =>
  deps.store.settings(appId);

/**
 * Sets the app's release policy (spec 4.1). GATED needs a live canary, and
 * points STAGING at LATEST's version for every FUSION image that has no
 * STAGING yet, so the canary keeps its image. `defaultNoticeHours` absent:
 * unchanged.
 */
export async function setReleasePolicy(
  deps: ReleaseServiceDeps,
  input: { appId: string; policy: string; defaultNoticeHours?: number | null },
): Promise<ReleaseSettings> {
  const policy = POLICIES.find((p) => p === input.policy);
  if (!policy) throw new InvalidPublisherInputError(`policy must be one of ${POLICIES.join(", ")}`);
  const current = await deps.store.settings(input.appId);
  const next: ReleaseSettings = {
    appId: input.appId,
    policy,
    defaultNoticeHours:
      input.defaultNoticeHours === null || input.defaultNoticeHours === undefined
        ? current.defaultNoticeHours
        : noticeHours(input.defaultNoticeHours),
  };
  if (policy === "GATED") {
    if ((await liveCanaries(deps, input.appId)).length === 0) {
      throw new OperationRejectedError("mark one of your environments as a canary before gating releases");
    }
    const app = await writableApp(deps, input.appId);
    const seed = app.artifacts.flatMap((a) => {
      const latest = a.channels.find((c) => c.channel === "LATEST");
      if (a.kind !== "FUSION_IMAGE" || !latest || a.channels.some((c) => c.channel === "STAGING")) return [];
      return [appActions.setArtifactChannel({ kind: "FUSION_IMAGE", name: a.name, channel: "STAGING", version: latest.version })];
    });
    if (seed.length > 0) await deps.appWriter.appendLicensingOps(app.id, seed);
  }
  await deps.store.saveSettings(next, deps.now());
  kick(deps);
  return next;
}

/**
 * Marks (or unmarks) a canary (spec 4.2): the caller's own environment of the
 * app, which then follows STAGING. The last canary of a GATED app cannot be
 * unmarked: its releases would have nowhere to go.
 */
export async function setCanaryEnvironment(
  deps: ReleaseServiceDeps,
  input: { appId: string; environmentId: string; canary: boolean; callerDid: string },
): Promise<boolean> {
  const row = await envOf(deps, input.appId, input.environmentId);
  if (input.canary && row.user_did !== input.callerDid) {
    throw new ForbiddenError("only an environment you hold yourself can be a canary");
  }
  if (!input.canary && isCanary(row) && (await deps.store.settings(input.appId)).policy === "GATED") {
    const others = (await liveCanaries(deps, input.appId)).filter((r) => r.environment_id !== row.environment_id);
    if (others.length === 0) {
      throw new OperationRejectedError("a gated app needs a canary: switch the policy to AUTO first, or mark another");
    }
  }
  await deps.envRows.update(row.environment_id, {
    channel_override: input.canary ? CANARY_CHANNEL : null,
    updated_at: deps.now(),
  });
  kick(deps);
  return true;
}

/**
 * Promotes a version the canary runs to the app's customers (spec 4.3):
 * refused unless the app is GATED and a canary is READY on it; LATEST moves
 * to it, any ACTIVE or PAUSED rollout of the artifact is superseded, and the
 * customers are due `noticeHours` (default: the app's) from now.
 */
export async function promoteRelease(
  deps: ReleaseServiceDeps,
  input: { appId: string; artifactName: string; version: string; noticeHours?: number | null; promotedBy: string },
): Promise<AppRollouts> {
  const settings = await deps.store.settings(input.appId);
  if (settings.policy !== "GATED") {
    throw new OperationRejectedError("releases of this app are not gated: CI moves LATEST itself");
  }
  const hours =
    input.noticeHours === null || input.noticeHours === undefined
      ? settings.defaultNoticeHours
      : noticeHours(input.noticeHours);
  const app = await writableApp(deps, input.appId);
  const artifact = app.artifacts.find((a) => a.kind === "FUSION_IMAGE" && a.name === input.artifactName);
  if (!artifact?.versions.some((v) => v.version === input.version)) {
    throw new InvalidPublisherInputError(`${input.artifactName} has no published version ${input.version}`);
  }
  let healthy = false;
  for (const canary of await liveCanaries(deps, app.id)) {
    const state = await deps.envState(canary.environment_id);
    if (state?.status === "READY" && fusionVersionOf(state) === input.version) healthy = true;
  }
  if (!healthy) throw new OperationRejectedError(`no canary environment of this app is READY on ${input.version}`);

  // LATEST first: should the rollout insert then fail, customers wait (an
  // unpromoted version is held) and promoting again finishes it.
  await deps.appWriter.appendLicensingOps(app.id, [
    appActions.setArtifactChannel({ kind: "FUSION_IMAGE", name: input.artifactName, channel: "LATEST", version: input.version }),
  ]);
  const now = deps.now();
  const rollout: AppRollouts = {
    id: deps.newId(),
    app_id: app.id,
    artifact_name: input.artifactName,
    version: input.version,
    status: "ACTIVE",
    apply_after: addHours(now, hours),
    promoted_by: input.promotedBy.toLowerCase(),
    promoted_at: now,
    paused_at: null,
    paused_reason: null,
  };
  await deps.store.promote(rollout);
  kick(deps);
  return rollout;
}

/** Resumes a PAUSED rollout; its FAILED updates are PENDING again (spec 4.3). */
export async function resumeRollout(
  deps: ReleaseServiceDeps,
  input: { appId: string; rolloutId: string },
): Promise<boolean> {
  const rollout = await deps.store.rollout(input.rolloutId);
  if (!rollout || rollout.app_id !== input.appId) throw new UnknownRolloutError();
  if (!(await deps.store.resume(rollout.id))) {
    throw new OperationRejectedError(`rollout ${rollout.id} is ${rollout.status}, not PAUSED`);
  }
  kick(deps);
  return true;
}

/**
 * The publisher's force (spec 4.3): the environment's waiting (PENDING) or
 * FAILED update applies on the next tick, despite its deadline, a pause or a
 * version the floor cannot order; still one environment of the app at a
 * time, and never to a provably older version.
 */
export async function forceEnvironmentUpdate(
  deps: ReleaseServiceDeps,
  input: { appId: string; environmentId: string },
): Promise<boolean> {
  const row = await envOf(deps, input.appId, input.environmentId);
  const update = await deps.store.latest(row.environment_id);
  if (!update || (update.status !== "PENDING" && update.status !== "FAILED")) {
    throw new OperationRejectedError("no update of this environment is waiting or failed");
  }
  const now = deps.now();
  await deps.store.patchUpdate(update.id, {
    status: "PENDING",
    forced_at: now,
    requested_at: update.requested_at ?? now,
    started_at: null,
    finished_at: null,
  });
  kick(deps);
  return true;
}

/** "Update now" (spec 4.3): the environment's PENDING update is due at once; refused while its rollout is paused. */
export async function requestUpdateNow(deps: ReleaseServiceDeps, row: LicenseEnvironments): Promise<boolean> {
  const update = await deps.store.latest(row.environment_id);
  if (update?.status !== "PENDING") throw new OperationRejectedError("no update of this environment is waiting");
  const rollout = update.rollout_id ? await deps.store.rollout(update.rollout_id) : null;
  if (rollout?.status === "PAUSED") {
    throw new OperationRejectedError("this update is paused until the publisher resumes the release");
  }
  if (update.requested_at === null) await deps.store.patchUpdate(update.id, { requested_at: deps.now() });
  kick(deps);
  return true;
}

export interface ReleaseCandidate {
  artifactName: string;
  staging: string | null;
  latest: string | null;
  canaries: { environmentId: string; version: string | null; status: string | null }[];
}

/** Per FUSION image: STAGING, LATEST and what each canary runs (spec 4.5). */
export async function releaseCandidates(deps: ReleaseServiceDeps, appId: string): Promise<ReleaseCandidate[]> {
  const app = await deps.apps.app(appId);
  if (!app) return [];
  const canaries = await Promise.all(
    (await liveCanaries(deps, appId)).map(async (r) => {
      const state = await deps.envState(r.environment_id);
      return { environmentId: r.environment_id, version: fusionVersionOf(state), status: state?.status ?? null };
    }),
  );
  return app.artifacts
    .filter((a) => a.kind === "FUSION_IMAGE")
    .map((a) => ({
      artifactName: a.name,
      staging: a.channels.find((c) => c.channel === "STAGING")?.version ?? null,
      latest: a.channels.find((c) => c.channel === "LATEST")?.version ?? null,
      canaries,
    }));
}

export type RolloutView = AppRollouts & { counts: { status: UpdateStatus; count: number }[] };

/** The app's rollouts, newest first, with their updates counted by status. */
export async function rolloutsOf(deps: ReleaseServiceDeps, appId: string): Promise<RolloutView[]> {
  return Promise.all(
    (await deps.store.rolloutsOf(appId)).map(async (r) => ({ ...r, counts: await deps.store.countsByStatus(r.id) })),
  );
}

export interface EnvironmentUpdateView {
  open: { toVersion: string; dueAt: string; status: UpdateStatus; canUpdateNow: boolean } | null;
  history: EnvironmentUpdates[];
}

/** The holder's view (spec 4.5): the open update and the last HISTORY_LIMIT updates. */
export async function environmentUpdate(deps: ReleaseServiceDeps, environmentId: string): Promise<EnvironmentUpdateView> {
  const history = await deps.store.history(environmentId, HISTORY_LIMIT);
  const open = history.find((u) => u.status === "PENDING" || u.status === "APPLYING") ?? null;
  const rollout = open?.rollout_id ? await deps.store.rollout(open.rollout_id) : null;
  return {
    open: open && {
      toVersion: open.to_version,
      dueAt: open.due_at,
      status: open.status,
      canUpdateNow: open.status === "PENDING" && open.requested_at === null && rollout?.status !== "PAUSED",
    },
    history,
  };
}

/** PublisherEnvironment's release fields (spec 4.5). */
export async function environmentRelease(deps: ReleaseServiceDeps, environmentId: string) {
  const [row, state, update] = await Promise.all([
    deps.envRows.byEnvironment(environmentId),
    deps.envState(environmentId),
    deps.store.latest(environmentId),
  ]);
  return {
    runningVersion: fusionVersionOf(state),
    isCanary: row ? isCanary(row) : false,
    update: update && { status: update.status, toVersion: update.to_version, dueAt: update.due_at, error: update.error },
  };
}
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release-service.test.ts subgraphs/vetra-licensing/__tests__/publisher-errors.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 16 release-service tests PASS; publisher-errors tests unchanged and PASS.

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/publisher-errors.ts subgraphs/vetra-licensing/release-service.ts subgraphs/vetra-licensing/__tests__/release-service.test.ts
git commit -m "feat(licensing): release policy, canary, promote, resume, force and update now" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 15: The vetraReleases GraphQL surface (4.5)

**Files:**
- Create: `subgraphs/vetra-licensing/releases-schema.ts`, `subgraphs/vetra-licensing/releases-resolvers.ts`
- Modify: `subgraphs/vetra-licensing/schema.ts` (compose `releasesSchema`)
- Test: `subgraphs/vetra-licensing/__tests__/releases-api.test.ts`

**Interfaces:**
- Consumes: everything Task 14 produces; `resolveOwnerApp`, `NotAppOwnerError`, `UnknownAppError`, `PublisherAuthDeps`; `callerDid`; `makeRequireEnabled`; `toLicensingGraphQLError`.
- Produces: `releasesSchema: DocumentNode` (types `AppReleaseSettings`, `AppReleaseCanary`, `AppReleaseCandidate`, `AppRolloutStatusCount`, `AppRollout`, `EnvironmentUpdateRecord`, `OpenEnvironmentUpdate`, `HolderEnvironmentUpdate`, `PublisherEnvironmentUpdate`, `extend type PublisherEnvironment { runningVersion, isCanary, update }`, `VetraReleasesQueries { releaseSettings, releaseCandidates, rollouts, environmentUpdate }`, `VetraReleasesMutations { setReleasePolicy, setCanaryEnvironment, promoteRelease, resumeRollout, forceEnvironmentUpdate, updateEnvironmentNow }`, root field `vetraReleases`); `interface ReleaseResolverDeps extends ReleaseServiceDeps { auth: PublisherAuthDeps; cfg: Pick<LicensingConfig, "enabled"> }`; `createReleaseResolvers(deps): Record<string, unknown>` with keys `Query`, `Mutation`, `VetraReleasesQueries`, `VetraReleasesMutations`, `PublisherEnvironment` (D1).

- [ ] **Step 1: Write the failing test.** Create `subgraphs/vetra-licensing/__tests__/releases-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { buildASTSchema, type GraphQLError, type GraphQLObjectType } from "graphql";
import { up } from "../db/migrations.js";
import type { LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import type { AppDocView } from "../app-reads.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows } from "../environments.js";
import { createRolloutStore } from "../rollout-db.js";
import { createReleaseResolvers, type ReleaseResolverDeps } from "../releases-resolvers.js";
import { schema } from "../schema.js";

const NOW = "2026-11-10T12:00:00.000Z";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOLDER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const as = (address: string) => ({ user: { address }, isAdmin: () => false });
type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;
type Resolvers = {
  VetraReleasesQueries: Record<string, Field>;
  VetraReleasesMutations: Record<string, Field>;
  PublisherEnvironment: Record<string, (p: unknown) => Promise<unknown>>;
};

async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as GraphQLError).extensions?.code ?? `UNMAPPED: ${String(e)}`;
  }
}

const APP: AppDocView = {
  id: "a", name: "Sektar", slug: "sektar", owner: OWNER, status: "ACTIVE", identityDid: null, productionEnvironmentId: null,
  templates: [], terms: [], artifacts: [], tampered: false, tamperReason: null, licensingStateHash: "x", unverified: false,
};
const envRow = (environment_id: string, address: string): LicenseEnvironments => ({
  environment_id, root_license_id: `l-${environment_id}`, app_id: "a", user_did: `did:pkh:eip155:1:${address}`,
  license_id: `l-${environment_id}`, template_id: "t", label: null, template_hash: "h", channel_override: null,
  ended_at: null, stopped_at: null, delete_after: null, created_at: NOW, updated_at: NOW,
});

let db: Kysely<VetraLicensingDB>;
let deps: ReleaseResolverDeps;
let r: Resolvers;
beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  deps = {
    auth: {
      findAppById: async (id) => (id === "a" ? { id, name: "Sektar", status: "ACTIVE", owner_address: OWNER } : null),
      listAppsForOwner: async () => [],
    },
    cfg: { enabled: true },
    store: createRolloutStore(db),
    envRows: createChainEnvironmentRows(db, loadLicensingConfig({})),
    apps: { app: async (id) => (id === "a" ? APP : null) },
    appWriter: { appendLicensingOps: async () => {} },
    envState: async () => null,
    newId: () => "r1",
    now: () => NOW,
  };
  r = createReleaseResolvers(deps) as unknown as Resolvers;
  await db.insertInto("license_environments").values([envRow("cust", HOLDER), envRow("mine", OWNER)]).execute();
  await deps.store.insertUpdate({
    id: "u1", rollout_id: null, environment_id: "cust", app_id: "a", from_version: "1.0.0", to_version: "1.1.0",
    status: "PENDING", due_at: NOW, requested_at: null, started_at: null, finished_at: null, pre_update_dump_id: null,
    error: null, forced_at: null, created_at: NOW,
  });
});
afterEach(async () => { await db.destroy(); });

const q = (field: string, args: object, who = OWNER) => r.VetraReleasesQueries[field]!({}, args, as(who));
const m = (field: string, args: object, who = OWNER) => r.VetraReleasesMutations[field]!({}, args, as(who));

describe("the vetraReleases schema", () => {
  it("builds with the subgraph's schema and extends PublisherEnvironment", () => {
    const built = buildASTSchema(schema);
    expect(Object.keys((built.getType("Query") as GraphQLObjectType).getFields())).toContain("vetraReleases");
    expect(Object.keys((built.getType("PublisherEnvironment") as GraphQLObjectType).getFields()))
      .toEqual(expect.arrayContaining(["rootLicenseId", "runningVersion", "isCanary", "update"]));
    expect(Object.keys((built.getType("VetraReleasesMutations") as GraphQLObjectType).getFields())).toStrictEqual([
      "setReleasePolicy", "setCanaryEnvironment", "promoteRelease", "resumeRollout", "forceEnvironmentUpdate", "updateEnvironmentNow",
    ]);
  });
});

describe("vetraReleases app fields: the app's owner only", () => {
  it("answers the owner and refuses anyone else as NOT_FOUND", async () => {
    expect(await q("releaseSettings", { appId: "a" })).toStrictEqual({ appId: "a", policy: "AUTO", defaultNoticeHours: 72 });
    expect(await codeOf(q("releaseSettings", { appId: "a" }, STRANGER))).toBe("NOT_FOUND");
    expect(await codeOf(q("rollouts", { appId: "nope" }))).toBe("NOT_FOUND");
    expect(await codeOf(m("setReleasePolicy", { appId: "a", policy: "AUTO" }, STRANGER))).toBe("NOT_FOUND");
    expect(await q("rollouts", { appId: "a" })).toStrictEqual([]);
  });

  it("maps refusals to the contract's codes", async () => {
    expect(await codeOf(m("setReleasePolicy", { appId: "a", policy: "GATED" }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("setCanaryEnvironment", { appId: "a", environmentId: "cust", canary: true }))).toBe("FORBIDDEN");
    expect(await codeOf(m("setCanaryEnvironment", { appId: "a", environmentId: "nope", canary: true }))).toBe("NOT_FOUND");
    expect(await codeOf(m("resumeRollout", { appId: "a", rolloutId: "nope" }))).toBe("NOT_FOUND");
    expect(await m("setCanaryEnvironment", { appId: "a", environmentId: "mine", canary: true })).toBe(true);
  });

  it("refuses writes while licensing is switched off, after authorising", async () => {
    r = createReleaseResolvers({ ...deps, cfg: { enabled: false } }) as unknown as Resolvers;
    expect(await codeOf(m("setReleasePolicy", { appId: "a", policy: "AUTO" }))).toBe("LICENSING_DISABLED");
    expect(await codeOf(m("setReleasePolicy", { appId: "a", policy: "AUTO" }, STRANGER))).toBe("NOT_FOUND");
    expect(await codeOf(q("releaseSettings", { appId: "a" }))).toBe("OK");
  });
});

describe("vetraReleases environment fields: the holder, or the app's owner", () => {
  it("shows the holder their update and lets them apply it now", async () => {
    expect(await q("environmentUpdate", { environmentId: "cust" }, HOLDER)).toMatchObject({
      open: { toVersion: "1.1.0", status: "PENDING", canUpdateNow: true },
      history: [{ id: "u1", fromVersion: "1.0.0", toVersion: "1.1.0", status: "PENDING" }],
    });
    expect(await m("updateEnvironmentNow", { environmentId: "cust" }, HOLDER)).toBe(true);
    expect((await deps.store.update("u1"))!.requested_at).toBe(NOW);
  });

  it("lets the app's owner apply it too, and nobody else", async () => {
    expect(await m("updateEnvironmentNow", { environmentId: "cust" })).toBe(true);
    expect(await codeOf(q("environmentUpdate", { environmentId: "cust" }, STRANGER))).toBe("NOT_FOUND");
    expect(await codeOf(m("updateEnvironmentNow", { environmentId: "nope" }, HOLDER))).toBe("NOT_FOUND");
    expect(await codeOf(m("updateEnvironmentNow", { environmentId: "mine" }, HOLDER))).toBe("NOT_FOUND");
    expect(await codeOf(r.VetraReleasesQueries.environmentUpdate!({}, { environmentId: "cust" }, {}))).toBe("UNAUTHENTICATED");
  });

  it("resolves PublisherEnvironment's release fields from one read per environment", async () => {
    const parent = { environmentId: "cust" };
    expect(await r.PublisherEnvironment.isCanary!(parent)).toBe(false);
    expect(await r.PublisherEnvironment.runningVersion!(parent)).toBeNull();
    expect(await r.PublisherEnvironment.update!(parent)).toStrictEqual({ status: "PENDING", toVersion: "1.1.0", dueAt: NOW, error: null });
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/releases-api.test.ts`
Expected: FAIL, `Failed to load url ../releases-resolvers.js`.

- [ ] **Step 3: Write the schema and resolvers, and compose the schema.** Create `subgraphs/vetra-licensing/releases-schema.ts`:

```ts
import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

/**
 * App release rollout (spec 2026-11-10 §4.5). Its own root, vetraReleases,
 * so the vetraPublisher and vetraSubscriptions contracts stay exactly as
 * written. App fields authorise the app's owner on every call, as
 * vetraPublisher does; environment fields take the environment's holder or
 * the owner of its app. Enum-valued fields travel as String.
 */
export const releasesSchema: DocumentNode = gql`
  type AppReleaseSettings {
    appId: String!
    "AUTO | GATED"
    policy: String!
    defaultNoticeHours: Int!
  }

  type AppReleaseCanary {
    environmentId: String!
    "The FUSION version it runs; null before it has one."
    version: String
    "The environment status (READY when healthy); null when its document is gone."
    status: String
  }

  "One FUSION image: what STAGING and LATEST point at, and what each canary runs."
  type AppReleaseCandidate {
    artifactName: String!
    staging: String
    latest: String
    canaries: [AppReleaseCanary!]!
  }

  type AppRolloutStatusCount {
    "PENDING | APPLYING | SUCCEEDED | REVERTED | RESTORED | FAILED | SUPERSEDED"
    status: String!
    count: Int!
  }

  type AppRollout {
    id: String!
    artifactName: String!
    version: String!
    "ACTIVE | PAUSED | SUPERSEDED | COMPLETE"
    status: String!
    applyAfter: String!
    promotedBy: String!
    promotedAt: String!
    pausedAt: String
    "Names the environment whose update failed, and why."
    pausedReason: String
    counts: [AppRolloutStatusCount!]!
  }

  type EnvironmentUpdateRecord {
    id: String!
    fromVersion: String!
    toVersion: String!
    "PENDING | APPLYING | SUCCEEDED | REVERTED | RESTORED | FAILED | SUPERSEDED"
    status: String!
    dueAt: String!
    requestedAt: String
    startedAt: String
    finishedAt: String
    "Why it failed, or why it needs attention while PENDING."
    error: String
    createdAt: String!
  }

  type OpenEnvironmentUpdate {
    toVersion: String!
    dueAt: String!
    "PENDING | APPLYING"
    status: String!
    canUpdateNow: Boolean!
  }

  type HolderEnvironmentUpdate {
    "The update waiting or applying; null when the environment is current."
    open: OpenEnvironmentUpdate
    "The last 20 updates, newest first."
    history: [EnvironmentUpdateRecord!]!
  }

  type PublisherEnvironmentUpdate {
    status: String!
    toVersion: String!
    dueAt: String!
    error: String
  }

  extend type PublisherEnvironment {
    "The FUSION version the environment runs."
    runningVersion: String
    "Follows STAGING and takes releases first."
    isCanary: Boolean!
    "The newest update that was not superseded."
    update: PublisherEnvironmentUpdate
  }

  type VetraReleasesQueries {
    releaseSettings(appId: String!): AppReleaseSettings!
    releaseCandidates(appId: String!): [AppReleaseCandidate!]!
    rollouts(appId: String!): [AppRollout!]!
    "The environment's holder, or the owner of its app."
    environmentUpdate(environmentId: String!): HolderEnvironmentUpdate!
  }

  type VetraReleasesMutations {
    "defaultNoticeHours absent: unchanged. GATED requires a canary."
    setReleasePolicy(appId: String!, policy: String!, defaultNoticeHours: Int): AppReleaseSettings!
    "Only an environment you hold yourself can be a canary."
    setCanaryEnvironment(appId: String!, environmentId: String!, canary: Boolean!): Boolean!
    "noticeHours absent: the app's default; 0 for an urgent fix."
    promoteRelease(appId: String!, artifactName: String!, version: String!, noticeHours: Int): AppRollout!
    resumeRollout(appId: String!, rolloutId: String!): Boolean!
    forceEnvironmentUpdate(appId: String!, environmentId: String!): Boolean!
    "The environment's holder, or the owner of its app."
    updateEnvironmentNow(environmentId: String!): Boolean!
  }

  extend type Query {
    vetraReleases: VetraReleasesQueries!
  }

  extend type Mutation {
    vetraReleases: VetraReleasesMutations!
  }
`;
```

Create `subgraphs/vetra-licensing/releases-resolvers.ts`:

```ts
import { UnauthenticatedError, type AuthContext } from "./auth.js";
import type { AppRollouts, EnvironmentUpdates, LicenseEnvironments } from "./db/schema.js";
import { callerDid } from "./did.js";
import type { LicensingConfig } from "./config.js";
import { toLicensingGraphQLError, UnknownEnvironmentError } from "./publisher-errors.js";
import { NotAppOwnerError, resolveOwnerApp, UnknownAppError, type PublisherAuthDeps } from "./publisher-auth.js";
import {
  environmentRelease,
  environmentUpdate,
  forceEnvironmentUpdate,
  promoteRelease,
  releaseCandidates,
  releaseSettings,
  requestUpdateNow,
  resumeRollout,
  rolloutsOf,
  setCanaryEnvironment,
  setReleasePolicy,
  type ReleaseServiceDeps,
  type RolloutView,
} from "./release-service.js";
import { makeRequireEnabled } from "./resolvers.js";

export interface ReleaseResolverDeps extends ReleaseServiceDeps {
  auth: PublisherAuthDeps;
  cfg: Pick<LicensingConfig, "enabled">;
}

type Ctx = AuthContext & { isAdmin?: (a: string) => boolean };
type Opt<T> = T | null | undefined;

const rolloutOut = (r: AppRollouts | RolloutView) => ({
  id: r.id,
  artifactName: r.artifact_name,
  version: r.version,
  status: r.status,
  applyAfter: r.apply_after,
  promotedBy: r.promoted_by,
  promotedAt: r.promoted_at,
  pausedAt: r.paused_at,
  pausedReason: r.paused_reason,
  counts: "counts" in r ? r.counts : [],
});

const updateOut = (u: EnvironmentUpdates) => ({
  id: u.id,
  fromVersion: u.from_version,
  toVersion: u.to_version,
  status: u.status,
  dueAt: u.due_at,
  requestedAt: u.requested_at,
  startedAt: u.started_at,
  finishedAt: u.finished_at,
  error: u.error,
  createdAt: u.created_at,
});

/**
 * vetraReleases (releases-schema.ts). App fields: the app's owner, checked on
 * every call (resolveOwnerApp), and for writes the deployment switch after
 * it. Environment fields: its holder (the chain row's DID), or the owner of
 * its app; anyone else's environment fails like a missing one.
 */
export function createReleaseResolvers(deps: ReleaseResolverDeps): Record<string, unknown> {
  const requireEnabled = makeRequireEnabled(deps.cfg);
  const withCodes =
    <A, R>(fn: (a: A, c: Ctx) => Promise<R>) =>
    async (_p: unknown, a: A, c: Ctx): Promise<R> => {
      try {
        return await fn(a, c);
      } catch (err) {
        throw toLicensingGraphQLError(err);
      }
    };
  const owned = async (appId: string, ctx: Ctx, write: boolean): Promise<string> => {
    const { appId: id } = await resolveOwnerApp(deps.auth, ctx, appId);
    if (write) requireEnabled();
    return id;
  };
  const reachable = async (environmentId: string, ctx: Ctx, write: boolean): Promise<LicenseEnvironments> => {
    const did = callerDid(ctx);
    if (!did) throw new UnauthenticatedError("sign in with Renown");
    const row = await deps.envRows.byEnvironment(environmentId);
    if (!row) throw new UnknownEnvironmentError();
    if (row.user_did !== did) {
      try {
        await resolveOwnerApp(deps.auth, ctx, row.app_id);
      } catch (err) {
        if (err instanceof NotAppOwnerError || err instanceof UnknownAppError) throw new UnknownEnvironmentError();
        throw err;
      }
    }
    if (write) requireEnabled();
    return row;
  };

  /** One read of an environment's release fields per parent object (one request). */
  const releases = new WeakMap<object, ReturnType<typeof environmentRelease>>();
  const releaseOf = (p: { environmentId: string }) => {
    let r = releases.get(p);
    if (!r) releases.set(p, (r = environmentRelease(deps, p.environmentId)));
    return r;
  };

  return {
    Query: { vetraReleases: () => ({}) },
    Mutation: { vetraReleases: () => ({}) },

    VetraReleasesQueries: {
      releaseSettings: withCodes(async (a: { appId: string }, ctx) => releaseSettings(deps, await owned(a.appId, ctx, false))),
      releaseCandidates: withCodes(async (a: { appId: string }, ctx) =>
        releaseCandidates(deps, await owned(a.appId, ctx, false)),
      ),
      rollouts: withCodes(async (a: { appId: string }, ctx) =>
        (await rolloutsOf(deps, await owned(a.appId, ctx, false))).map(rolloutOut),
      ),
      environmentUpdate: withCodes(async (a: { environmentId: string }, ctx) => {
        const view = await environmentUpdate(deps, (await reachable(a.environmentId, ctx, false)).environment_id);
        return { open: view.open, history: view.history.map(updateOut) };
      }),
    },

    VetraReleasesMutations: {
      setReleasePolicy: withCodes(
        async (a: { appId: string; policy: string; defaultNoticeHours?: Opt<number> }, ctx) =>
          setReleasePolicy(deps, { ...a, appId: await owned(a.appId, ctx, true) }),
      ),
      setCanaryEnvironment: withCodes(
        async (a: { appId: string; environmentId: string; canary: boolean }, ctx) => {
          const appId = await owned(a.appId, ctx, true);
          const did = callerDid(ctx);
          if (!did) throw new UnauthenticatedError("sign in with Renown");
          return setCanaryEnvironment(deps, { appId, environmentId: a.environmentId, canary: a.canary, callerDid: did });
        },
      ),
      promoteRelease: withCodes(
        async (a: { appId: string; artifactName: string; version: string; noticeHours?: Opt<number> }, ctx) => {
          const appId = await owned(a.appId, ctx, true);
          return rolloutOut(await promoteRelease(deps, { ...a, appId, promotedBy: ctx.user?.address ?? "" }));
        },
      ),
      resumeRollout: withCodes(async (a: { appId: string; rolloutId: string }, ctx) =>
        resumeRollout(deps, { appId: await owned(a.appId, ctx, true), rolloutId: a.rolloutId }),
      ),
      forceEnvironmentUpdate: withCodes(async (a: { appId: string; environmentId: string }, ctx) =>
        forceEnvironmentUpdate(deps, { appId: await owned(a.appId, ctx, true), environmentId: a.environmentId }),
      ),
      updateEnvironmentNow: withCodes(async (a: { environmentId: string }, ctx) =>
        requestUpdateNow(deps, await reachable(a.environmentId, ctx, true)),
      ),
    },

    // Reached only through vetraPublisher.environments, which authorised the app.
    PublisherEnvironment: {
      runningVersion: async (p: { environmentId: string }) => (await releaseOf(p)).runningVersion,
      isCanary: async (p: { environmentId: string }) => (await releaseOf(p)).isCanary,
      update: async (p: { environmentId: string }) => (await releaseOf(p)).update,
    },
  };
}
```

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/schema.ts b/subgraphs/vetra-licensing/schema.ts
--- a/subgraphs/vetra-licensing/schema.ts
+++ b/subgraphs/vetra-licensing/schema.ts
@@ -2,6 +2,7 @@ import { gql } from "graphql-tag";
 import { Kind, type DocumentNode } from "graphql";
 import { publisherSchema } from "./publisher-schema.js";
 import { subscriptionsSchema } from "./subscriptions-schema.js";
+import { releasesSchema } from "./releases-schema.js";
 
 /**
  * The machine surface (vetraLicensing, contract § vetraLicensing (machine)):
@@ -106,5 +107,6 @@ export const schema: DocumentNode = {
     ...machineSchema.definitions,
     ...publisherSchema.definitions,
     ...subscriptionsSchema.definitions,
+    ...releasesSchema.definitions,
   ],
 };
PATCH
```

- [ ] **Step 4: Run it and see it pass.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/releases-api.test.ts subgraphs/vetra-licensing/__tests__/schema-composition.test.ts subgraphs/vetra-licensing/__tests__/merge-resolvers.test.ts && npm run tsc 2>&1 | tail -3`
Expected: 7 releases-api tests PASS; `schema-composition.test.ts` PASSES unchanged (its exact field lists cover only vetraPublisher and vetraSubscriptions).

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-licensing/{releases-schema,releases-resolvers,schema}.ts subgraphs/vetra-licensing/__tests__/releases-api.test.ts
git commit -m "feat(licensing): vetraReleases API for publishers and holders" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 16: Wire it into the licensing subgraph

**Files:**
- Modify: `subgraphs/vetra-licensing/index.ts` (imports, after `onLicenceIssued`, before `this.resolvers`, `chainEnvDeps`, before the handler, the handler deps)

**Interfaces:**
- Consumes: `createRolloutStore` (Task 2), `createUpdateGate` (Task 7), `trackReleases` (Task 10), `createManagedBySync` (Task 12), `createReleaseResolvers` (Task 15), `HandlerDeps.afterChains` (Task 9), `ChainEnvDeps.updates` (Task 8).
- Produces: nothing new; production now gates, records, tracks, marks and serves `vetraReleases`.

There is no unit seam for `onSetup` (no existing test covers it). Its pieces are wired here exactly as the reactor-backed test of Task 17 wires them.

- [ ] **Step 1: Wire it.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-licensing/index.ts b/subgraphs/vetra-licensing/index.ts
--- a/subgraphs/vetra-licensing/index.ts
+++ b/subgraphs/vetra-licensing/index.ts
@@ -85,6 +85,11 @@ import { defaultRenownOrgs } from "../../shared/renown-orgs.js";
 import { adoptPersonAppsViaVetraApps } from "../../shared/person-app-adoption.js";
 import { ensureAppsOrgColumn } from "../vetra-apps/db/migrations.js";
 import { createRenownStatsClient, type RenownStatsClient } from "./renown-stats.js";
+import { createRolloutStore } from "./rollout-db.js";
+import { createUpdateGate } from "./update-gate.js";
+import { trackReleases } from "./release-tracker.js";
+import { createManagedBySync } from "./managed-by.js";
+import { createReleaseResolvers } from "./releases-resolvers.js";
 import {
   createReportingTokenIssuer,
   deleteReportingToken,
@@ -245,6 +250,9 @@ export class VetraLicensingSubgraph extends BaseSubgraph {
     // Late-bound: the handler is built after the resolvers. A no-op until then.
     let kick: (licenseId: string) => void = () => {};
     const onLicenceIssued = (licenseId: string) => kick(licenseId);
+    // App release rollout (spec 2026-11-10 §4): policy, canaries, rollouts
+    // and every environment's FUSION version moves.
+    const rollouts = createRolloutStore(db);
     const publisherResolvers = createPublisherResolvers({
       onLicenceIssued,
       // Ownership of environments comes from the apps tables, never documents.
@@ -355,6 +363,7 @@ export class VetraLicensingSubgraph extends BaseSubgraph {
       rows: chainRows,
       envs,
       generateSubdomain,
+      updates: createUpdateGate({ store: rollouts, logger: console }),
       ...(perm
         ? {
             warmPool: {
@@ -465,9 +474,23 @@ export class VetraLicensingSubgraph extends BaseSubgraph {
     };
     const machineResolvers = createResolvers(machineDeps) as Record<string, Record<string, unknown>>;
 
+    const releaseResolvers = createReleaseResolvers({
+      auth: { ...ownerLookup, orgs: defaultRenownOrgs() },
+      cfg,
+      store: rollouts,
+      envRows: chainRows,
+      apps: appReads,
+      appWriter,
+      envState: (id) => envs.getState(id),
+      // A canary flag, a promotion or an "update now" is acted on at once.
+      kick: () => kick(""),
+      newId: () => randomUUID(),
+      now: () => new Date().toISOString(),
+    }) as Record<string, Record<string, unknown>>;
+
     this.resolvers = mergeResolvers(
-      mergeResolvers(machineResolvers, publisherResolvers),
-      subscriptionResolvers,
+      mergeResolvers(mergeResolvers(machineResolvers, publisherResolvers), subscriptionResolvers),
+      releaseResolvers,
     );
 
     // vetra-app and licence documents are system-write-only. Protect every
@@ -544,6 +567,9 @@ export class VetraLicensingSubgraph extends BaseSubgraph {
       console.warn(`[licensing] migration not started: ${String(err)}`);
     }
 
+    // The managed-by marker (spec 4.4) on every chain environment.
+    const markManaged = createManagedBySync({ envs, logger: console });
+
     // Provisioning: one DEDICATED environment per licence chain. Inert unless
     // cfg.enabled (default false); dry-run (default true) only logs. It does
     // nothing at all until the startup migration has recorded `complete`.
@@ -565,6 +591,14 @@ export class VetraLicensingSubgraph extends BaseSubgraph {
         gateway.execute(licenseId, [licenseActions.setStage({ stage })]),
       onEnded: (_appId, env) => underChainOf(env, () => markEnded(offboarding, env)),
       onResumed: (_appId, env) => underChainOf(env, () => markResumed(offboarding, env)),
+      afterChains: async (app, rows) => {
+        await trackReleases(
+          { store: rollouts, envState: (id) => envs.getState(id), cfg, logger: console, now: () => new Date().toISOString() },
+          app,
+          rows,
+        );
+        await markManaged(app, rows);
+      },
       afterApp: async (_appId, rows, confirmedEndedRoots) => {
         await tickOffboarding(offboarding, confirmedEndedRows(rows, confirmedEndedRoots));
         // Live environments only; failures are caught per environment.
PATCH
```

- [ ] **Step 2: Type-check and lint.**
Run: `npm run tsc 2>&1 | tail -3 && npm run lint 2>&1 | grep "vetra-licensing/index.ts"`
Expected: nothing new.

- [ ] **Step 3: Run the whole suite.**
Run: `npm test 2>&1 | tail -6`
Expected: no file fails that passed at baseline; 10 more test files and about 110 more tests pass than at baseline.

- [ ] **Step 4: Commit.**
```bash
git add subgraphs/vetra-licensing/index.ts
git commit -m "feat(licensing): wire the release gate, tracking, managed-by sync and vetraReleases" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 17: The rollout end to end on a real reactor (spec §9)

**Files:**
- Test: `subgraphs/vetra-licensing/__tests__/release-rollout.integration.test.ts` (new)

**Interfaces:**
- Consumes: the production pieces wired as in Task 16: `provisionChain` with `createUpdateGate`, `AppLicenseHandler` with `afterChains` running `trackReleases` and `createManagedBySync`, and the Task 14 operations; real `vetra-app`, licence and environment documents.
- Produces: no code; it proves publish, canary update, promote, notice, update now, one environment at a time (two customers due at once), a failure pausing everyone, resume continuing, and completion. An AUTO app's behaviour is covered by the unchanged `handler-reactor.integration.test.ts`.

This test is written after the code because it exercises all of it at once; every behaviour in it is already test-driven in Tasks 2 to 15. If any step fails, that is a bug in an earlier task: fix it there (with a unit test), not in this file.

- [ ] **Step 1: Write the test.** Create `subgraphs/vetra-licensing/__tests__/release-rollout.integration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import {
  approveChanges,
  markChangesPushed,
  markDeploymentStarted,
  reportDeploymentFailed,
  reportDeploymentSucceeded,
  setLabel,
} from "document-models/vetra-cloud-environment";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { createReactorEnvGateway } from "../../vetra-apps/envs.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { APP_DOC_TYPE, createAppReads } from "../app-reads.js";
import { createReactorDocGateway } from "../doc-gateway.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createGrantStore } from "../grants.js";
import { issueLicense } from "../issue.js";
import { createAppLedger, createAppLicensingWriter, reactorLedgerSource } from "../licensing-ledger.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows, provisionChain, type ChainEnvDeps } from "../environments.js";
import { AppLicenseHandler } from "../handler.js";
import { createLifecycleStore } from "../lifecycle.js";
import { createRolloutStore } from "../rollout-db.js";
import { createUpdateGate } from "../update-gate.js";
import { trackReleases } from "../release-tracker.js";
import { createManagedBySync } from "../managed-by.js";
import {
  promoteRelease,
  requestUpdateNow,
  resumeRollout,
  setCanaryEnvironment,
  setReleasePolicy,
  type ReleaseServiceDeps,
} from "../release-service.js";

/**
 * The release rollout end to end (spec 2026-11-10 §9): a real reactor, real
 * environment and app documents, the production handler wiring (update gate,
 * release tracking, the managed-by marker) and the release operations. Only
 * gitops and ArgoCD are played by the test (deploy / fail below).
 */
const APP = "5d2c1b7a-5d4f-4e6a-8b9c-0d1e2f3a4b6d";
const PUBLISHER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSTOMER_1 = "0x1111111111111111111111111111111111111111";
const CUSTOMER_2 = "0x2222222222222222222222222222222222222222";
const CUSTOMER_3 = "0x3333333333333333333333333333333333333333";
const did = (address: string) => `did:pkh:eip155:1:${address}`;
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;
const ref = (v: string) => `cr.vetra.io/acme/web:${v}`;

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;

describe("app release rollout against a real reactor + real database", () => {
  let client: Client;
  let db: Kysely<VetraLicensingDB>;
  let handler: AppLicenseHandler;
  let envs: ReturnType<typeof createReactorEnvGateway>;
  let appDocs: ReturnType<typeof createReactorAppDocStore>;
  let service: ReleaseServiceDeps;
  let rollouts: ReturnType<typeof createRolloutStore>;
  let clock = T0;
  const now = () => new Date(clock).toISOString();
  const envOf: Record<string, string> = {};

  const rows = () => db.selectFrom("license_environments").selectAll().execute();
  const fusionVersion = async (id: string) => (await envs.getState(id))!.services.find((s) => s.type === "FUSION")?.version;
  /** What gitops and observability report once a rollout went well. */
  const deploy = (id: string) => envs.execute(id, [markChangesPushed({}), markDeploymentStarted({}), reportDeploymentSucceeded({})]);
  const fail = (id: string) =>
    envs.execute(id, [markChangesPushed({}), markDeploymentStarted({}), reportDeploymentFailed({ code: "CRASH", message: "boot loop" })]);
  const latestUpdate = (environmentId: string) => rollouts.latest(environmentId);
  const tick = () => handler.reconcileOnce();
  const publish = (version: string, channel: "STAGING" | "LATEST") =>
    appDocs.execute(APP, [
      appActions.recordArtifactVersion({ kind: "FUSION_IMAGE", name: "web", version, reference: ref(version), commitSha: null, runId: null, publishedAt: now() }),
      appActions.setArtifactChannel({ kind: "FUSION_IMAGE", name: "web", channel, version }),
    ]);

  beforeAll(async () => {
    client = await new ReactorClientBuilder()
      .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
      .build();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);

    const ledger = createAppLedger({ db, source: reactorLedgerSource(client as never), now });
    appDocs = createReactorAppDocStore(client as never, undefined, async () => ledger);
    await appDocs.create(APP);
    await appDocs.execute(APP, [
      appActions.addTemplate({ id: "host", name: null, mode: "DEDICATED" }),
      appActions.addTemplateService({ templateId: "host", id: "f", type: "FUSION", prefix: "web", artifactName: "web", artifactChannel: "LATEST" }),
      appActions.addTerm({ id: "k", kind: "pro", label: "Pro", templateId: "host", validityDays: null, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k" }),
    ]);
    await publish("1.0.0", "LATEST");

    const appReads = createAppReads(client as never, { ledger: ledger.lookup, heal: ledger.heal });
    expect(await appReads.app(APP)).toMatchObject({ tampered: false, unverified: false });
    const reads = createReactorLicenseReads(client as never);
    const lifecycle = createLifecycleStore(db, now);
    const licenseGateway = createReactorLicenseGateway(client as never, { lifecycle });
    const grants = createGrantStore(db);
    envs = createReactorEnvGateway(client as never);
    const cfg = { ...loadLicensingConfig({}), enabled: true, dryRun: false, scanIntervalMs: 1_000 };
    const chainRows = createChainEnvironmentRows(db, cfg);
    rollouts = createRolloutStore(db);
    const silent = { info: () => {}, warn: () => {}, error: () => {} };
    const chainEnvDeps: ChainEnvDeps = {
      rows: chainRows, envs, generateSubdomain, updates: createUpdateGate({ store: rollouts, logger: silent }),
    };
    const markManaged = createManagedBySync({ envs, logger: silent });
    handler = new AppLicenseHandler({
      licences: () => reads.allLicenceRecords(),
      chainRoots: () => grants.chainRoots(),
      grants: () => grants.provenance(),
      lifecycle: () => lifecycle.all(),
      chainLabel: (root) => grants.chainLabel(root),
      app: (id) => appReads.app(id),
      environments: (appId) => chainRows.forApp(appId),
      environmentAppIds: () => chainRows.appIds(),
      provision: (input) => provisionChain(chainEnvDeps, input),
      setStage: (licenseId, stage) => licenseGateway.execute(licenseId, [licenseActions.setStage({ stage })]),
      onEnded: async () => {},
      onResumed: async () => {},
      afterChains: async (app, after) => {
        await trackReleases({ store: rollouts, envState: (id) => envs.getState(id), cfg, logger: silent, now }, app, after);
        await markManaged(app, after);
      },
      afterApp: async () => {},
      migrationComplete: async () => true,
      cfg,
      logger: silent,
      now,
    });
    service = {
      store: rollouts,
      envRows: chainRows,
      apps: appReads,
      appWriter: createAppLicensingWriter({
        docs: createReactorDocGateway(client as never, APP_DOC_TYPE, "app", () => Promise.reject(new Error("never creates"))),
        ledger,
      }),
      envState: (id) => envs.getState(id),
      newId: () => randomUUID(),
      now,
    };

    const issueDeps: Parameters<typeof issueLicense>[0] = {
      owners: { findAppById: async (id) => (id === APP ? { id, name: "Web", status: "ACTIVE", owner_address: PUBLISHER } : null) },
      apps: appReads,
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: licenseGateway.create,
      executeLicence: licenseGateway.execute,
      grants,
      lifecycle,
      migrationComplete: async () => false,
      logger: silent,
    };
    for (const holder of [PUBLISHER, CUSTOMER_1, CUSTOMER_2, CUSTOMER_3]) {
      await issueLicense(issueDeps, { appId: APP, user: did(holder), kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: PUBLISHER, label: holder.slice(0, 6), now: now() });
    }
  }, 120_000);

  it("builds every holder's environment on LATEST and marks it managed by the app", async () => {
    await tick();
    const all = await rows();
    expect(all).toHaveLength(4);
    for (const r of all) {
      envOf[r.user_did] = r.environment_id;
      await deploy(r.environment_id);
      expect(await fusionVersion(r.environment_id)).toBe("1.0.0");
      expect((await envs.getState(r.environment_id))!.managedBy).toMatchObject({ appId: APP, templateId: "host", services: ["FUSION"] });
    }
  });

  it("gating needs a canary, and keeps the canary's image on STAGING", async () => {
    await expect(setReleasePolicy(service, { appId: APP, policy: "GATED" })).rejects.toThrow(/canary/);
    await setCanaryEnvironment(service, { appId: APP, environmentId: envOf[did(PUBLISHER)]!, canary: true, callerDid: did(PUBLISHER) });
    await setReleasePolicy(service, { appId: APP, policy: "GATED", defaultNoticeHours: 72 });
    const web = (await service.apps.app(APP))!.artifacts.find((a) => a.name === "web")!;
    expect(web.channels).toEqual(expect.arrayContaining([{ channel: "STAGING", version: "1.0.0" }]));
    await tick();
    expect(await latestUpdate(envOf[did(PUBLISHER)]!)).toBeNull();
  });

  it("a release goes to the canary first, and no further", async () => {
    await publish("1.1.0", "STAGING");
    await tick();
    const canary = envOf[did(PUBLISHER)]!;
    expect(await fusionVersion(canary)).toBe("1.1.0");
    expect(await latestUpdate(canary)).toMatchObject({ status: "APPLYING", rollout_id: null, to_version: "1.1.0" });
    for (const c of [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3]) expect(await fusionVersion(envOf[did(c)]!)).toBe("1.0.0");
    await deploy(canary);
    await tick();
    expect(await latestUpdate(canary)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("a promotion gives customers notice and changes nothing yet", async () => {
    const rollout = await promoteRelease(service, { appId: APP, artifactName: "web", version: "1.1.0", noticeHours: 24, promotedBy: PUBLISHER });
    expect(rollout).toMatchObject({ status: "ACTIVE", apply_after: new Date(T0 + 24 * HOUR).toISOString() });
    await tick();
    for (const c of [CUSTOMER_1, CUSTOMER_2, CUSTOMER_3]) {
      expect(await fusionVersion(envOf[did(c)]!)).toBe("1.0.0");
      expect(await latestUpdate(envOf[did(c)]!)).toMatchObject({ status: "PENDING", rollout_id: rollout.id, due_at: rollout.apply_after });
    }
  });

  it("'update now' applies one customer; its failure pauses the rollout for everyone", async () => {
    const one = envOf[did(CUSTOMER_1)]!;
    const two = envOf[did(CUSTOMER_2)]!;
    await requestUpdateNow(service, (await rows()).find((r) => r.environment_id === one)!);
    await tick();
    expect(await fusionVersion(one)).toBe("1.1.0");
    expect(await latestUpdate(one)).toMatchObject({ status: "APPLYING" });
    expect(await latestUpdate(two)).toMatchObject({ status: "PENDING" });
    await fail(one);
    await tick();
    expect(await latestUpdate(one)).toMatchObject({ status: "FAILED", error: "the deployment of 1.1.0 failed" });
    const [rollout] = await rollouts.rolloutsOf(APP);
    expect(rollout).toMatchObject({ status: "PAUSED", paused_reason: expect.stringContaining(one) });
    // Past the deadline, still paused: nobody else moves.
    clock = T0 + 25 * HOUR;
    await tick();
    for (const c of [CUSTOMER_2, CUSTOMER_3]) {
      expect(await fusionVersion(envOf[did(c)]!)).toBe("1.0.0");
      expect(await latestUpdate(envOf[did(c)]!)).toMatchObject({ status: "PENDING" });
    }
  });

  it("resume continues one environment at a time, and the rollout completes", async () => {
    const one = envOf[did(CUSTOMER_1)]!;
    const waiting = [envOf[did(CUSTOMER_2)]!, envOf[did(CUSTOMER_3)]!];
    const [rollout] = await rollouts.rolloutsOf(APP);
    await resumeRollout(service, { appId: APP, rolloutId: rollout!.id });
    // Both are due; only one moves per settled update.
    for (let round = 0; round < 2; round++) {
      await tick();
      const applying: string[] = [];
      for (const id of waiting) if ((await latestUpdate(id))?.status === "APPLYING") applying.push(id);
      expect(applying).toHaveLength(1);
      expect(await fusionVersion(applying[0]!)).toBe("1.1.0");
      await deploy(applying[0]!);
      await tick();
      expect(await latestUpdate(applying[0]!)).toMatchObject({ status: "SUCCEEDED" });
      waiting.splice(waiting.indexOf(applying[0]!), 1);
    }
    expect((await rollouts.rollout(rollout!.id))!.status).toBe("ACTIVE");
    // Someone fixes the failed environment: it redeploys and is READY on 1.1.0.
    await envs.execute(one, [setLabel({ label: "fixed" }), approveChanges({})]);
    await deploy(one);
    await tick();
    expect(await latestUpdate(one)).toMatchObject({ status: "SUCCEEDED" });
    expect((await rollouts.rollout(rollout!.id))!.status).toBe("COMPLETE");
  });
}, 300_000);
```

- [ ] **Step 2: Run it.**
Run: `npx vitest run subgraphs/vetra-licensing/__tests__/release-rollout.integration.test.ts`
Expected: 6 tests PASS (about 4 s).

- [ ] **Step 3: Check it can fail.** In `subgraphs/vetra-licensing/release-gate.ts` temporarily replace `else if (i.otherApplying) reason =` with `else if (false) reason =`, rerun the test, and see "resume continues one environment at a time, and the rollout completes" FAIL (`expected [ …(2) ] to have a length of 1 but got 2`). Undo with `git checkout -- subgraphs/vetra-licensing/release-gate.ts`.

- [ ] **Step 4: Commit.**
```bash
git add subgraphs/vetra-licensing/__tests__/release-rollout.integration.test.ts
git commit -m "test(licensing): app release rollout end to end on a real reactor" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 18: Pin the environment model's status spelling in fusion auto-update (4.6, D5)

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/fusion-auto-update.ts:8-16`
- Test: existing `subgraphs/vetra-cloud-observability/__tests__/fusion-auto-update.test.ts` (line 159 already bumps a `DEPLOYMENt_FAILED` environment); the guard itself is a type check.

**Interfaces:**
- Consumes: `VetraCloudEnvironmentStatus` (type only).
- Produces: nothing; behaviour unchanged.

- [ ] **Step 1: Show what the spec's "fix" would break.** In `fusion-auto-update.ts:16` change `"DEPLOYMENt_FAILED"` to `"DEPLOYMENT_FAILED"` and run `npx vitest run subgraphs/vetra-cloud-observability/__tests__/fusion-auto-update.test.ts`. Expected: `runFusionAutoUpdateOnce > retries an env whose last deploy failed` FAILS. Undo with `git checkout -- subgraphs/vetra-cloud-observability/fusion-auto-update.ts`.

- [ ] **Step 2: Pin the spelling to the model.**

```bash
git apply <<'PATCH'
diff --git a/subgraphs/vetra-cloud-observability/fusion-auto-update.ts b/subgraphs/vetra-cloud-observability/fusion-auto-update.ts
--- a/subgraphs/vetra-cloud-observability/fusion-auto-update.ts
+++ b/subgraphs/vetra-cloud-observability/fusion-auto-update.ts
@@ -5,6 +5,8 @@
  * only push images; nothing in their CI needs a platform credential.
  */
 
+import type { VetraCloudEnvironmentStatus } from "document-models/vetra-cloud-environment";
+
 export const DEFAULT_FUSION_TAG_PATTERN = "^sha-[0-9a-f]{7,40}$";
 export const FUSION_AUTO_UPDATE_INTERVAL_MS = 120_000;
 
@@ -12,8 +14,10 @@ export const FUSION_AUTO_UPDATE_INTERVAL_MS = 120_000;
  * Only settled envs are bumped: bumping approves, and approving a DRAFT or
  * CHANGES_PENDING env would ship the owner's unapproved edits. In-flight
  * deploys and sleeping/released envs catch up on a later tick.
+ * "DEPLOYMENt_FAILED" is not a typo to fix here: it is the environment
+ * model's own (misspelt) status value, and `satisfies` keeps the two in step.
  */
-const BUMPABLE_STATUSES = new Set(["READY", "DEPLOYMENt_FAILED"]);
+const BUMPABLE_STATUSES = new Set<string>(["READY", "DEPLOYMENt_FAILED"] satisfies VetraCloudEnvironmentStatus[]);
 
 export type HarborArtifact = {
   push_time: string;
PATCH
```

- [ ] **Step 3: Check the guard and the behaviour.**
Run: `npm run tsc 2>&1 | tail -3 && npx vitest run subgraphs/vetra-cloud-observability/__tests__/fusion-auto-update.test.ts`
Expected: `tsc` clean; 10 tests PASS. Then change the string to `"DEPLOYMENT_FAILED"` once more and run `npm run tsc`: it now FAILS (`error TS2820: Type '"DEPLOYMENT_FAILED"' is not assignable to type 'VetraCloudEnvironmentStatus'. Did you mean '"DEPLOYMENt_FAILED"'?`). Undo it.

- [ ] **Step 4: Final check of the branch.**
Run: `npm test 2>&1 | tail -6 && npm run tsc 2>&1 | tail -3 && npm run lint 2>&1 | tail -5 && npm run test:coverage 2>&1 | grep "All files"`
Expected: no failures beyond the baseline; nothing new from `tsc` or `lint`; reducer coverage at or above 95%. (Replayed from this plan on a copy of the branch before the install: the same 31 files fail to load as at baseline, 174 files and 2436 tests pass, and `tsc` and `lint` report exactly the baseline's findings.)

- [ ] **Step 5: Commit.**
```bash
git add subgraphs/vetra-cloud-observability/fusion-auto-update.ts
git commit -m "chore(observability): pin DEPLOYMENt_FAILED to the environment model's own status" -m "The spelling is the model's enum value, not a typo; satisfies keeps the two in step." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (sections 4.1 to 4.6):**

| Spec item | Task |
|---|---|
| 4.1 `app_release_settings` (policy, default notice, updated_at) | 1, 2 |
| 4.1 `ciRecordArtifact` LATEST to STAGING for GATED + FUSION_IMAGE; nothing else changes; deploy action untouched | 3 |
| 4.1 GATED requires a canary; seeds STAGING from LATEST when STAGING has no pointer | 14 (`setReleasePolicy`) |
| 4.2 `license_environments.channel_override`; every reference resolves on it; hash over the resolved set; canary takes a version on the next tick; more than one per app | 1, 4 (D6), 6 (canary is due at once) |
| 4.3 `app_rollouts`, `environment_updates` (all columns, unique (rollout_id, environment_id)) | 1 |
| 4.3 promote: needs a READY canary, supersedes ACTIVE/PAUSED, apply_after = now + notice, moves LATEST | 14 (D13), store in 2 |
| 4.3 pending updates created by the keeper, due_at = min(apply_after, superseded due_at), superseded row SUPERSEDED | 6, 7 |
| 4.3 canary updates get rows (rollout null, due now) | 6, 7 |
| 4.3 update now: sets requested_at, refused while PAUSED | 14, 15 |
| 4.3 gate: PENDING, due or requested, rollout ACTIVE (or canary), no other APPLYING; then APPLYING with started_at | 6, 7, 8 |
| 4.3 held environments apply everything else, no re-template budget, template_hash only when met | 5, 8, 9 (D10) |
| 4.3 outcome SUCCEEDED / FAILED (DEPLOYMENT_FAILED or `LICENSING_UPDATE_TIMEOUT_MS`, 20 min); failure pauses with the environment and error | 10 |
| 4.3 resume: PAUSED to ACTIVE, FAILED to PENDING; complete when nothing is PENDING or APPLYING | 2, 10 (D11, D12), 14 |
| 4.3 stranded: PENDING with error, logged once, force applies it | 5, 6, 7, 14 (D8) |
| 4.3 AUTO apps unchanged, rows created APPLYING | 6, 7, 8 |
| 4.4 `managedBy` + `SET_MANAGED_BY` in `SYSTEM_ONLY_OPERATIONS` | 11 (D2) |
| 4.4 keeper sets it on create and warm claim, backfills | 12, 16 (D4) |
| 4.4 reducer locks for user-signed actions; system passes; env, secrets, size, packages stay with the holder | 11 (D3) |
| 4.4 `myEnvironments` and the read model expose `managedBy` | 13 (D15) |
| 4.5 publisher reads and writes; `PublisherEnvironment` gains runningVersion, isCanary, update | 14, 15 (D1) |
| 4.5 holder `environmentUpdate` (open + last 20) and `updateEnvironmentNow` | 14, 15 |
| 4.6 the `DEPLOYMENt_FAILED` "typo" | 18 (D5: kept, pinned) |
| §9 unit and integration tests | every task; 17 |

**Placeholder scan:** no "TBD", "TODO" or "similar to Task N"; every code step carries the code or the exact patch; every command has its expected result.

**Type consistency:** checked across tasks: `ReleasePolicy` / `RolloutStatus` / `UpdateStatus` (Task 1) are the only status types used; `FusionMove` and `FusionVersionMode` (Task 5) are what `GateInput`, `GateDecision` (Task 6) and `UpdateGate.admit` (Task 7) use; `UpdateGate` is what `ChainEnvDeps.updates` (Task 8) and `index.ts` (Task 16) use; `ProvisionResult.versionHeld` (Task 8) is what `apply` reads (Task 9); `RolloutStore` method names (Task 2) match every call in Tasks 7, 10, 14; `ReleaseServiceDeps` (Task 14) is what `ReleaseResolverDeps` extends (Task 15) and Task 17 builds. Every patch and file in this plan was generated from a working copy in which each task's tests were run as the task was built, then replayed in plan order onto a fresh copy of this branch, with `tsc` run at every task boundary and the whole suite and lint at the end.
