# Releases phase 3, plan 8: own instances from a warm pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new holder of an **own** plan gets a running instance in the time of one pod restart instead of a cold create (namespace, database, certificate, first start), as Sektar's holders do today with licensing's warm pool (spec section 6 step 2 "create (from the warm pool when one fits)"; phase 2 gap 13; overview slice 8):
- each own plan may keep `warm_pool_size` pre-created instances on its current target and size, ownerless to the world: ingress closed, empty `ADMINS`;
- when plan sync would create an own instance for a new licence chain, it **claims** a ready warm instance instead: same row id, host, environment and tenant (so its generated master key, attachment secret and delivered settings stay valid), new holder;
- the claim's own reconciler pass writes the holder's `ADMINS`, and that one render opens the ingress;
- the pool refills; when the plan's target moves, warm instances are replaced, rolling, one creation per plan per pass;
- a chain that has a licensed environment (overview rule 1) never claims, and nothing ever claims for a shared plan.

**Architecture:**
- A pool member is an `instances` row (`kind = "own"`, new column `warm = true`, `holder_address` and `licence_root_id` NULL, `plan_id` set), as the overview says. The reconciler creates, updates, health-checks and removes it like any instance, so there is no second provisioning path and no second table. `app_warm_pool` (licensing) is untouched and keeps serving Sektar's licensed environments until slice 10.
- **Pool keeper** `syncPlanPools(deps, app)` (`plans/pool.ts`) runs in `reconcileApp` right after `syncPlanInstances`, under the App's lock. Per own plan it computes, with a pure function `planPool` modelled on licensing's `computeAppPoolPlan`, how many rows to create (0 or 1) and which unclaimed rows to remove (wrong target or size, surplus, plan retired, pool off).
- **Claim** `claimWarmInstance(db, …)` (`plans/pool-repo.ts`) is one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` like licensing's `claimOneAvailableIn`, plus its audit row in one transaction. `syncPlanInstances` calls it where it inserts an own row today; no ready warm row → the cold insert as today.
- **Closed until claimed.** The processor's warm lookup (`processors/vetra-cloud-environment/factory.ts` `isWarm`, which closes the FUSION ingress, `ingress.closed: true`) also answers for unclaimed pool rows, read from `instances` (`createInstancePoolLookup`). The claim writes the row first and the holder's `ADMINS` second, so the render that applies `ADMINS` is the first one that sees the row claimed, and it opens the ingress.
- **Removal.** `removeInstance` (which refuses plan instances today) deletes an unclaimed warm row's environment and the row; a claimed instance is never removed (unchanged).
- **Health.** The monitor judges warm rows from the cluster only (their ingress is closed, so host probes would always fail and a warm row would never become `ready` under `enforce`).

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph), the vetra-cloud-environment processor (gitops values).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 5 (own: one per holder, the plan's target, `ADMINS` = the holder, generated hosts `calm-bat-b4qzzqbb`);
- section 6 step 2 ("create (from the warm pool when one fits)") and "a failed create … leaves the instance on its previous digest";
- section 7 (targets of own instances move only through a rollout: a warm row is not a holder's instance and is replaced, not rolled);
- section 14 (cost and isolation: a warm instance serves nobody until claimed).

Slice scope: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` slice 8 (and rules 1, 2), phase 2 gap 13. Code this builds on: plan 1 (`plans/sync.ts`, `instances/*`, on `main`), plan 2 (audit), and licensing's warm pool (`subgraphs/vetra-licensing/warm-pool-keeper.ts`, `warm-pool-plan.ts`, `warm-pool-db.ts`, `warm-env.ts`, `environments.ts` `claimWarm`/`finishWarmClaim`). Slice 8 needs only slice 1; it may land before or after slice 3 (see "Interfaces").

## Decisions to confirm (recommended default first; the plan is written with the default)

- **W1 A pool member is an `instances` row** (`kind = own`, `warm = true`, no holder, no licence root), named `own-warm-<12 hex of sha256(row id)>`, on the plan's target and size. *Alternative:* a second table like `app_warm_pool`. Rejected: the reconciler, health, settings delivery, host labels and the processor's image allowlist (`app-image-project.ts` already vouches for any `instances` row with that `environment_id`) all work on rows already.
- **W2 Pool size.** `plans.warm_pool_size` (0-10, default 0), set by `updatePlanFor` for **own** plans only. The effective size is `min(warm_pool_size, VETRA_APPS_PLAN_POOL_MAX)`, and `VETRA_APPS_PLAN_POOL_MAX` defaults to **0** (pools off everywhere until an environment sets it; overview rule 3). Staging: 2. Production: per D10, with the plans switch. *Needs the user:* pool sizes for Sektar's own plans (overview "Needs the user").
- **W3 What can be claimed:** warm, not removed, no `stop_reason`, `status = ready`, `running_digest = target_digest` = the plan's **current** target digest, and `target_size` = the plan's size; the oldest ready first. A warm row on an older target is never claimed (after slice 3, R3: a new instance starts on the plan's target; before slice 3 it would be updated in place anyway). No ready row → cold create, as today.
- **W4 What the claim keeps and changes.** Keeps: row id, host (generated from the row id, so it is stable), environment, tenant id, the tenant's secrets (generated master key and attachment secret, which the warm host's database already uses), delivered settings, target. Changes: `holder_address`, `licence_root_id`, `name` (`ownInstanceName(root)`, as a cold row), `warm = false`, `claimed_at`, and the environment's label (`<App> · own-…` instead of `<App> · own (warm)`). The document owner stays the Vetra service identity (D2): no `SET_OWNER`, no protection step (licensing needs both because its warm documents are ownerless).
- **W5 Replace, never roll.** A warm row whose target or size differs from the plan's is removed and replaced: rolling, at most **one creation per plan per pass**; a stale row is removed only once the pool would otherwise be over size (so total environments of a pool stay at most `size + 1`). A warm database is never upgraded in place: a holder always gets an instance first started on the release they get.
- **W6 Failures.** A warm row whose create or start failed stays `failed` and keeps its slot (nothing is created in its place) until the plan's target or size moves, or the pool shrinks; then it is removed like a stale row. This bounds cost the way licensing's "3 consecutive WARMING timeouts halt the pool" does, without a counter. The console shows it.
- **W7 Health of warm rows** comes from the cluster only (pods ready on the wanted digest, Argo synced, no restarts); host probes are skipped while `warm` (ingress closed). After the claim, probes apply as for any instance.
- **W8 Who sets the size:** like the plan's other settings (`need: "release"`: operators and release managers), audited in `plan.updated` (`changes.warmPoolSize`). The console shows the monthly idle cost before saving (licensing's `estimateEnvironmentEurPerMonth(size)` × size). *Alternative:* `need: "operate"`, since it costs money.
- **W9 Scope.** Own plans only (a shared plan has one instance), never the Team plan, never chains with a licensed environment (sync skips them before it would create or claim), never while plans or instances are off, never for an App that does not want instances (`wantsInstances`), and nothing for a retired plan (its pool drains).
- **W10 Pool rows stay out of every holder path:** rollouts (slice 3 `plannedSteps`), pins, `myInstances` (no holder), the end-of-licence stop (plan sync's unserved loop; a pool row has no chain), slice 7's holder settings, support access and backups (until claimed), and slice 9's switch-over (which creates its own instance with restored data, never a claim).
- **W11 The warm host has run.** A claimed instance has been up for minutes to days on an empty database: the switchboard's server identity on `/data` was generated then, and nothing else is in it. This is what licensing's warm pool gives Sektar's holders today.
- **W12 Audit.** `instance.claimed` (subject `instance:<id>`, detail `planId`, `holder`, `licenceRoot`, `warmSince` = the row's `created_at`), written with the claim; warm rows' status changes are audited by slice 2's existing `instance.status` path like any instance. Pool creation and removal are not audited separately (their status rows show them).

## What exists today (checked 2026-11-12 on `main` = 0.0.117)

- **Licensing's warm pool (the model, not reused as code):**
  - `app_warm_pool (environment_id, app_id, template_id, template_hash, state WARMING|AVAILABLE|CLAIMED, created_at, ready_at, claimed_at, deleted_at, root_license_id, env_deleted_at, pool_size, timed_out_at)` (`warm-pool-db.ts`).
  - `warm-pool-plan.ts` `computeAppPoolPlan(rows, target, envStatus, maxPerTemplate, nowIso)` (pure): `remove` = rows on another template hash, dead or missing environments, WARMING longer than `MAX_WARMING_MS` (30 min), and the surplus (WARMING newest first, then AVAILABLE oldest first); `promote` = WARMING rows whose environment is READY; `create` = the deficit. A null target drains.
  - `warm-pool-keeper.ts` `AppWarmPoolKeeper`: one pool per (App, DEDICATED template) with `warmPoolSize > 0` and an ACTIVE term; `createsPerTick` budget, rotation, backoff after dead removals, halt after 3 consecutive timeouts (`MAX_CONSECUTIVE_TIMEOUTS`), durable deletion sweep (`awaitingDeletion`).
  - `warm-env.ts` `createWarmEnvironment`: ownerless document (`owner: null`, protected for the service identity first), label `<App> (warm)`, subdomain `generateSubdomain(id)`; the WARMING row is inserted before the actions so the first render already sees it warm.
  - `warm-pool-db.ts` `claimOneAvailableIn`: `UPDATE app_warm_pool SET state = CLAIMED … WHERE environment_id = (SELECT … WHERE state = AVAILABLE … ORDER BY ready_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`; `claimForChain` does it and the chain's `license_environments` row in one transaction.
  - `environments.ts` `finishWarmClaim`: `SET_OWNER` + the template floor (whose `ADMINS` follows the owner) + label + approve in **one batch** ("gitops re-renders once and the app restarts once"); "the claim must always re-render (the ingress opens once the row is CLAIMED)"; any failure discards the warm environment and builds cold.
  - `warm-cost.ts` `estimateEnvironmentEurPerMonth(size)`.
- **The processor** (`processors/vetra-cloud-environment/`):
  - `factory.ts`: `isWarm = (id) => createWarmPoolStore(licensingDb).isWarm(id)` (live, unclaimed `app_warm_pool` rows), passed to `createAppImageProjectResolver` and to the processor.
  - `gitops.ts` `generateValuesYaml`: `const warm = isWarm ? await lookupWarm(isWarm, documentId) : undefined;` → `generateFusionBlock(…, { warm: warm != null })` renders `ingress.closed: true` (`fusion.test.ts` "warm environment is closed"). Renders run on `CHANGES_APPROVED` (and `STOPPED`), never on a bare ownership change.
  - `app-image-project.ts` `lookupWarm` treats `42P01` (table missing) as "not warm" and **rethrows** anything else ("a warm environment can never render open by accident"). For an App-linked document, `createAppImageProjectResolver` vouches through `instances` (`app_id` + `environment_id`), so a pool row's image is already allowed.
- **Plan instances** (`subgraphs/vetra-apps/`):
  - `plans/sync.ts` `syncPlanInstances`: per live chain of an own plan, skipping `licensed.has(head.root)`: no row → `insertInstance(newRow(…, head))` when the plan has a target; else patch. Then the **unserved** loop: own rows not served by a live chain get `licence_ended_at` and, after `stopAfterDays`, `stop_reason = LICENCE_ENDED`. A pool row (no chain) would be "unserved" (fixed in Task 4).
  - `instances/host.ts` `planInstanceLabel`: own rows get `generateSubdomain(row.id)` (+ suffix), else `<slug>-own-<h>` hashed on `own:<licence_root_id ?? row.id>`. Both depend only on the row id for a pool row, so the host survives the claim.
  - `instances/reconciler.ts`: `reconcileApp` (sync branch, preview, plan instances; then each row); `adminsOf(app, row)` (own: the holder, else the App owner: a pool row would render the App owner); `createEnvironment` → `claimHost` → `initEnvironment` (`instanceCreateActions`, label `${app.name} · ${row.name}`, owner the service identity for plan kinds, role `PLAN`, size `target_size`); `reconcileEnvironment` (settings delivery to the tenant, start, update via `instanceUpdateActions(state, image, admins, settings, start, size)`, health, revert); `removeInstance` **throws** for plan kinds; `stopPlanInstance`.
  - `instances/monitor.ts` `checkInstance`: cluster verdict (`judgeCluster`), then host probes `https://<host>.vetra.io/ready` and `/` (`judgeProbes`); `health.ts` `HEALTHY` (not exported), `NO_DATA`.
  - `instances/repo.ts`: `insertInstance`, `updateInstance` (audits status changes), `deleteInstance`, `listInstances`, unique `(app_id, kind, name)`, `instances_host_uq`, `instances_environment_uq`, `instances_licence_root_uq (app_id, licence_root_id)`.
  - `instances/service.ts` `instanceJson`; `plans/service.ts` `updatePlanFor` (name, size; slice 3 adds policy, notice, window), `planJson`.
- **Config:** `PlansConfig { enabled, stopAfterDays }` (+ slice 3's `rolloutsHold?`, slice 6's `teamSoakMinutes?` when merged), `intIn(env, name, def, min, max)`.

## Interfaces with other slices

- **Slice 3 (rollouts)**, whichever lands second adds this (Task 9 here if slice 3 is already on `main`; otherwise the slice 3 executor adds it, and this plan's PR says so):
  - `rollouts/service.ts` `plannedSteps` skips `warm` rows (`!r.warm`), so a rollout never steps a pool row;
  - `rollouts/pins.ts` `pinInstance` refuses a warm row ("not a holder's instance");
  - slice 3's R3 ("new instances start on the plan's target") is what W3 relies on; the keeper replaces warm rows when `plans.target_version` moves at a rollout's start.
  - Slice 3 Task 7 makes `syncPlanInstances` stop moving existing targets; pool rows are not touched by that loop either way.
- **Slice 6 (Team):** Team is shared; `syncPlanPools` skips it by `access`.
- **Slice 7 (holders):** holder settings, the AI key and support access attach to the instance when it gets a holder. A claim is that moment, exactly as a cold create: slice 7 keys on `holder_address` being set, never on row creation, and treats `warm = true` rows as holderless.
- **Slice 9 (switch-over):** creates the switched holder's own instance itself (with restored data), and must not let `syncPlanInstances` claim a warm row for that chain first. Slice 9 links the chain (`licence_root_id`) on the row it creates before the plan adopts the kind, so sync finds the row and never reaches the claim.
- **Licensing:** nothing changes; `app_warm_pool` keeps Sektar's pools. The processor asks both lookups.

## Model (as built here)

**`plans`** — `warm_pool_size integer` (NULL = 0).

**`instances`** — `warm boolean` (true while a pool member, never true again after a claim), `claimed_at varchar(64)`; partial index `instances_warm_idx (app_id, plan_id) where warm = true` for the claim and the processor lookup.

| Pool row state | Columns |
|---|---|
| warming | `warm`, `status` `pending`/`updating` |
| claimable | `warm`, `status = ready`, `running_digest = target_digest = plan target digest`, `target_size = plan.size`, no `removed_at`, no `stop_reason` |
| failed | `warm`, `status = failed` (W6) |
| leaving | `warm`, `removed_at`, `removed_reason = "warm pool: <why>"` (the reconciler deletes the environment, then the row) |
| claimed | `warm = false`, `claimed_at`, `holder_address`, `licence_root_id` (an ordinary own instance from then on) |

**Config** — `PlansConfig.poolMax?: number` from `VETRA_APPS_PLAN_POOL_MAX` (0-10, default 0); `planPoolSize(cfg, plan)` = `min(plan.warm_pool_size ?? 0, poolMax)`.

**Constants** (`plans/pool.ts`) — `WARM_LABEL = "own (warm)"`, `warmInstanceName(id)`, `MAX_WARM_POOL_SIZE = 10`, removal reasons `POOL_STALE = "warm pool: the plan's target or size moved"`, `POOL_SURPLUS = "warm pool: over the pool size"`, `POOL_OFF = "warm pool: the plan has no pool"`.

## Global Constraints

- Additive schema only (idempotent, race-tolerant `ensure…` migrations; namespaced). New columns are optional (`?`) in `db/schema.ts`.
- Nothing changes while `VETRA_APPS_PLAN_POOL_MAX` is 0 or a plan's `warm_pool_size` is 0: no pool rows are made, and existing ones are removed (unclaimed only).
- A claimed instance, and any instance with a holder, is never removed or recycled by pool code. Only rows with `warm = true` and no holder are ever removed by it (asserted in `removeInstance`, tested).
- A warm row never renders with an open ingress: the processor treats an unreadable pool lookup as an error (it rethrows like `lookupWarm` does), except a missing column or table during boot (no pool row can exist then).
- The claim never happens for a chain with a licensed environment, never for a shared plan, and only under the App's lock (the reconciler pass).
- Commits: one per task, conventional (`feat(plans): …`, `feat(instances): …`, `feat(processor): …`, `feat(apps): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-warm-pool` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors/vetra-cloud-environment shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4): check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-apps/config.ts` | `PlansConfig.poolMax?`, `VETRA_APPS_PLAN_POOL_MAX`, `planPoolSize` |
| `subgraphs/vetra-apps/db/schema.ts` | `PlansTable.warm_pool_size?`; `InstancesTable.warm?`, `claimed_at?` |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureWarmPoolColumns` in `up` |
| `subgraphs/vetra-apps/audit/repo.ts` | `instance.claimed` |
| `subgraphs/vetra-apps/plans/pool.ts` (new) | constants, `planPool` (pure), `syncPlanPools`, `warmRow` |
| `subgraphs/vetra-apps/plans/pool-repo.ts` (new) | `claimWarmInstance` |
| `subgraphs/vetra-apps/plans/pool-lookup.ts` (new) | `createInstancePoolLookup` (for the processor) |
| `subgraphs/vetra-apps/plans/sync.ts` | claim before the cold insert; pool rows are never "unserved" |
| `subgraphs/vetra-apps/instances/reconciler.ts` | `syncPlanPools` in `reconcileApp`; `adminsOf` empty for warm rows; label on claim; `removeInstance` removes unclaimed warm rows |
| `subgraphs/vetra-apps/instances/render.ts` | `instanceUpdateActions(…, label?)` |
| `subgraphs/vetra-apps/instances/monitor.ts`, `health.ts` | warm rows: cluster only |
| `processors/vetra-cloud-environment/factory.ts` | `isWarm` asks licensing's pool, then the instances pool |
| `subgraphs/vetra-apps/plans/service.ts`, `instances/service.ts`, `schema.ts`, `resolvers.ts` | `warmPoolSize` (input and output), `warmPoolEffective`, `warmPoolEurPerMonth`; `AppInstance.warm`, `claimedAt` |
| `subgraphs/vetra-apps/rollouts/service.ts`, `rollouts/pins.ts` (only if slice 3 is merged) | skip and refuse warm rows |
| Tests (new) | `__tests__/pool-plan.test.ts`, `pool-claim.test.ts`, `pool-sync.test.ts`, `pool-reconcile.test.ts`, `pool-health.test.ts`, `pool-graphql.test.ts`; `processors/vetra-cloud-environment/pool-lookup.test.ts` |
| Tests (changed) | `config.test.ts`, `migrations.test.ts`, `instances-plans.test.ts` |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-3-warm-pool origin/main`. Never stash; never touch other worktrees (`git worktree list`).
- [ ] **Step 2: Baseline.** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors/vetra-cloud-environment shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record pre-existing failures in the PR.
- [ ] **Step 3: Slice 3?** `ls subgraphs/vetra-apps/rollouts/service.ts`. Present: Task 9 applies. Absent: skip Task 9 and write the slice 3 seam into the PR description.

---

### Task 1: Config, schema, audit action

**Files:**
- Modify: `subgraphs/vetra-apps/config.ts`, `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`, `subgraphs/vetra-apps/audit/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts`, `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Produces: `PlansConfig.poolMax?: number`; `VETRA_APPS_PLAN_POOL_MAX` (0-10, default 0); `planPoolSize(cfg, plan: Pick<PlanRow, "warm_pool_size" | "access" | "status" | "team">): number` (0 unless the plan is active, own and not Team); `PlansTable.warm_pool_size?: number | null`; `InstancesTable.warm?: boolean | null`, `claimed_at?: string | null`; `ensureWarmPoolColumns(db)`; audit action `"instance.claimed"`.

- [ ] **Step 1: Write the failing tests.**
  - `config.test.ts`: the default `plans` gains `poolMax: 0`, and

```ts
  it("reads VETRA_APPS_PLAN_POOL_MAX (0-10, default 0) and caps a plan's pool with it", () => {
    expect(loadAppsConfig({}).plans?.poolMax).toBe(0);
    const cfg = loadAppsConfig({ VETRA_APPS_PLANS: "on", VETRA_APPS_PLAN_POOL_MAX: "2" });
    const plan = { warm_pool_size: 5, access: "own", status: "active", team: null } as const;
    expect(planPoolSize(cfg, plan)).toBe(2);
    expect(planPoolSize(cfg, { ...plan, warm_pool_size: 1 })).toBe(1);
    expect(planPoolSize(cfg, { ...plan, access: "shared" })).toBe(0);
    expect(planPoolSize(cfg, { ...plan, status: "retired" })).toBe(0);
    expect(planPoolSize(loadAppsConfig({}), plan)).toBe(0);
    expect(() => loadAppsConfig({ VETRA_APPS_PLAN_POOL_MAX: "11" })).toThrow();
  });
```

  - `migrations.test.ts`: `ensureWarmPoolColumns` runs three times concurrently after `up`; then `plans.warm_pool_size`, `instances.warm` and `instances.claimed_at` can be written and read (same shape as plan 2's migration test).
- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts subgraphs/vetra-apps/__tests__/migrations.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `config.ts`: `PlansConfig` gains `/** Upper bound of every plan's warm pool (slice 8); 0 turns pools off. */ poolMax?: number;`; `plansConfig(env)` returns `poolMax: intIn(env, "VETRA_APPS_PLAN_POOL_MAX", 0, 0, 10)`; and

```ts
/** A plan's effective warm pool (W2, W9): own, active, not Team, capped by VETRA_APPS_PLAN_POOL_MAX. */
export function planPoolSize(
  cfg: VetraAppsConfig,
  plan: { warm_pool_size?: number | null; access: string; status: string; team?: boolean | null },
): number {
  if (plan.access !== "own" || plan.status !== "active" || plan.team === true) return 0;
  return Math.max(0, Math.min(plan.warm_pool_size ?? 0, plansConfigOf(cfg).poolMax ?? 0));
}
```

  - `db/schema.ts`: `PlansTable` `/** Warm instances kept for new holders (own plans; slice 8). */ warm_pool_size?: number | null;`; `InstancesTable` `/** A warm-pool member: no holder yet, ingress closed (slice 8). */ warm?: boolean | null;` and `/** When a holder claimed it from the pool. */ claimed_at?: string | null;`.
  - `db/migrations.ts`: `await ensureWarmPoolColumns(db);` at the end of `up`:

```ts
/** Warm pools of own plans (releases phase 3 slice 8). Schema builder only (namespaced). */
export async function ensureWarmPoolColumns(db: Kysely<any>): Promise<void> {
  const tolerate = (err: unknown) => {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  };
  try {
    await db.schema.alterTable("plans").addColumn("warm_pool_size", "integer", (c) => c.ifNotExists()).execute();
  } catch (err) {
    tolerate(err);
  }
  for (const [name, type] of [
    ["warm", "boolean"],
    ["claimed_at", "varchar(64)"],
  ] as const) {
    try {
      await db.schema.alterTable("instances").addColumn(name, type, (c) => c.ifNotExists()).execute();
    } catch (err) {
      tolerate(err);
    }
  }
  try {
    await db.schema
      .createIndex("instances_warm_idx")
      .ifNotExists()
      .on("instances")
      .columns(["app_id", "plan_id"])
      .where(sql.ref("warm"), "=", true)
      .execute();
  } catch (err) {
    tolerate(err);
  }
}
```

  - `audit/repo.ts`: append `"instance.claimed"` to `AUDIT_ACTIONS`.
- [ ] **Step 4: Run them again.** Same command, plus `npm run tsc 2>&1 | tail -5`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/db subgraphs/vetra-apps/audit/repo.ts subgraphs/vetra-apps/__tests__/config.test.ts subgraphs/vetra-apps/__tests__/migrations.test.ts && git commit -m "feat(plans): warm pool size per plan, warm instance columns, pool cap" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: The pool plan (pure)

**Files:**
- Create: `subgraphs/vetra-apps/plans/pool.ts` (this task: constants and `planPool` only)
- Test: `subgraphs/vetra-apps/__tests__/pool-plan.test.ts`

**Interfaces:**
- Produces: `WARM_LABEL`, `MAX_WARM_POOL_SIZE = 10`, `POOL_STALE`, `POOL_SURPLUS`, `POOL_OFF`, `warmInstanceName(id: string): string` (`own-warm-` + 12 hex of `sha256(id)`); `PoolWant { size: number; digest: string | null; targetSize: string }`; `PoolRow = Pick<InstanceRow, "id" | "status" | "target_digest" | "running_digest" | "target_size" | "created_at">`; `PoolPlan { create: boolean; remove: Array<{ id: string; reason: string }> }`; `planPool(rows: PoolRow[], want: PoolWant): PoolPlan`.
- Rules (`rows` = the plan's live warm rows, i.e. `warm`, no `removed_at`):
  - `size === 0` or `digest === null` → remove every row (`POOL_OFF`), create nothing.
  - `fresh` = rows with `target_digest === digest` and `target_size === targetSize`; `stale` = the others.
  - Surplus of fresh over `size`: remove not-ready ones newest first, then ready ones oldest first (`POOL_SURPLUS`).
  - Stale rows: remove the oldest ones while `fresh.length (after surplus) + stale kept > size`; the rest stay until the pool is over size (W5).
  - `create` = `fresh kept < size` (one per pass).
  - A `failed` fresh row counts toward the size (W6).

- [ ] **Step 1: Write the failing test.** Create `__tests__/pool-plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planPool, POOL_OFF, POOL_STALE, POOL_SURPLUS, warmInstanceName } from "../plans/pool.js";

const row = (id: string, o: { digest?: string; size?: string; status?: string; at?: string } = {}) => ({
  id,
  status: o.status ?? "ready",
  target_digest: o.digest ?? "d2",
  running_digest: o.status === "ready" || !o.status ? (o.digest ?? "d2") : null,
  target_size: o.size ?? "VETRA_AGENT_M",
  created_at: o.at ?? `2026-11-12T00:00:0${id.slice(-1)}.000Z`,
});
const want = (size: number, digest: string | null = "d2") => ({ size, digest, targetSize: "VETRA_AGENT_M" });

describe("planPool", () => {
  it("fills one per pass", () => {
    expect(planPool([], want(2))).toEqual({ create: true, remove: [] });
    expect(planPool([row("r1")], want(2))).toEqual({ create: true, remove: [] });
    expect(planPool([row("r1"), row("r2", { status: "updating" })], want(2))).toEqual({ create: false, remove: [] });
  });

  it("drains when the pool is off or the plan has no target", () => {
    expect(planPool([row("r1"), row("r2")], want(0)).remove.map((r) => r.reason)).toEqual([POOL_OFF, POOL_OFF]);
    expect(planPool([row("r1")], want(1, null))).toEqual({ create: false, remove: [{ id: "r1", reason: POOL_OFF }] });
  });

  it("removes surplus: not-ready newest first, then ready oldest first", () => {
    const p = planPool([row("r1"), row("r2"), row("r3", { status: "updating" })], want(1));
    expect(p.remove).toEqual([
      { id: "r3", reason: POOL_SURPLUS },
      { id: "r1", reason: POOL_SURPLUS },
    ]);
    expect(p.create).toBe(false);
  });

  it("replaces stale rows rolling: create first, remove a stale one once over size", () => {
    const stale = [row("r1", { digest: "d1" }), row("r2", { digest: "d1" })];
    expect(planPool(stale, want(2))).toEqual({ create: true, remove: [] });
    const next = [...stale, row("r3")];
    expect(planPool(next, want(2))).toEqual({ create: true, remove: [{ id: "r1", reason: POOL_STALE }] });
    expect(planPool([row("r2", { digest: "d1" }), row("r3"), row("r4")], want(2))).toEqual({
      create: false,
      remove: [{ id: "r2", reason: POOL_STALE }],
    });
  });

  it("a size change makes rows stale; a failed fresh row keeps its slot", () => {
    expect(planPool([row("r1", { size: "VETRA_AGENT_S" })], want(1))).toEqual({ create: true, remove: [] });
    expect(planPool([row("r1", { status: "failed" })], want(1))).toEqual({ create: false, remove: [] });
  });

  it("warm names are stable per row and look like own rows", () => {
    expect(warmInstanceName("id-1")).toMatch(/^own-warm-[0-9a-f]{12}$/);
    expect(warmInstanceName("id-1")).toBe(warmInstanceName("id-1"));
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/pool-plan.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `plans/pool.ts`:

```ts
import { createHash } from "node:crypto";
import type { InstanceRow } from "../instances/repo.js";

/** The environment label's name part while warm: `<App> · own (warm)`. */
export const WARM_LABEL = "own (warm)";
export const MAX_WARM_POOL_SIZE = 10;
export const POOL_STALE = "warm pool: the plan's target or size moved";
export const POOL_SURPLUS = "warm pool: over the pool size";
export const POOL_OFF = "warm pool: the plan has no pool";

/** Stable per row, holder-neutral; renamed to ownInstanceName(root) by the claim. */
export const warmInstanceName = (id: string) =>
  `own-warm-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

export interface PoolWant {
  size: number;
  /** The plan's target digest; null: no target, the pool drains. */
  digest: string | null;
  targetSize: string;
}
export type PoolRow = Pick<
  InstanceRow,
  "id" | "status" | "target_digest" | "running_digest" | "target_size" | "created_at"
>;
export interface PoolPlan {
  create: boolean;
  remove: Array<{ id: string; reason: string }>;
}

const ready = (r: PoolRow) => r.status === "ready" && r.running_digest === r.target_digest;
const byAge = (a: PoolRow, b: PoolRow) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * One pass of a plan's warm pool (W5, W6), after licensing's
 * computeAppPoolPlan: the surplus goes (not ready newest first, then ready
 * oldest first), stale rows (another target or size) go once the pool would
 * be over size, and one row is created while fresh ones are short.
 */
export function planPool(rows: PoolRow[], want: PoolWant): PoolPlan {
  if (want.size <= 0 || !want.digest)
    return { create: false, remove: [...rows].sort(byAge).map((r) => ({ id: r.id, reason: POOL_OFF })) };
  const isFresh = (r: PoolRow) => r.target_digest === want.digest && r.target_size === want.targetSize;
  const fresh = rows.filter(isFresh);
  const stale = rows.filter((r) => !isFresh(r)).sort(byAge);
  const remove: PoolPlan["remove"] = [];
  const surplus = Math.max(0, fresh.length - want.size);
  const order = [
    ...fresh.filter((r) => !ready(r)).sort(byAge).reverse(),
    ...fresh.filter(ready).sort(byAge),
  ];
  for (const r of order.slice(0, surplus)) remove.push({ id: r.id, reason: POOL_SURPLUS });
  const freshKept = fresh.length - surplus;
  let staleKept = stale.length;
  for (const r of stale) {
    if (freshKept + staleKept <= want.size) break;
    remove.push({ id: r.id, reason: POOL_STALE });
    staleKept--;
  }
  return { create: freshKept < want.size, remove };
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/pool.ts subgraphs/vetra-apps/__tests__/pool-plan.test.ts && git commit -m "feat(plans): warm pool plan (fill, surplus, rolling replacement)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: The claim

**Files:**
- Create: `subgraphs/vetra-apps/plans/pool-repo.ts`
- Create: `subgraphs/vetra-apps/__tests__/pool-fixtures.ts`
- Test: `subgraphs/vetra-apps/__tests__/pool-claim.test.ts`

**Interfaces:**
- Produces: `claimWarmInstance(db, q: { appId; planId; digest; targetSize; holder; root; name; nowIso }): Promise<InstanceRow | null>`. One transaction: the single-statement claim (`UPDATE instances SET warm = false, holder_address, licence_root_id, name, claimed_at, licence_ended_at = NULL, updated_at WHERE id = (SELECT id FROM instances WHERE app_id AND plan_id AND kind = 'own' AND warm = true AND removed_at IS NULL AND stop_reason IS NULL AND status = 'ready' AND target_digest = digest AND running_digest = digest AND target_size = targetSize ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`), then `recordAudit` `instance.claimed` (actor `vetra`, source `system`). Null when none is claimable. A unique violation on `instances_licence_root_uq` (the chain already has a row; cannot happen under the App lock, but never trusted) rolls back and returns null.
- Produces (fixtures): `poolHarness()` → `{ h, appId }` (plans on, `poolMax: 2`, instances on, health `report`, release `1.4.0` run 100 digest `b`, own plan `p-pro` size `VETRA_AGENT_M` on `1.4.0` with `warm_pool_size: 1`); `seedWarm(h, appId, over?)` (inserts a ready warm row with a host and an environment id); `HOLDER`.

- [ ] **Step 1: Fixtures.** `__tests__/pool-fixtures.ts` builds on `instances-plans.test.ts`'s setup (copy its `plan()` helper with `warm_pool_size: 1`) and adds:

```ts
export async function seedWarm(h: Harness, appId: string, over: Partial<NewInstance> = {}) {
  const id = over.id ?? h.deps.newId();
  return insertInstance(h.db, {
    id,
    app_id: appId,
    kind: "own",
    name: warmInstanceName(id),
    branch: null,
    pr: null,
    host: `calm-bat-${id.slice(-4)}`,
    environment_id: `env-${id}`,
    target_version: "1.4.0",
    target_digest: digest("b"),
    target_repository: "cr.vetra.io/acme/shop",
    target_ph_host: "cli",
    target_run: 100,
    running_version: "1.4.0",
    running_digest: digest("b"),
    running_repository: "cr.vetra.io/acme/shop",
    status: "ready",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: "p-pro",
    holder_address: null,
    licence_root_id: null,
    stop_reason: null,
    stopped_by_vetra: false,
    target_size: "VETRA_AGENT_M",
    warm: true,
    created_at: "2026-11-12T00:00:00.000Z",
    updated_at: "2026-11-12T00:00:00.000Z",
    ...over,
  });
}
```

- [ ] **Step 2: Write the failing test.** `__tests__/pool-claim.test.ts`:

```ts
describe("claimWarmInstance", () => {
  const q = () => ({
    appId, planId: "p-pro", digest: digest("b"), targetSize: "VETRA_AGENT_M",
    holder: HOLDER, root: "l1", name: ownInstanceName("l1"), nowIso: h.deps.now().toISOString(),
  });

  it("claims the oldest ready warm row on the plan's digest and size, keeping id, host and environment; audited", async () => {
    const old = await seedWarm(h, appId, { created_at: "2026-11-11T00:00:00.000Z" });
    await seedWarm(h, appId);
    const got = await claimWarmInstance(h.db, q());
    expect(got).toMatchObject({
      id: old.id, host: old.host, environment_id: old.environment_id,
      warm: false, holder_address: HOLDER, licence_root_id: "l1", name: ownInstanceName("l1"),
    });
    expect(got?.claimed_at).toBeTruthy();
    const a = (await listAudit(h.db, appId, { limit: 5 })).find((r) => r.action === "instance.claimed");
    expect(a).toMatchObject({ subject: `instance:${old.id}`, actor: "vetra", source: "system" });
  });

  it("never claims a row that is not ready, stale, resized, stopping, removed or another plan's", async () => {
    await seedWarm(h, appId, { status: "updating", running_digest: null });
    await seedWarm(h, appId, { target_digest: digest("a"), running_digest: digest("a") });
    await seedWarm(h, appId, { target_size: "VETRA_AGENT_S" });
    await seedWarm(h, appId, { stop_reason: "x" });
    await seedWarm(h, appId, { removed_at: "2026-11-12T00:00:00.000Z", removed_reason: "warm pool: over the pool size" });
    await seedWarm(h, appId, { plan_id: "p-other" });
    expect(await claimWarmInstance(h.db, q())).toBeNull();
  });

  it("two concurrent claims never take the same row", async () => {
    await seedWarm(h, appId);
    const [a, b] = await Promise.all([
      claimWarmInstance(h.db, q()),
      claimWarmInstance(h.db, { ...q(), holder: "0x2222222222222222222222222222222222222222", root: "l2", name: ownInstanceName("l2") }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/pool-claim.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 4: Implement** `plans/pool-repo.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import type { InstanceRow } from "../instances/repo.js";

class ChainTaken extends Error {}

/**
 * Hands a ready warm instance of the plan to a new holder (W3, W4), as
 * licensing's claimOneAvailableIn: one UPDATE over a SKIP LOCKED pick, so two
 * claims never take one row. Keeps id, host, environment and tenant.
 * Null when none is claimable (the caller creates cold).
 */
export async function claimWarmInstance(
  db: Kysely<VetraAppsDB>,
  q: {
    appId: string;
    planId: string;
    digest: string;
    targetSize: string;
    holder: string;
    root: string;
    name: string;
    nowIso: string;
  },
): Promise<InstanceRow | null> {
  try {
    return await db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("instances")
        .set({
          warm: false,
          holder_address: q.holder,
          licence_root_id: q.root,
          name: q.name,
          claimed_at: q.nowIso,
          licence_ended_at: null,
          updated_at: q.nowIso,
        })
        .where(
          "id",
          "=",
          trx
            .selectFrom("instances")
            .select("id")
            .where("app_id", "=", q.appId)
            .where("plan_id", "=", q.planId)
            .where("kind", "=", "own")
            .where("warm", "=", true)
            .where("removed_at", "is", null)
            .where("stop_reason", "is", null)
            .where("status", "=", "ready")
            .where("target_digest", "=", q.digest)
            .where("running_digest", "=", q.digest)
            .where("target_size", "=", q.targetSize)
            .orderBy("created_at")
            .orderBy("id")
            .limit(1)
            .forUpdate()
            .skipLocked(),
        )
        .returningAll()
        .executeTakeFirst()
        .catch((err: unknown) => {
          if ((err as { code?: unknown } | null)?.code === "23505") throw new ChainTaken();
          throw err;
        });
      if (!row) return null;
      await recordAudit(trx, {
        appId: q.appId,
        at: q.nowIso,
        actor: AUDIT_SYSTEM_ACTOR,
        source: "system",
        action: "instance.claimed",
        subject: `instance:${row.id}`,
        detail: { planId: q.planId, holder: q.holder, licenceRoot: q.root, warmSince: row.created_at },
      });
      return { ...row, target_run: row.target_run == null ? null : Number(row.target_run) } as InstanceRow;
    });
  } catch (err) {
    if (err instanceof ChainTaken) return null;
    throw err;
  }
}
```

- [ ] **Step 5: Run it again.** Same command. Expected: PASS. (PGlite runs one connection, so the concurrency test serialises; it still proves the second claim finds nothing. The `SKIP LOCKED` matters on Postgres.)
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/plans/pool-repo.ts subgraphs/vetra-apps/__tests__/pool-fixtures.ts subgraphs/vetra-apps/__tests__/pool-claim.test.ts && git commit -m "feat(plans): claim a warm instance for a new holder" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Plan sync claims before it creates; pool rows are never "unserved"

**Files:**
- Modify: `subgraphs/vetra-apps/plans/sync.ts`
- Test: `subgraphs/vetra-apps/__tests__/pool-sync.test.ts`

**Interfaces:**
- Changes in `syncPlanInstances`:
  - the own loop's `!row` branch: when the plan has a target, first `claimWarmInstance(deps.db, { appId, planId: plan.id, digest: target.target_digest, targetSize: plan.size, holder: head.address, root: head.root, name: ownInstanceName(head.root), nowIso })`; a row → `served.add(head.root)`; null → the cold `insertInstance` as today. The `licensed.has(head.root)` skip stays **before** this branch (W9).
  - `own` (the rows read at the start) and `unserved` exclude `warm` rows: `own.filter((r) => !r.warm)`.

- [ ] **Step 1: Write the failing test.** `__tests__/pool-sync.test.ts` (with `poolHarness`, `seedWarm`, `seedLicence`, `seedLicensedEnvironment`):
  - "a new chain claims the ready warm row: same id, host and environment; no second own row": seed one warm row, `seedLicence(kind "pro", holder HOLDER, licenseId "l1")`, `syncPlanInstances` → `listInstances(own)` has one row, `warm: false`, `holder_address: HOLDER`, `licence_root_id: "l1"`, id/host/environment of the warm row.
  - "no ready warm row: a cold row, as before" (warm row `updating`) → two own rows, the new one `warm` falsy, `status: "pending"`, no environment.
  - "a chain with a licensed environment never claims": `seedLicensedEnvironment` for `l1` → the warm row stays warm, no own row for `l1`.
  - "a shared plan never claims": a shared plan of kind `starter` and a warm row whose `plan_id` is that plan (forced) → the shared row is created as today; the warm row stays.
  - "pool rows are never stopped as ended licences": a warm row, no licences, advance 15 days, sync twice → `stop_reason` null, `licence_ended_at` null.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/pool-sync.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `plans/sync.ts` (import `claimWarmInstance` from `./pool-repo.js`):
  - `const own = (await listInstances(deps.db, app.id, "own")).filter((r) => !r.warm);`
  - in the own loop:

```ts
    if (!row) {
      if (target) {
        const claimed = await claimWarmInstance(deps.db, {
          appId: app.id,
          planId: plan.id,
          digest: target.target_digest!,
          targetSize: plan.size,
          holder: head.address,
          root: head.root,
          name: ownInstanceName(head.root),
          nowIso,
        });
        if (!claimed)
          await insertInstance(deps.db, newRow(deps, app, plan, target, nowIso, head));
        served.add(head.root);
      }
      continue;
    }
```

  (`target.target_digest` is the field `targetOf` returns; check `instances/targets.ts`.)
- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/sync.ts subgraphs/vetra-apps/__tests__/pool-sync.test.ts && git commit -m "feat(plans): new holders claim a warm instance before a cold create" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: The keeper, and the reconciler runs warm rows

**Files:**
- Modify: `subgraphs/vetra-apps/plans/pool.ts`, `subgraphs/vetra-apps/instances/reconciler.ts`, `subgraphs/vetra-apps/instances/render.ts`
- Test: `subgraphs/vetra-apps/__tests__/pool-reconcile.test.ts`

**Interfaces:**
- Produces (`pool.ts`): `syncPlanPools(deps, app): Promise<void>`. Plans and instances on, `wantsInstances(app)` (export it from `reconciler.ts`) else every warm row of the App is marked removed (`POOL_OFF`). Per plan (all plans, so retired and shared ones drain): `size = planPoolSize(deps.cfg, plan)`, the plan's target digest from `planTarget` (export it from `sync.ts`), `rows` = the plan's warm rows without `removed_at`; apply `planPool`: removals → `updateInstance(…, { removed_at: nowIso, removed_reason })`; `create` → `insertInstance(warmRow(deps, app, plan, target, nowIso))`.
- Produces (`pool.ts`): `warmRow(deps, app, plan, target, nowIso)`: as `sync.ts` `newRow` for an own row with no holder, plus `warm: true`, `name: warmInstanceName(id)`.
- Changes (`reconciler.ts`):
  - `reconcileApp`: `await syncPlanPools(deps, app);` right after `syncPlanInstances` (and after slice 6's `syncTeamPlan` when present), inside the same `try`.
  - `adminsOf`: `if (row.warm) return "";` first (licensing's warm environments render an empty `ADMINS` too).
  - `initEnvironment`: label `${app.name} · ${row.warm ? WARM_LABEL : row.name}`.
  - `reconcileEnvironment`: passes `label: \`${app.name} · ${row.name}\`` for own rows that are not warm to `instanceUpdateActions`, so the claim's update relabels the environment in the same batch as `ADMINS`.
  - `removeInstance`: plan kinds still throw, **except** `row.kind === "own" && row.warm === true && !row.holder_address`. For those, the environment is deleted when `ours(state, row) && state.app?.role === "PLAN"` (or `ownDraft`), then `forgetTenant`, then `deleteInstance` (no tombstone).
- Changes (`render.ts`): `instanceUpdateActions(state, image, admins, settings, start = true, size = null, label: string | null = null)`: when `label` is set and differs from `state.label`, `setLabel({ label })` joins `changes`.

- [ ] **Step 1: Write the failing test.** `__tests__/pool-reconcile.test.ts`, driving `reconcileInstancesOnce` with `FakeEnvs` (as `instances-plans.test.ts` does; mark environments ready with `h.envs.setStatus(envId, "READY")`):
  - "fills the pool: one warm row, its environment closed to holders (`ADMINS` empty, label `Shop · own (warm)`), role PLAN, size M; it becomes ready".
  - "a new holder claims it in the next pass; that pass writes `ADMINS = holder` and the new label in one batch; the pool creates a replacement in the same pass": after the claim pass, the claimed environment's FUSION env has `ADMINS` = HOLDER and `state.label` = `Shop · own-…`; `listInstances(own)` has a second warm row.
  - "a target move replaces warm rows rolling": set the plan's target to `1.5.0` (a new release) → pass 1 creates one fresh row, keeps the stale one; once the fresh one is ready, the stale row gets `removed_at` and its environment is deleted (`h.envs` no longer has it) and the row is gone.
  - "pool size 0 drains unclaimed rows and never touches claimed ones": claimed row stays, warm rows go.
  - "VETRA_APPS_PLAN_POOL_MAX 0 creates nothing" (`poolMax: 0`).
  - "removeInstance refuses a claimed own row": force `removed_at` on a claimed row → the pass logs the plan-instance error and the environment stays.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/pool-reconcile.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement** `syncPlanPools` and `warmRow` in `plans/pool.ts`:

```ts
/**
 * Keeps each own plan's warm pool (W2, W5, W9). Under the App's lock, after
 * syncPlanInstances (so a new holder claims before the pool refills). Only
 * rows with warm = true and no holder are ever created or removed here.
 */
export async function syncPlanPools(deps: AppsDeps, app: AppRow): Promise<void> {
  const nowIso = deps.now().toISOString();
  const warm = (await listInstances(deps.db, app.id, "own")).filter(
    (r) => r.warm === true && !r.holder_address && !r.removed_at,
  );
  const on = plansConfigOf(deps.cfg).enabled && deps.cfg.instances.enabled && wantsInstances(app);
  const plans = on ? await listPlans(deps.db, app.id) : [];
  const byPlan = new Map(plans.map((p) => [p.id, p]));
  // Rows of a plan that is gone, or of an App without pools, drain.
  for (const r of warm.filter((r) => !byPlan.has(r.plan_id ?? "")))
    await updateInstance(deps.db, r.id, { removed_at: nowIso, removed_reason: POOL_OFF }, nowIso);
  for (const plan of plans) {
    const rows = warm.filter((r) => r.plan_id === plan.id);
    const size = planPoolSize(deps.cfg, plan);
    const target = size > 0 ? await planTarget(deps, plan) : null;
    if (size === 0 && rows.length === 0) continue;
    const p = planPool(rows, { size, digest: target?.target_digest ?? null, targetSize: plan.size });
    for (const r of p.remove)
      await updateInstance(deps.db, r.id, { removed_at: nowIso, removed_reason: r.reason }, nowIso);
    if (p.create && target) await insertInstance(deps.db, warmRow(deps, app, plan, target, nowIso));
  }
}

export function warmRow(deps: AppsDeps, app: AppRow, plan: PlanRow, target: InstanceTarget, nowIso: string): NewInstance {
  const id = deps.newId();
  return {
    id,
    app_id: app.id,
    kind: "own",
    name: warmInstanceName(id),
    branch: null,
    pr: null,
    host: null,
    environment_id: null,
    ...target,
    running_version: null,
    running_digest: null,
    running_repository: null,
    status: "pending",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: plan.id,
    holder_address: null,
    licence_root_id: null,
    licence_ended_at: null,
    stop_reason: null,
    stopped_by_vetra: false,
    target_size: plan.size,
    warm: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
```

  Then the reconciler and render changes listed above. In `removeInstance`:

```ts
  const warmRemovable = row.kind === "own" && row.warm === true && !row.holder_address;
  if (isPlanKind(row.kind) && !warmRemovable)
    throw new Error("plan instances are never removed by the reconciler (releases phase 3: stopped, not deleted)");
```

  and in its deletion condition add `|| (warmRemovable && ours(state, row) && state.app?.role === "PLAN")`.
- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts subgraphs/vetra-apps/__tests__/instances-plan-render.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/pool.ts subgraphs/vetra-apps/plans/sync.ts subgraphs/vetra-apps/instances subgraphs/vetra-apps/__tests__/pool-reconcile.test.ts && git commit -m "feat(instances): keep own plans' warm pools; claimed instances get the holder's ADMINS" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Warm rows are judged from the cluster only

**Files:**
- Modify: `subgraphs/vetra-apps/instances/health.ts`, `subgraphs/vetra-apps/instances/monitor.ts`
- Test: `subgraphs/vetra-apps/__tests__/pool-health.test.ts`

**Interfaces:**
- Changes: `health.ts` exports `HEALTHY` and adds `WARM_HEALTHY: HealthVerdict = { health: "healthy", check: null, reason: null }` (same value; named for the log). `checkInstance`: in the `else if (cluster)` branch, when `row.warm === true` and `fromCluster` is null, `verdict = HEALTHY` without probing; the probe runs for every other row as today.

- [ ] **Step 1: Write the failing test.** Using `instances-health.test.ts`'s cluster fixtures (ready host pod on the wanted digest, Argo synced): a warm row → `health: "healthy"` and `h.probed` stays empty; the same row after `warm: false` → probed (`/ready` on its host). A warm row whose cluster shows a crash loop → unhealthy as today.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/pool-health.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement** the branch in `monitor.ts`:

```ts
      if (fromCluster) verdict = fromCluster;
      // A warm row's ingress is closed until claimed (W7): the cluster decides.
      else if (row.warm === true) verdict = HEALTHY;
      else if (deps.probe) {
```

- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-health.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/health.ts subgraphs/vetra-apps/instances/monitor.ts subgraphs/vetra-apps/__tests__/pool-health.test.ts && git commit -m "feat(instances): warm instances are judged from the cluster (ingress closed)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: The processor keeps warm instances closed

**Files:**
- Create: `subgraphs/vetra-apps/plans/pool-lookup.ts`
- Modify: `processors/vetra-cloud-environment/factory.ts`
- Test: `processors/vetra-cloud-environment/pool-lookup.test.ts`

**Interfaces:**
- Produces: `createInstancePoolLookup(appsDb: Kysely<any>): (documentId: string) => Promise<{ appId: string } | null>` — the `instances` row with that `environment_id`, `warm = true`, no holder and no `removed_at`… → `{ appId }`; else null. A missing table (`42P01`) or column (`42703`, vetra-apps not migrated yet: no pool row can exist) → null. Any other error throws (the render fails closed, as `lookupWarm` intends).
- Changes (`factory.ts`):

```ts
    const licensingWarm = createWarmPoolStore(licensingDb);
    const instancesWarm = createInstancePoolLookup(appsDb);
    // Licensing's pool (Sektar) first, then own plans' pools (releases phase 3 slice 8).
    const isWarm = async (documentId: string) =>
      (await lookupWarm((id) => licensingWarm.isWarm(id), documentId)) ??
      (await instancesWarm(documentId));
```

  A removed-but-not-yet-deleted warm row still answers warm (ingress stays closed while it goes). A claimed row answers null, so the render that applies the holder's `ADMINS` opens it.

- [ ] **Step 1: Write the failing test.** `pool-lookup.test.ts`: on a PGlite with the vetra-apps tables (`up`): a warm row → `{ appId }`; the same row claimed (`warm: false`, holder set) → null; an unknown document → null; a database whose `instances` table lacks the `warm` column (create the table with `ensureInstancesTable` only) → null; a broken connection (destroyed Kysely) → throws. Plus, in `fusion.test.ts`'s style, `generateValuesYaml(…, isWarm)` with the composed lookup renders `closed: true` for a warm instance document and not for a claimed one.
- [ ] **Step 2: Run it.** `npx vitest run processors/vetra-cloud-environment/pool-lookup.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement** `pool-lookup.ts`:

```ts
import type { Kysely } from "kysely";

const MISSING = new Set(["42P01", "42703"]);

/**
 * The processor's warm lookup for own plans' pools (slice 8): an unclaimed
 * warm instance renders with its ingress closed. A table or column that does
 * not exist yet means no pool row exists; any other failure throws, so a warm
 * environment never renders open by accident.
 */
export function createInstancePoolLookup(appsDb: Kysely<any>) {
  return async (documentId: string): Promise<{ appId: string } | null> => {
    try {
      const row = (await appsDb
        .selectFrom("instances")
        .select("app_id")
        .where("environment_id", "=", documentId)
        .where("warm", "=", true)
        .where("holder_address", "is", null)
        .executeTakeFirst()) as { app_id: string } | undefined;
      return row ? { appId: row.app_id } : null;
    } catch (err) {
      if (MISSING.has(String((err as { code?: unknown } | null)?.code))) return null;
      throw err;
    }
  };
}
```

  and the `factory.ts` change (import `lookupWarm` from `./app-image-project.js` and `createInstancePoolLookup` from `../../subgraphs/vetra-apps/plans/pool-lookup.js`). Both `createAppImageProjectResolver(appsDb, licensingDb, isWarm)` and the processor take the composed `isWarm`; for an App-linked document the resolver still vouches through `instances` (the warm entry only matters for unlinked licensed documents).
- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run processors/vetra-cloud-environment 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/pool-lookup.ts processors/vetra-cloud-environment/factory.ts processors/vetra-cloud-environment/pool-lookup.test.ts && git commit -m "feat(processor): warm plan instances render with their ingress closed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: API: pool size and warm instances

**Files:**
- Modify: `subgraphs/vetra-apps/plans/service.ts`, `subgraphs/vetra-apps/instances/service.ts`, `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Test: `subgraphs/vetra-apps/__tests__/pool-graphql.test.ts`

**Interfaces:**
- `UpdatePlanInput.warmPoolSize?: number | null` (0-`MAX_WARM_POOL_SIZE`; BAD_USER_INPUT for a shared plan or the Team plan: "Only own plans keep warm instances"); audited in `plan.updated` as `changes.warmPoolSize { from, to }`.
- `PlanJson`: `warmPoolSize: number` (stored), `warmPoolEffective: number` (`planPoolSize`), `warmPoolEurPerMonth: number` (`estimateEnvironmentEurPerMonth(plan.size) * warmPoolEffective`, from `subgraphs/vetra-licensing/warm-cost.ts`), `warmReady: number` (claimable rows now).
- `InstanceJson`: `warm: boolean`, `claimedAt: string | null`.
- SDL: the same fields on `AppPlan`, `UpdatePlanInput`, `AppInstance`, each with a description ("Warm instances kept ready for new holders (own plans); capped by Vetra", "Monthly cost of the warm instances, in euros (estimate)", "A warm-pool instance: no holder yet, closed to everyone", "When a holder claimed it from the warm pool").

- [ ] **Step 1: Write the failing test.** `pool-graphql.test.ts`: `updatePlan(input: { planId, warmPoolSize: 2 })` by the owner → `warmPoolSize: 2`, `warmPoolEffective: 2` (with `poolMax: 2`), `warmPoolEurPerMonth > 0`, an audit row with `changes.warmPoolSize`; `warmPoolSize: 11` → BAD_USER_INPUT; on a shared plan → BAD_USER_INPUT; by a stranger → FORBIDDEN; `appInstances` shows a warm row with `warm: true, holder: null`.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/pool-graphql.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement** (in `updatePlanFor`, next to `size`: `...(input.warmPoolSize != null ? { warm_pool_size: checkPoolSize(plan, input.warmPoolSize) } : {})`, and the change into `changes`). `warmReady` is one count query per `appPlans` call grouped by `plan_id`.
- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/service.ts subgraphs/vetra-apps/instances/service.ts subgraphs/vetra-apps/schema.ts subgraphs/vetra-apps/resolvers.ts subgraphs/vetra-apps/__tests__/pool-graphql.test.ts && git commit -m "feat(apps): warm pool size on plans; warm instances in the API" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: Rollouts and pins leave warm rows alone (only when slice 3 is on `main`)

**Files:**
- Modify: `subgraphs/vetra-apps/rollouts/service.ts` (`plannedSteps`), `subgraphs/vetra-apps/rollouts/pins.ts` (`pinInstance`)
- Test: `subgraphs/vetra-apps/__tests__/pool-rollouts.test.ts`

- [ ] **Step 1: Write the failing test.** An own plan with one claimed instance and one warm row; `checkRolloutFor(…, newVersion, [plan])` lists one step (the claimed instance); `pinInstance(warmRowId, …)` → BAD_USER_INPUT "A warm instance has no holder yet; it is not pinned".
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement:** `plannedSteps`' filter gains `&& r.warm !== true`; `pinInstance` refuses `row.warm === true`.
- [ ] **Step 4: Run it again.** Plus slice 3's `rollouts-*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(rollouts): warm instances are replaced, never rolled out or pinned" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` (with the files added).

---

### Task 10: Full checks, PR

- [ ] **Step 1: Full checks.** `npm run tsc 2>&1 | tail -20`; `npm run lint 2>&1 | grep -E "error|✖" | head -20`; `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing processors/vetra-cloud-environment shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: nothing new compared with Task 0.
- [ ] **Step 2: PR.** `git push -u origin feat/releases-phase-3-warm-pool` and `gh pr create --title "feat(apps): own instances from a warm pool (releases phase 3, slice 8)"`. The body covers what ships, W1-W12 as built, the new env value `VETRA_APPS_PLAN_POOL_MAX` (default 0: nothing changes until set), the processor change (two lookups), and, when Task 9 was skipped, the slice 3 seam ("`plannedSteps` must skip `warm` rows; `pinInstance` must refuse them"). End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

### Task 11: Staging verification (needs the user; no code)

- [ ] **Step 1: Pin staging** (`powerhouse-k8s-hosting`, `tenants/staging/…`, two places) and set `VETRA_APPS_PLAN_POOL_MAX: "2"` on staging. Production: unchanged (0).
- [ ] **Step 2: Pool size 1.** On the staging canary App's own plan (Pro): `updatePlan(input: { planId, warmPoolSize: 1 })`. Within a few passes `appInstances` shows one `warm: true` row, READY; its `tenants/<tenant>/powerhouse-values.yaml` has `ingress.closed: true` and `ADMINS: ""`; `https://<its host>-stg.vetra.io` does not answer the app.
- [ ] **Step 3: Claim.** Issue a publisher grant of Pro to a test holder. Within one pass: the warm row is the holder's (`holder`, `claimedAt`, same host and environment id), the audit has `instance.claimed`; the values file has `ADMINS: <holder>` and no `closed`; the instance is READY again within about two minutes (one pod restart), and the holder signs in as admin. Compare with a cold create (pool size 0, another grant): note both times in the PR.
- [ ] **Step 4: Refill.** A new warm row appears in the same pass as the claim and becomes READY.
- [ ] **Step 5: Target move.** Roll Pro out to a newer release (slice 3) or, before slice 3, `setPlanTarget`. The warm row is replaced: a fresh one on the new release first, then the old one is removed and its environment deleted. The claimed instance is not touched by the pool (it moves with the rollout).
- [ ] **Step 6: Off.** `warmPoolSize: 0` → the warm row is removed; the claimed instance stays.
- [ ] **Step 7: Record** the results in the PR. Production follows D10: pools stay off (`VETRA_APPS_PLAN_POOL_MAX` unset) until Sektar's own plans exist (slice 9), then the user picks sizes.

---

### Task 12: Console follow-up (vetra.to; separate PR after staging works; no code here)

- **Plans tab, own plans:** a "Warm instances" stepper (0 to the effective cap) with the estimate "≈ €X / month while idle" (`warmPoolEurPerMonth` for the new value) and the help text "New holders get one of these at once instead of waiting for a new instance. They run on the plan's release and are replaced when it changes." Shows `warmReady` of `warmPoolEffective` ready.
- **Instances tab:** warm rows grouped under their plan as "Warm (no holder yet)", with status; no URL link (closed). Claimed instances show "from the warm pool" with `claimedAt`.
- **Holders** see nothing new: their instance just arrives faster.

---

## Self-review

- **Spec coverage:** section 6 step 2 "create (from the warm pool when one fits)" → Tasks 3-5; section 5 own instances (holder `ADMINS`, generated host) → W4 and Task 5 (`adminsOf`, label, host from the row id); section 7 (own targets move only through rollouts) → W5 (warm rows are replaced, not rolled) and Task 9; overview slice 8: `plans.warm_pool_size` (Task 1), a pool keeper for plan instances, pre-created `PLAN` environments on the plan's target, ownerless (service identity, empty `ADMINS`), closed ingress like `warm-env.ts` (Tasks 5, 7), claimed by the reconciler when it makes an own row (Task 4), re-created when the target moves, rolling (Tasks 2, 5), `app-image-project.ts` vouches through the instances table (already true, kept), pool rows are `instances` rows with `kind = own` and no holder (W1); risks: idle cost bounded (W2 cap and default 0; cost shown, Task 8), `ADMINS` and secrets before the ingress opens (W4: the claim's own render applies `ADMINS` and opens; the tenant's secrets were delivered while warm; Task 7 lookup turns off only once the row is claimed).
- **"Never claims for licensed chains":** the claim sits behind sync's `licensed.has(head.root)` skip (Task 4 test).
- **"Claim keeps tenant id/subdomain":** id, host, environment are kept (Task 3 test), so `getTenantId(host, environmentId)` and the tenant's secrets are unchanged.
- **Safety:** pool code only ever removes rows with `warm = true` and no holder (Task 5 `removeInstance` guard and test); the processor lookup fails closed except for a schema not yet migrated (Task 7).
- **Hot path:** with pools off, `syncPlanPools` reads the App's own rows once and returns; with pools on, one plan list, one target read per plan, at most one insert per plan per pass.
- **Type consistency:** `warm?`, `claimed_at?` (instances), `warm_pool_size?` (plans) are optional everywhere; `planPoolSize` is the single source of the effective size (keeper, API, cost).
