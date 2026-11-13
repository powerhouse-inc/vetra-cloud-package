# Releases phase 3, plan 3: rollouts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After this slice, the targets of shared and own plan instances move **only through rollouts** (spec section 7):
- **Check** before anything moves: the release exists, is a release (not a build), is not withdrawn, and fits each plan (`requires.services`, `requires.size`, the slice 5 licence-gate hook, the slice 6 Team hook).
- **Announce:** each step is due `noticeHours` after the start; holders see the update on `myInstances` (version, due date, customer notes) and may **update now** (own instances).
- **Apply** one instance per App at a time: the rollout's shared instances first, then its own instances, each only after its notice and inside its plan's **update window**. A step succeeds when the instance is `ready` on the target under `VETRA_APPS_INSTANCE_HEALTH=enforce`. A failure (or a 30-minute timeout) leaves that instance on its old release and **pauses** the rollout with an alert row in the audit log.
- **Paused:** retry, skip, resume, cancel, or **roll back** (image swap: plans' targets go back, instances go back one at a time).
- **Pinning** of own instances, **withdrawing** releases, and **policies** (`patches`, `minor`, `follow:<branch>`) that start rollouts by themselves (never a major, except `follow`).

**Architecture:**
- Three new tables in the vetra-apps namespace: `rollouts` (one move of one or more plans to a version), `rollout_plans` (each plan's target before, its notice), `rollout_steps` (one instance's move, with its own status, due date and note). New nullable columns: `instances.pinned_version`; `releases.withdrawn_at`, `withdrawn_by`, `withdrawn_reason`; `plans.update_window` (JSON) and `plans.policy_note`. `plans.policy` and `plans.notice_hours` exist since slice 1 and become live.
- **Where targets come from (R3):** a plan's `target_version` is what a **new** instance of the plan gets; it moves when a rollout starts. `syncPlanInstances` stops moving the targets of existing shared and own rows. From then on, only three writers move them: the rollout runner (a step, a revert), `pinInstance`, and nothing else.
- **The runner** `rollouts/runner.ts` `advanceRollouts(deps, app)` runs inside the reconciler's per-App pass (`reconcileApp`, under `withKeyLock("instances:<appId>")`), right after `syncPlanInstances` and before the instances are reconciled, so a target it moves is applied in the same pass. It settles the moving step from the instance row the reconciler wrote (`status`, `running_*`, `failed_digest`), then starts the next due step. The reconciler's update and revert path (phase 2) is reused unchanged: a step only sets the instance's target.
- **Mutations** that move targets or steps (`startRollout`, controls, `rollBackRollout`, `pinInstance`, `withdrawRelease`, `updateInstanceNow`) take the same in-process lock (`appInstancesLock(appId)`), then write in one transaction with their audit rows. The lock is not re-entrant: nothing called under it takes it again. Production runs one switchboard replica (as the reconciler already assumes). A partial unique index allows at most one moving step (`applying` or `reverting`) per App in the database too.
- Ideas reused from `vetra-licensing`'s gated rollouts (`release-gate.ts` `decideRelease`, `release-tracker.ts` `trackReleases`, `release-service.ts`): times fail closed (a due date that does not parse is never due); guarded status transitions (`transitionUpdate(id, from[], patch)` → `transitionStep`); one update per App; "update now" sets `requested_at` and is refused while paused; a failure only pauses. Not reused: supersede on promotion (R7), channels and LATEST, `environment_updates` (they act on licensed environments, never on `instances`).

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph), `Intl.DateTimeFormat` for time zones (no new dependency).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 6 last paragraph (shared and own targets move only through a rollout);
- section 7 "Plans" (policy table; "a major release never rolls out to a manual, patches or minor plan by itself") and "A rollout" steps 1, 3, 4, 5, pinning, rollback **by image swap** (step 2 rehearsals and step 4 backups are not in this slice; restore-based rollback is slice 4);
- 10 (start/pause/roll back a rollout and pin: owner, org admins, release managers; audited);
- 11 (Plans "Roll out", the Rollout view, release health);
- 14.3 (withdrawing a release), 14.7 (healthy), 14.8 (update windows; "Update now" ignores the window).

Slice scope: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` slice 3 and D5 (in-app notices only). Conventions and the code this builds on: `2026-11-12-releases-phase-3-plan-1-plans-and-plan-instances.md`, `2026-11-12-releases-phase-3-plan-2-audit-and-release-managers.md`.

## Decisions to confirm (recommended default first; the plan is written with the default)

- **R1 Switches.** Rollouts are part of plans: they run whenever plans run (`VETRA_APPS_PLANS=on` and instances on). No `VETRA_APPS_ROLLOUTS` switch, because with plans on and rollouts off nothing could move a target any more (or `setPlanTarget` would keep moving customers without notice). One new brake instead: `VETRA_APPS_ROLLOUTS_HOLD=on` starts no step and no policy rollout anywhere; moving steps still settle. Production keeps `VETRA_APPS_PLANS` off, so nothing changes there. *Alternative:* a separate `VETRA_APPS_ROLLOUTS` (default off) under which `setPlanTarget` refuses.
- **R2 Health.** A rollout that would move any instance needs `VETRA_APPS_INSTANCE_HEALTH=enforce`; it is refused otherwise ("report" judges `READY` on the tag only). A rollout that moves no instance (a plan without instances, e.g. right after `createPlan`) is allowed in any mode. Staging must switch to `enforce` before Task 18.
- **R3 Targets.** A plan's target is what new instances get and moves when its rollout starts. An instance that joins during a rollout starts on the new release (and is included in a rollback). Existing instances move only by steps, pins and rollbacks.
- **R4 Update now.** Holders of **own** instances only (a shared instance is everyone's). It skips the notice, the window and the shared-first order, never a pause, the hold switch or one-at-a-time. A publisher's **retry** also runs at once, outside the window.
- **R5 Rollback is an image swap only.** `rollBackRollout` refuses a release with `migrates: true` until slice 4 adds the restore. It ignores notice and windows (it is the way out of a bad release). Instances go back in reverse order (own first, then shared).
- **R6 Withdraw.** Refused while any plan targets the release or any instance is pinned to it ("roll back, roll forward or re-pin first"). Withdrawal is final in this slice (no un-withdraw). Branch instances are not plans and keep following their branch.
- **R7 One open rollout per plan.** Starting one for a plan in an `active` or `paused` rollout is refused; a policy waits until it is complete, cancelled or rolled back. No supersede (licensing supersedes).
- **R8 Forward only.** A version older than a plan's target is refused ("roll back instead"). The plan's **current** target is allowed when some instance is behind it (skipped, unpinned, woken): that is how stragglers catch up.
- **R9 Stopped instances.** A step whose instance is stopped (licence ended, plan retired, or asleep) is skipped with "stopped: updated when it wakes", and its target still moves. The wake-up update is the reconciler's ordinary update (with its revert), not gated by the rollout.
- **R10 Step timeout** 30 minutes (the reconciler's 20-minute update timeout plus 10). A timed-out step sends its instance back to where it came from and pauses the rollout.
- **R11 Pin.** Own instances only. Pinning to another version moves the instance at once (no notice, no window; audited; the console confirms). Unpinning never moves it; the next rollout of the plan's target (R8) catches it up.
- **R12 Update window** = ISO weekdays (1 = Monday … 7 = Sunday, the day the window **starts**), `start` and `end` as local `HH:MM`, and an IANA time zone. `end <= start` runs past midnight; `start == end` is the whole day. Notice first, then the window. Checked with `Intl` only; tested across both 2026 DST changes in Europe/Berlin.
- **R13 Policies.** `patches` and `minor` take stable releases only (no `alpha`/`beta`/`rc`). `follow:<branch>` takes every release of that release branch (prereleases and majors too). A policy refusal (a failed check) is written once per plan and version: `plans.policy_note` and an audit row `rollout.policy_refused`.
- **R14 Checks of `requires`.** Plan instances run the App's host image only, so any `requires.services` is refused (until templates with extra services exist). `requires.size` (`S` … `XXL` or `VETRA_AGENT_*`) must be at most the plan's size. `requires.powerhouse` is the App's own constraint and is not checked against the plan; the slice 5 hook (`LICENCE_GATE_MIN_POWERHOUSE`, D9) refuses shared plans' releases built on an older Powerhouse once it is set (null now).
- **R15 Retired plans** cannot be rolled out (as `setPlanTarget` today); their holders stay on their release. *Alternative:* allow it, so retired plans still get fixes.
- **R16 Statuses are lowercase** like every vetra-apps status (`active`, `applying`, …), not the overview's uppercase.

## What exists today (checked 2026-11-12 on `main` = 0.0.117)

- **Plans** (`subgraphs/vetra-apps/plans/`):
  - `PlansTable` (`db/schema.ts`) already has `policy` (`"manual"`, comment "rollouts (slice 3) act on it") and `notice_hours` (72 by default in `createPlan`). There is no update window.
  - `plans/service.ts`: `checkTarget` (release exists and `kind === "release"`), `loadPlan` (`need: "release"`), `createPlan`, `updatePlanFor` (name, size; audited `plan.updated` with `changes`), **`setPlanTarget`** (the slice 1 stand-in: locks the plan, sets `target_version`, audits `plan.target_set { slug, from, to }`; the next reconciler pass moves every instance at once, without notice), `retirePlan`. `planJson` exposes `policy` and `noticeHours`.
  - `plans/sync.ts` `syncPlanInstances`: creates shared and own rows with `newRow(…, target, …)` and, for existing rows, patches `{ ...(target ?? {}), target_size, stop_reason }` (shared) and `{ ...(target ?? {}), plan_id, holder_address, target_size, licence_ended_at: null, stop_reason: null }` (own). That `...(target ?? {})` is what makes targets follow the plan today. `planTarget` reads the plan's release and `targetOf` it.
  - `plans/holder-view.ts` `myInstancesFor`: own rows by `holder_address`, shared rows by the caller's live licence kinds (`liveKindsOfHolder`); returns `{ instanceId, appId, appName, planName, access, url, status, reason, runningVersion }`.
  - Tests: `plans-api.test.ts` and `plans-audit.test.ts` call `setPlanTarget` on plans without instances (and expect `plan.target_set` once per change, refusals for builds, unknown versions and retired plans). `instances-plans.test.ts` "follows a new plan target" asserts the behaviour this slice removes.
- **Instances** (`subgraphs/vetra-apps/instances/`):
  - `reconciler.ts` `reconcileInstancesOnce` → per App `withKeyLock("instances:<appId>", () => reconcileApp(…))`. `reconcileApp`: `syncBranchInstances`, `syncPreviewInstances`, then (plans on and `wantsInstances(app)`) `syncPlanInstances` in its own try/catch, then lists rows and `reconcileInstance` for each.
  - The update path (`reconcileEnvironment`): an image or size change → `instanceUpdateActions`, then `status: "updating"`, `update_started_at`. Then `observeHealth` (enforce) or `observeEnvironment` (report/off). `ready` writes `running_version/digest/repository/settings`. A failure writes `status: "failed"`, `reason`, `failed_digest = target_digest`, `failed_settings`, and applies `revertImage(row)` (the running image) when there is one. `failedOn(row, settings)`: a failed target is not retried until its digest or settings change. `degraded`: ran the target healthy, unhealthy now, never reverted.
  - A plan instance with `stop_reason` is slept (`stopPlanInstance`), and woken when the reason clears (`stopped_by_vetra`).
  - `status.ts`: `UPDATE_TIMEOUT_MS` = 20 min. `config.ts`: `instanceHealth(cfg).mode` (`off | report | enforce`, default `report`), `unhealthyWindowMs` 5 min.
  - `repo.ts`: `updateInstance(db, id, patch, nowIso)` is the only writer of `status` and audits status changes (`instance.status`, source `system`); a patch without `status` is one `UPDATE`. Works on a transaction (`db.isTransaction`). `getInstance`, `listInstances(db, appId, kind?)`, `insertInstance`.
  - `targets.ts` `targetOf(release)` → `{ target_version, target_digest, target_repository, target_ph_host, target_run }` (throws when the image ref is not tagged with the version).
  - `service.ts` `instanceJson(row)` → `AppInstance`.
- **Releases** (`subgraphs/vetra-apps/releases/`): `ReleasesTable` (`kind`, `branch`, `run`, `requires` JSON `{ powerhouse?, services?, size? }`, `migrates`, `powerhouse_version`, `customer_notes`, `notes`). `repo.ts`: `releaseByVersion`, `listReleases(db, appId, { kind?, limit })` (by `run` desc). `version.ts`: `parseVersion`, `versionKind`, `compareReleases` (throws for builds). `service.ts` `releaseJson`, `appReleasesFor`. Nothing withdraws a release.
- **Roles and audit** (slice 2): `loadAppForOwner(deps, caller, appId, { need: "release" })` admits operators and release managers. `audit/repo.ts` `AUDIT_ACTIONS` (a closed tuple; "later slices add theirs here"), `AUDIT_SYSTEM_ACTOR = "vetra"`, `recordAudit(db, entry)` (pass the transaction); `audit/service.ts` `auditCaller(db, caller, entry)` (actor = address, source = `caller.source ?? "api"`). Resolvers build audited callers with `person(ctx)`.
- **Settings:** scopes `all | branch | preview` only (`settings/resolve.ts` `settingsForKind`): shared and own instances get `all`. A settings change rolls every instance of the scope.
- **Locks:** `shared/key-lock.ts` `withKeyLock(key, fn)` (in-process, not re-entrant), `withEnvLock(envId)`.
- **Config** (`config.ts`): `PlansConfig { enabled, stopAfterDays }`, `DEFAULT_PLANS`, `plansConfigOf`, `plansConfig(env)` with `INSTANCES_ON/OFF` and `intIn`. `config.test.ts` asserts `loadAppsConfig({}).plans` equals `{ enabled: false, stopAfterDays: 14 }`.
- **Migrations** (`db/migrations.ts`): `up` ends with `ensurePlansTable`, `ensureInstancesPlanColumns`, `ensureAppAuditTable`, `ensureAppRolesTable`. Pattern: schema builder only (namespaced via `withSchema`), `ifNotExists`, `isConcurrentIndexError` / `isDuplicateColumnError` tolerated. Timestamps `varchar(64)` ISO, JSON `text`.
- **Test harness** (`__tests__/harness.ts`, `instances-fixtures.ts`): `makeHarness(cfg)` (PGlite with vetra-apps, observability and licensing tables; `deps.now()` advances 1 ms per call from `2026-10-02T12:00:00.000Z`, a Friday; `h.advance(ms)`; `deps.newId()` = `id-N`), `testConfig(over)`, `seedActiveApp(h)` (App "Shop", owner `OWNER`), `owner`, `stranger`, `STRANGER`; `seedRelease(h, appId, { version, run, kind, digest, branch })` (branch `main` by default; image `cr.vetra.io/acme/<slug>:<version>`); `digest(c)`; `seedLicence`. `resolvers.test.ts` "SDL" requires a resolver for every Query and Mutation field.
- **vetra-licensing's gated rollouts** (`subgraphs/vetra-licensing/release-*.ts`, tables `app_rollouts`, `environment_updates`): act on `license_environments` through the keeper and channels. They stay for Sektar until slice 10; this slice never reads or writes them.
- **Staging facts:** the canary App `96e56853-7041-4c32-a8f7-e9cc8afb50d4` (`powerhouse-inc/vetra-publish-canary`) has releases `1.0.0` and `1.1.0` and two plans, Starter (shared) and Pro (own), on `1.1.0`. The canary's `index.js` exits at start when `CANARY_CRASH=1`; that setting crashes every instance at once (settings roll all instances), so Task 18 adds a narrower `CANARY_CRASH_ADMIN` to the canary.

## Model (as built here)

**`rollouts`**

| Column | Meaning |
|---|---|
| `id`, `app_id` | |
| `version` | the release the plans move to |
| `status` | `active` (steps run when due) · `paused` (nothing starts) · `complete` · `cancelled` · `rolled_back` |
| `direction` | `forward`, or `back` after `rollBackRollout` (then `active`/`paused` mean the rollback runs/waits) |
| `source` | `console` · `api` · `policy` |
| `started_by`, `started_at` | address, or `vetra` for a policy |
| `notes` | what holders see: the release's `customer_notes` (else `notes`) at the start |
| `paused_at`, `paused_reason` | `<instance>: <error>` when Vetra paused it, else the publisher's reason |
| `finished_at`, `rolled_back_by`, `rolled_back_at` | |

**`rollout_plans`** — `(rollout_id, plan_id)` primary key; `from_version` (the plan's target before; where a rollback sets it back), `notice_hours` (the notice its steps got).

**`rollout_steps`** — one instance's move. `position` (shared first, then own by age), `from_version` (its target when the rollout started), `to_version`, `due_at` (start + notice), `requested_at` (update now / retry), `started_at`, `finished_at`, `target_moved` (the runner set the instance's target), `attempts`, `error`, `note`. Unique `(rollout_id, instance_id)`. Partial unique index on `app_id` where `status in ('applying', 'reverting')`: one moving instance per App.

| Step status | Meaning | Next |
|---|---|---|
| `pending` | waiting for its notice, window or turn | `applying`, `skipped`, `succeeded` (already there) |
| `applying` | its instance's target is the new release | `succeeded`, `failed`, `skipped` (removed, stopped, moved) |
| `succeeded` | `ready` on the new release | `revert_pending` (rollback) |
| `failed` | the update failed or timed out; the instance is back on `from_version` (by the reconciler's revert, or by the runner after a timeout); the rollout is paused | `pending` (retry), `skipped` (skip, cancel), `revert_pending` |
| `skipped` | pinned, stopped (target moved anyway: `target_moved`), removed, skipped or cancelled by the publisher | `revert_pending` (when `target_moved`) |
| `revert_pending` → `reverting` → `rolled_back` / `revert_failed` | the rollback's way back | `revert_failed`: retry → `revert_pending`, skip → `skipped` |

**New columns:** `instances.pinned_version`; `releases.withdrawn_at`, `withdrawn_by`, `withdrawn_reason`; `plans.update_window` (JSON `{ days, start, end, timeZone }`), `plans.policy_note` (`"<version>: <reason>"` of the last refused policy rollout).

**New audit actions** (`AUDIT_ACTIONS`): `rollout.started`, `rollout.step`, `rollout.paused` (detail `alert: true` when Vetra paused it), `rollout.resumed`, `rollout.cancelled`, `rollout.completed`, `rollout.rolling_back`, `rollout.rolled_back`, `rollout.policy_refused`, `instance.pinned`, `instance.unpinned`, `instance.update_requested`, `release.withdrawn`. Subjects: `rollout:<id>`, `plan:<id>`, `instance:<id>`, `release:<version>`. People's rows: actor = address, source = `console`/`api`. Runner rows: actor `vetra`, source `system`; policy rollouts and their refusals: actor `vetra`, source `policy`.

## Global Constraints

- Additive schema only (idempotent, race-tolerant `ensure…` migrations; namespaced schema builder). New optional columns are declared with `?` in `db/schema.ts`, so existing row literals (tests, `newRow`) still type-check.
- Rollouts only ever touch `instances` rows of kind `shared` and `own` (and their environments through the reconciler). Never `license_environments`, `app_rollouts`, `environment_updates`, branch or preview instances.
- After this slice nothing but a rollout step, a rollback step or `pinInstance` changes an existing shared or own instance's `target_*` columns (tested in Task 7).
- Every mutation that writes steps, plan targets or instance targets runs under `withKeyLock(appInstancesLock(appId))` and in one transaction with its audit rows. Code that runs under that lock (the runner, `beginRollout`) never takes it again.
- At most one step per App is `applying` or `reverting` (runner logic and the partial unique index).
- Times fail closed: a `due_at` or `started_at` that does not parse is never due and always timed out.
- Nothing runs while plans are off (`rolloutsEnabled(cfg)` false): the runner returns at once, `startRollout` refuses. `VETRA_APPS_ROLLOUTS_HOLD=on` stops starts only.
- Access: rollout mutations, pins and `withdrawRelease` use `need: "release"`; `appRollouts`, `rollout`, `checkRollout` use `need: "view"`; `updateInstanceNow` is for the own instance's holder only.
- Commits: one per task, conventional (`feat(rollouts): …`, `feat(plans): …`, `feat(releases): …`, `feat(instances): …`, `feat(apps): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-rollouts` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4): check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-apps/config.ts` | `PlansConfig.rolloutsHold?`, `VETRA_APPS_ROLLOUTS_HOLD`, `rolloutsEnabled`, `rolloutsHeld` |
| `subgraphs/vetra-apps/db/schema.ts` | `RolloutsTable`, `RolloutPlansTable`, `RolloutStepsTable` and their unions; optional columns on plans, releases, instances |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureRolloutTables`, `ensureRolloutColumns` in `up` |
| `subgraphs/vetra-apps/audit/repo.ts` | new `AUDIT_ACTIONS` |
| `subgraphs/vetra-apps/rollouts/repo.ts` (new) | rows, reads, guarded writes, `appInstancesLock` |
| `subgraphs/vetra-apps/rollouts/window.ts` (new) | `UpdateWindow`, `checkWindow`, `parseWindow`, `inWindow`, `nextWindowStart` |
| `subgraphs/vetra-apps/rollouts/policy.ts` (new) | `parsePolicy`, `policyText`, `policyCandidate` |
| `subgraphs/vetra-apps/rollouts/check.ts` (new) | `releaseProblem`, `planFitProblem`, `teamGateProblem`, `LICENCE_GATE_MIN_POWERHOUSE` |
| `subgraphs/vetra-apps/rollouts/service.ts` (new) | `plannedSteps`, `rolloutProblems`, `beginRollout`, `startRollout`, `checkRolloutFor`, `rolloutJson`, `appRolloutsFor`, `rolloutFor`, `loadRollout` |
| `subgraphs/vetra-apps/rollouts/controls.ts` (new) | `pauseRollout`, `resumeRollout`, `cancelRollout`, `retryRolloutStep`, `skipRolloutStep`, `rollBackRollout` |
| `subgraphs/vetra-apps/rollouts/runner.ts` (new) | `advanceRollouts` (settle, start, finish, `runPolicies`), `pointInstanceAt`, `stepEntry` |
| `subgraphs/vetra-apps/rollouts/pins.ts` (new) | `pinInstance`, `unpinInstance` |
| `subgraphs/vetra-apps/rollouts/holder.ts` (new) | `holderUpdateOf`, `updateInstanceNow` |
| `subgraphs/vetra-apps/releases/withdraw.ts` (new) | `withdrawRelease` |
| `subgraphs/vetra-apps/releases/service.ts` | `ReleaseJson.withdrawn` |
| `subgraphs/vetra-apps/plans/service.ts` | withdrawn targets refused; `updatePlanFor` policy/notice/window; `setPlanTarget` starts a rollout; `planJson` fields |
| `subgraphs/vetra-apps/plans/sync.ts` | existing rows keep their target |
| `subgraphs/vetra-apps/plans/holder-view.ts` | `kind`, `update` |
| `subgraphs/vetra-apps/instances/reconciler.ts` | `advanceRollouts` in `reconcileApp` |
| `subgraphs/vetra-apps/instances/service.ts` | `InstanceJson.pinnedVersion` |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | rollout types, queries and mutations |
| Tests (new) | `__tests__/rollouts-fixtures.ts`, `rollouts-repo.test.ts`, `rollouts-window.test.ts`, `rollouts-policy.test.ts`, `rollouts-check.test.ts`, `rollouts-start.test.ts`, `rollouts-runner.test.ts`, `rollouts-controls.test.ts`, `rollouts-rollback.test.ts`, `rollouts-pins.test.ts`, `releases-withdraw.test.ts`, `rollouts-policies.test.ts`, `rollouts-holder.test.ts`, `rollouts-graphql.test.ts` |
| Tests (changed) | `config.test.ts`, `migrations.test.ts`, `plans-api.test.ts`, `instances-plans.test.ts` |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Branch.** `git fetch && git checkout -b feat/releases-phase-3-rollouts origin/main`. Never stash, and never touch the other worktrees of this repository (`git worktree list` shows them).
- [ ] **Step 2: Baseline.** `npx vitest run subgraphs/vetra-apps shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record failures that exist before any change in the PR description; do not fix them here.

---

### Task 1: Config (`rolloutsEnabled`, the hold brake)

**Files:**
- Modify: `subgraphs/vetra-apps/config.ts`
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts`

**Interfaces:**
- Produces: `PlansConfig.rolloutsHold?: boolean` (present and `true` only when `VETRA_APPS_ROLLOUTS_HOLD` is on, so `loadAppsConfig({}).plans` keeps its shape); `rolloutsEnabled(cfg: VetraAppsConfig): boolean` (= `plansConfigOf(cfg).enabled && cfg.instances.enabled`, decision R1); `rolloutsHeld(cfg): boolean`.

- [ ] **Step 1: Write the failing test.** In `config.test.ts` add `rolloutsEnabled, rolloutsHeld` to the import from `../config.js` and append inside `describe("plans config", …)`:

```ts
  it("runs rollouts with plans, and holds them with VETRA_APPS_ROLLOUTS_HOLD", () => {
    expect(rolloutsEnabled(loadAppsConfig({}))).toBe(false);
    const on = loadAppsConfig({ VETRA_APPS_PLANS: "on" });
    expect(rolloutsEnabled(on)).toBe(true);
    expect(rolloutsHeld(on)).toBe(false);
    expect(on.plans).toEqual({ enabled: true, stopAfterDays: 14 });
    expect(
      rolloutsEnabled(
        loadAppsConfig({ VETRA_APPS_PLANS: "on", VETRA_APPS_INSTANCES: "off" }),
      ),
    ).toBe(false);
    const held = loadAppsConfig({
      VETRA_APPS_PLANS: "on",
      VETRA_APPS_ROLLOUTS_HOLD: " Yes ",
    });
    expect(rolloutsHeld(held)).toBe(true);
    expect(held.plans).toEqual({
      enabled: true,
      stopAfterDays: 14,
      rolloutsHold: true,
    });
    expect(() =>
      loadAppsConfig({ VETRA_APPS_ROLLOUTS_HOLD: "later" }),
    ).toThrow(/VETRA_APPS_ROLLOUTS_HOLD.*later/);
  });
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`rolloutsEnabled` is not exported).
- [ ] **Step 3: Implement.** In `config.ts`:
  - extend `PlansConfig`:

```ts
export interface PlansConfig {
  enabled: boolean;
  stopAfterDays: number;
  /**
   * VETRA_APPS_ROLLOUTS_HOLD=on: no rollout step and no policy rollout starts
   * (decision R1); a moving step still settles. Present only when on.
   */
  rolloutsHold?: boolean;
}
```

  - add, after `intIn`:

```ts
/** An on/off switch that is off when unset; anything else refuses to boot. */
function switchOn(env: Env, name: string): boolean {
  const raw = (trimmed(env[name]) ?? "").toLowerCase();
  if (!INSTANCES_OFF.has(raw) && !INSTANCES_ON.has(raw))
    throw new Error(
      `${name} "${env[name]}" is invalid: use on/off (also true/false, 1/0, yes/no)`,
    );
  return raw !== "" && INSTANCES_ON.has(raw);
}
```

  - in `plansConfig(env)`, return `{ enabled: …, stopAfterDays: …, ...(switchOn(env, "VETRA_APPS_ROLLOUTS_HOLD") ? { rolloutsHold: true } : {}) }`;
  - after `plansConfigOf`:

```ts
/**
 * Rollouts are part of plans (releases phase 3 slice 3, decision R1): they
 * run whenever plan instances do. There is no separate switch, because with
 * plans on nothing else moves a shared or own instance's target.
 */
export const rolloutsEnabled = (cfg: VetraAppsConfig): boolean =>
  plansConfigOf(cfg).enabled && cfg.instances.enabled;

/** The brake: nothing starts while it is on. */
export const rolloutsHeld = (cfg: VetraAppsConfig): boolean =>
  plansConfigOf(cfg).rolloutsHold === true;
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS (the existing plans-config expectations are unchanged).
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/__tests__/config.test.ts && git commit -m "feat(rollouts): rollouts run with plans; VETRA_APPS_ROLLOUTS_HOLD brake" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---
### Task 2: Rollout tables, new columns, the rollouts repo, audit actions

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`, `subgraphs/vetra-apps/audit/repo.ts`
- Create: `subgraphs/vetra-apps/rollouts/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`, `subgraphs/vetra-apps/__tests__/rollouts-repo.test.ts`

**Interfaces:**
- Produces (schema): `RolloutStatus`, `RolloutDirection`, `RolloutSource`, `RolloutStepStatus`, `RolloutsTable`, `RolloutPlansTable`, `RolloutStepsTable`; `VetraAppsDB.rollouts`, `.rollout_plans`, `.rollout_steps`; optional `PlansTable.update_window`, `PlansTable.policy_note`, `ReleasesTable.withdrawn_at`, `.withdrawn_by`, `.withdrawn_reason`, `InstancesTable.pinned_version`.
- Produces (migrations): `ensureRolloutTables(db)`, `ensureRolloutColumns(db)`, both at the end of `up`.
- Produces (`audit/repo.ts`): the thirteen actions of the Model in `AUDIT_ACTIONS`.
- Produces (`rollouts/repo.ts`): `RolloutRow`, `RolloutPlanRow`, `RolloutStepRow`, `OPEN_ROLLOUT`, `MOVING`, `appInstancesLock(appId)`, `insertRollout`, `getRollout`, `lockRollout`, `updateRollout`, `listRollouts`, `openRollouts`, `openRolloutOfPlan`, `insertRolloutPlans`, `rolloutPlans`, `insertSteps`, `stepsOf`, `getStep`, `movingStep`, `updateStep`, `transitionStep`, `pendingStepOfInstance`.

- [ ] **Step 1: Write the failing tests.** In `migrations.test.ts` add `ensureRolloutTables, ensureRolloutColumns` to the import from `../db/migrations.js`, and append:

```ts
describe("rollout tables", () => {
  it("are created idempotently and concurrently, with the new columns and one moving step per App", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all(
        [1, 2, 3].flatMap(() => [
          ensureRolloutTables(any),
          ensureRolloutColumns(any),
        ]),
      );
      const cols = async (t: string) =>
        (
          await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'vetra-apps' and table_name = ${t}`.execute(
            root,
          )
        ).rows.map((r) => r.column_name);
      expect(await cols("instances")).toContain("pinned_version");
      expect(await cols("releases")).toEqual(
        expect.arrayContaining(["withdrawn_at", "withdrawn_by", "withdrawn_reason"]),
      );
      expect(await cols("plans")).toEqual(
        expect.arrayContaining(["update_window", "policy_note"]),
      );
      const step = (id: string, instance: string, status: string) => ({
        id,
        rollout_id: "r1",
        app_id: "app-1",
        plan_id: "p1",
        instance_id: instance,
        instance_kind: "own",
        instance_name: instance,
        position: 0,
        from_version: "1.0.0",
        to_version: "1.1.0",
        status,
        due_at: "2026-11-12T00:00:00.000Z",
        requested_at: null,
        started_at: null,
        finished_at: null,
        target_moved: false,
        attempts: 0,
        error: null,
        note: null,
        created_at: "2026-11-12T00:00:00.000Z",
        updated_at: "2026-11-12T00:00:00.000Z",
      });
      await any.insertInto("rollout_steps").values(step("s1", "i1", "applying")).execute();
      await any.insertInto("rollout_steps").values(step("s2", "i2", "pending")).execute();
      await expect(
        any.insertInto("rollout_steps").values(step("s3", "i3", "reverting")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await root.destroy();
    }
  });
});
```

Create `__tests__/rollouts-repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./harness.js";
import {
  getRollout,
  insertRollout,
  insertRolloutPlans,
  insertSteps,
  movingStep,
  openRolloutOfPlan,
  openRollouts,
  stepsOf,
  transitionStep,
  type RolloutRow,
  type RolloutStepRow,
} from "../rollouts/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const T = "2026-11-12T00:00:00.000Z";
const rollout = (over: Partial<RolloutRow> = {}): RolloutRow => ({
  id: "r1",
  app_id: "app-1",
  version: "1.1.0",
  status: "active",
  direction: "forward",
  source: "api",
  started_by: "0xaa",
  started_at: T,
  notes: null,
  paused_at: null,
  paused_reason: null,
  finished_at: null,
  rolled_back_by: null,
  rolled_back_at: null,
  updated_at: T,
  ...over,
});
const step = (over: Partial<RolloutStepRow>): RolloutStepRow => ({
  id: "s1",
  rollout_id: "r1",
  app_id: "app-1",
  plan_id: "p1",
  instance_id: "i1",
  instance_kind: "own",
  instance_name: "own-1",
  position: 0,
  from_version: "1.0.0",
  to_version: "1.1.0",
  status: "pending",
  due_at: T,
  requested_at: null,
  started_at: null,
  finished_at: null,
  target_moved: false,
  attempts: 0,
  error: null,
  note: null,
  created_at: T,
  updated_at: T,
  ...over,
});

describe("rollouts repo", () => {
  it("finds open rollouts of a plan, steps in order, the moving step, and transitions steps only from the given statuses", async () => {
    await insertRollout(h.db, rollout());
    await insertRollout(h.db, rollout({ id: "r0", status: "complete", started_at: "2026-11-11T00:00:00.000Z" }));
    await insertRolloutPlans(h.db, [
      { rollout_id: "r1", plan_id: "p1", from_version: "1.0.0", notice_hours: 0 },
      { rollout_id: "r0", plan_id: "p2", from_version: null, notice_hours: 0 },
    ]);
    await insertSteps(h.db, [
      step({ id: "s2", instance_id: "i2", position: 1 }),
      step({ id: "s1", position: 0 }),
    ]);
    expect((await openRollouts(h.db, "app-1")).map((r) => r.id)).toEqual(["r1"]);
    expect((await openRolloutOfPlan(h.db, "p1"))?.id).toBe("r1");
    expect(await openRolloutOfPlan(h.db, "p2")).toBeNull();
    expect((await stepsOf(h.db, "r1")).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(await movingStep(h.db, "app-1")).toBeNull();
    const moved = await transitionStep(h.db, "s1", ["pending"], { status: "applying" }, T);
    expect(moved?.status).toBe("applying");
    expect(await transitionStep(h.db, "s1", ["pending"], { status: "skipped" }, T)).toBeNull();
    expect((await movingStep(h.db, "app-1"))?.id).toBe("s1");
    expect((await getRollout(h.db, "r1"))?.direction).toBe("forward");
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/rollouts-repo.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (exports and module missing).
- [ ] **Step 3: Schema.** In `db/schema.ts`:
  - in `ReleasesTable`, after `base_image`:

```ts
  /** Withdrawn by the publisher (spec 14.3): no plan may target it. Never un-withdrawn. */
  withdrawn_at?: string | null;
  withdrawn_by?: string | null;
  withdrawn_reason?: string | null;
```

  - in `PlansTable`, after `notice_hours`:

```ts
  /** JSON rollouts/window.ts UpdateWindow; null: any time (spec 14.8). */
  update_window?: string | null;
  /** "<version>: <reason>" of the last policy rollout the check refused; null when none. */
  policy_note?: string | null;
```

  - in `InstancesTable`, after `target_size`:

```ts
  /** own: the release the publisher pinned it to (spec section 7); rollouts skip it. */
  pinned_version?: string | null;
```

  - after `AppRolesTable`:

```ts
/** Releases phase 3 slice 3 (spec section 7). Lowercase like every vetra-apps status. */
export type RolloutStatus =
  | "active"
  | "paused"
  | "complete"
  | "cancelled"
  | "rolled_back";
/** forward: towards the version; back: rollBackRollout returns instances to where they came from. */
export type RolloutDirection = "forward" | "back";
export type RolloutSource = "console" | "api" | "policy";

/** One move of one or more plans to a release. */
export interface RolloutsTable {
  id: string;
  app_id: string;
  version: string;
  status: RolloutStatus;
  direction: RolloutDirection;
  source: RolloutSource;
  /** Lowercased address, or "vetra" (a policy). */
  started_by: string;
  started_at: string;
  /** What holders see: the release's customer notes (else its notes) at the start. */
  notes: string | null;
  paused_at: string | null;
  paused_reason: string | null;
  finished_at: string | null;
  rolled_back_by: string | null;
  rolled_back_at: string | null;
  updated_at: string;
}

export interface RolloutPlansTable {
  rollout_id: string;
  plan_id: string;
  /** The plan's target before (null: none); rollBackRollout sets it back. */
  from_version: string | null;
  notice_hours: number;
}

export type RolloutStepStatus =
  | "pending"
  | "applying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "revert_pending"
  | "reverting"
  | "revert_failed"
  | "rolled_back";

/** One instance's move within a rollout. */
export interface RolloutStepsTable {
  id: string;
  rollout_id: string;
  app_id: string;
  plan_id: string;
  instance_id: string;
  instance_kind: "shared" | "own";
  instance_name: string;
  /** Shared instances first, then own by age (spec 7 step 4). */
  position: number;
  /** The instance's target when the rollout started: where a revert goes. */
  from_version: string | null;
  to_version: string;
  status: RolloutStepStatus;
  /** Start + notice; the plan's window applies after it. */
  due_at: string;
  /** The holder's "update now" or the publisher's retry: due at once, outside the window. */
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** The runner set the instance's target for this step; a rollback sets it back. */
  target_moved: boolean;
  attempts: number;
  error: string | null;
  /** "pinned at 1.4.2", "stopped: updated when it wakes", … */
  note: string | null;
  created_at: string;
  updated_at: string;
}
```

  - in `VetraAppsDB` add `rollouts: RolloutsTable; rollout_plans: RolloutPlansTable; rollout_steps: RolloutStepsTable;`.

- [ ] **Step 4: Migrations.** In `db/migrations.ts`, append to `up`: `await ensureRolloutTables(db); await ensureRolloutColumns(db);` and add:

```ts
/** Rollouts (releases phase 3 slice 3, spec section 7). Schema builder only (namespaced). */
export async function ensureRolloutTables(db: Kysely<any>): Promise<void> {
  const tolerant = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      if (!isConcurrentIndexError(err)) throw err;
    }
  };
  await tolerant(() =>
    db.schema
      .createTable("rollouts")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("version", "varchar(255)", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("direction", "varchar(16)", (c) => c.notNull())
      .addColumn("source", "varchar(16)", (c) => c.notNull())
      .addColumn("started_by", "varchar(255)", (c) => c.notNull())
      .addColumn("started_at", "varchar(64)", (c) => c.notNull())
      .addColumn("notes", "text")
      .addColumn("paused_at", "varchar(64)")
      .addColumn("paused_reason", "text")
      .addColumn("finished_at", "varchar(64)")
      .addColumn("rolled_back_by", "varchar(255)")
      .addColumn("rolled_back_at", "varchar(64)")
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .execute(),
  );
  await tolerant(() =>
    db.schema
      .createTable("rollout_plans")
      .ifNotExists()
      .addColumn("rollout_id", "varchar(64)", (c) => c.notNull())
      .addColumn("plan_id", "varchar(64)", (c) => c.notNull())
      .addColumn("from_version", "varchar(255)")
      .addColumn("notice_hours", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("rollout_plans_pk", ["rollout_id", "plan_id"])
      .execute(),
  );
  await tolerant(() =>
    db.schema
      .createTable("rollout_steps")
      .ifNotExists()
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("rollout_id", "varchar(64)", (c) => c.notNull())
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("plan_id", "varchar(64)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("instance_kind", "varchar(16)", (c) => c.notNull())
      .addColumn("instance_name", "varchar(255)", (c) => c.notNull())
      .addColumn("position", "integer", (c) => c.notNull())
      .addColumn("from_version", "varchar(255)")
      .addColumn("to_version", "varchar(255)", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("due_at", "varchar(64)", (c) => c.notNull())
      .addColumn("requested_at", "varchar(64)")
      .addColumn("started_at", "varchar(64)")
      .addColumn("finished_at", "varchar(64)")
      .addColumn("target_moved", "boolean", (c) => c.notNull())
      .addColumn("attempts", "integer", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("note", "text")
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .addUniqueConstraint("rollout_steps_instance_uq", ["rollout_id", "instance_id"])
      .execute(),
  );
  for (const [name, table, columns] of [
    ["rollouts_app_status_idx", "rollouts", ["app_id", "status"]],
    ["rollout_plans_plan_idx", "rollout_plans", ["plan_id"]],
    ["rollout_steps_rollout_idx", "rollout_steps", ["rollout_id", "position"]],
    ["rollout_steps_instance_idx", "rollout_steps", ["instance_id", "status"]],
  ] as const)
    await tolerant(() =>
      db.schema.createIndex(name).ifNotExists().on(table).columns([...columns]).execute(),
    );
  // One moving instance per App (spec section 7: one instance at a time).
  await tolerant(() =>
    db.schema
      .createIndex("rollout_steps_moving_uq")
      .ifNotExists()
      .unique()
      .on("rollout_steps")
      .column("app_id")
      .where((eb) =>
        eb.or([eb("status", "=", "applying"), eb("status", "=", "reverting")]),
      )
      .execute(),
  );
}

/** Pinning, withdrawing, plan windows and policy notes (slice 3). Nullable. */
export async function ensureRolloutColumns(db: Kysely<any>): Promise<void> {
  for (const [table, name, type] of [
    ["instances", "pinned_version", "varchar(255)"],
    ["releases", "withdrawn_at", "varchar(64)"],
    ["releases", "withdrawn_by", "varchar(255)"],
    ["releases", "withdrawn_reason", "text"],
    ["plans", "update_window", "text"],
    ["plans", "policy_note", "text"],
  ] as const) {
    try {
      await db.schema
        .alterTable(table)
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err))
        throw err;
    }
  }
}
```

If Kysely's `createIndex().where(callback)` does not compile for `Kysely<any>`, write the predicate as `.where(sql.ref("status"), "in", sql\`('applying', 'reverting')\`)`; the migration test's `23505` assertion decides.

- [ ] **Step 5: Audit actions.** In `audit/repo.ts` extend `AUDIT_ACTIONS` after `"build.recorded"`:

```ts
  "rollout.started",
  "rollout.step",
  "rollout.paused",
  "rollout.resumed",
  "rollout.cancelled",
  "rollout.completed",
  "rollout.rolling_back",
  "rollout.rolled_back",
  "rollout.policy_refused",
  "instance.pinned",
  "instance.unpinned",
  "instance.update_requested",
  "release.withdrawn",
```

- [ ] **Step 6: The repo.** Create `rollouts/repo.ts`:

```ts
import type { Kysely, Selectable } from "kysely";
import type {
  RolloutPlansTable,
  RolloutStepStatus,
  RolloutStepsTable,
  RolloutsTable,
  VetraAppsDB,
} from "../db/schema.js";

export type RolloutRow = Selectable<RolloutsTable>;
export type RolloutPlanRow = Selectable<RolloutPlansTable>;
export type RolloutStepRow = Selectable<RolloutStepsTable>;
export type RolloutPatch = Partial<Omit<RolloutRow, "id" | "app_id" | "updated_at">>;
export type StepPatch = Partial<
  Omit<RolloutStepRow, "id" | "rollout_id" | "app_id" | "instance_id" | "updated_at">
>;

/** Rollouts that still decide something. */
export const OPEN_ROLLOUT = ["active", "paused"] as const;
/** Steps that move an instance now: at most one per App (rollout_steps_moving_uq). */
export const MOVING = ["applying", "reverting"] as const;

/**
 * The lock every writer of an App's plan-instance targets takes: the
 * reconciler's per-App lock (reconcileInstancesOnce). In-process and not
 * re-entrant: code running under it never takes it again.
 */
export const appInstancesLock = (appId: string) => `instances:${appId}`;

export async function insertRollout(
  db: Kysely<VetraAppsDB>,
  row: RolloutRow,
): Promise<RolloutRow> {
  return db.insertInto("rollouts").values(row).returningAll().executeTakeFirstOrThrow();
}

export async function getRollout(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<RolloutRow | null> {
  return (
    (await db.selectFrom("rollouts").selectAll().where("id", "=", id).executeTakeFirst()) ??
    null
  );
}

/** The rollout, locked until the transaction ends. */
export async function lockRollout(
  trx: Kysely<VetraAppsDB>,
  id: string,
): Promise<RolloutRow> {
  return trx
    .selectFrom("rollouts")
    .selectAll()
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function updateRollout(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: RolloutPatch,
  nowIso: string,
): Promise<RolloutRow> {
  return db
    .updateTable("rollouts")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Newest first. */
export async function listRollouts(
  db: Kysely<VetraAppsDB>,
  appId: string,
  limit: number,
): Promise<RolloutRow[]> {
  return db
    .selectFrom("rollouts")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("started_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
}

/** The App's active and paused rollouts, oldest first (the order they run in). */
export async function openRollouts(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<RolloutRow[]> {
  return db
    .selectFrom("rollouts")
    .selectAll()
    .where("app_id", "=", appId)
    .where("status", "in", [...OPEN_ROLLOUT])
    .orderBy("started_at")
    .orderBy("id")
    .execute();
}

/** The active or paused rollout the plan is in (decision R7: at most one). */
export async function openRolloutOfPlan(
  db: Kysely<VetraAppsDB>,
  planId: string,
): Promise<RolloutRow | null> {
  return (
    (await db
      .selectFrom("rollouts")
      .innerJoin("rollout_plans", "rollout_plans.rollout_id", "rollouts.id")
      .selectAll("rollouts")
      .where("rollout_plans.plan_id", "=", planId)
      .where("rollouts.status", "in", [...OPEN_ROLLOUT])
      .orderBy("rollouts.started_at", "desc")
      .executeTakeFirst()) ?? null
  );
}

export async function insertRolloutPlans(
  db: Kysely<VetraAppsDB>,
  rows: RolloutPlanRow[],
): Promise<void> {
  if (rows.length > 0) await db.insertInto("rollout_plans").values(rows).execute();
}

export async function rolloutPlans(
  db: Kysely<VetraAppsDB>,
  rolloutId: string,
): Promise<RolloutPlanRow[]> {
  return db
    .selectFrom("rollout_plans")
    .selectAll()
    .where("rollout_id", "=", rolloutId)
    .orderBy("plan_id")
    .execute();
}

export async function insertSteps(
  db: Kysely<VetraAppsDB>,
  rows: RolloutStepRow[],
): Promise<void> {
  if (rows.length > 0) await db.insertInto("rollout_steps").values(rows).execute();
}

export async function stepsOf(
  db: Kysely<VetraAppsDB>,
  rolloutId: string,
): Promise<RolloutStepRow[]> {
  return db
    .selectFrom("rollout_steps")
    .selectAll()
    .where("rollout_id", "=", rolloutId)
    .orderBy("position")
    .orderBy("id")
    .execute();
}

export async function getStep(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<RolloutStepRow | null> {
  return (
    (await db.selectFrom("rollout_steps").selectAll().where("id", "=", id).executeTakeFirst()) ??
    null
  );
}

/** The App's step that is applying or reverting, of any rollout (a cancelled one's too). */
export async function movingStep(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<RolloutStepRow | null> {
  return (
    (await db
      .selectFrom("rollout_steps")
      .selectAll()
      .where("app_id", "=", appId)
      .where("status", "in", [...MOVING])
      .executeTakeFirst()) ?? null
  );
}

export async function updateStep(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: StepPatch,
  nowIso: string,
): Promise<RolloutStepRow> {
  return db
    .updateTable("rollout_steps")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Guarded (as licensing's transitionUpdate): null when the step is no longer in `from`. */
export async function transitionStep(
  db: Kysely<VetraAppsDB>,
  id: string,
  from: RolloutStepStatus[],
  patch: StepPatch,
  nowIso: string,
): Promise<RolloutStepRow | null> {
  return (
    (await db
      .updateTable("rollout_steps")
      .set({ ...patch, updated_at: nowIso })
      .where("id", "=", id)
      .where("status", "in", from)
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

/** The instance's step waiting in an open forward rollout, with that rollout. */
export async function pendingStepOfInstance(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<{ step: RolloutStepRow; rollout: RolloutRow } | null> {
  const step = await db
    .selectFrom("rollout_steps")
    .innerJoin("rollouts", "rollouts.id", "rollout_steps.rollout_id")
    .selectAll("rollout_steps")
    .where("rollout_steps.instance_id", "=", instanceId)
    .where("rollout_steps.status", "=", "pending")
    .where("rollouts.status", "in", [...OPEN_ROLLOUT])
    .where("rollouts.direction", "=", "forward")
    .orderBy("rollouts.started_at", "desc")
    .executeTakeFirst();
  if (!step) return null;
  return { step, rollout: (await getRollout(db, step.rollout_id))! };
}
```

- [ ] **Step 7: Run them again.** Same command as Step 2. Expected: PASS.
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps/db subgraphs/vetra-apps/audit/repo.ts subgraphs/vetra-apps/rollouts/repo.ts subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/rollouts-repo.test.ts && git commit -m "feat(rollouts): rollout tables, pin/withdraw/window columns, repo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Update windows (pure)

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/window.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-window.test.ts`

**Interfaces:**
- Produces: `UpdateWindow { days: number[]; start: string; end: string; timeZone: string }`; `checkWindow(w): UpdateWindow` (BAD_USER_INPUT on anything malformed; days sorted and unique); `parseWindow(json: string | null | undefined): UpdateWindow | null`; `inWindow(w, at: Date): boolean`; `nextWindowStart(w, from: Date): Date` (`from` itself when inside; scans minute by minute up to 8 days, about 30 ms at worst).

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-window.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  checkWindow,
  inWindow,
  nextWindowStart,
  parseWindow,
} from "../rollouts/window.js";

const d = (s: string) => new Date(s);
const NIGHTS = { days: [6, 7], start: "22:00", end: "06:00", timeZone: "Europe/Berlin" };

describe("update windows (spec 14.8)", () => {
  it("runs past midnight from the days it starts on", () => {
    // Sat 2026-11-14 22:30 CET: in.
    expect(inWindow(NIGHTS, d("2026-11-14T21:30:00.000Z"))).toBe(true);
    // Mon 2026-11-16 05:00 CET: Sunday's night, in.
    expect(inWindow(NIGHTS, d("2026-11-16T04:00:00.000Z"))).toBe(true);
    // Fri 2026-11-13 23:00 CET: Friday is not a day of the window.
    expect(inWindow(NIGHTS, d("2026-11-13T22:00:00.000Z"))).toBe(false);
    // Mon 2026-11-16 06:00 CET: the end is excluded.
    expect(inWindow(NIGHTS, d("2026-11-16T05:00:00.000Z"))).toBe(false);
    // Thu 2026-11-12 11:00 CET -> Sat 22:00 CET.
    expect(nextWindowStart(NIGHTS, d("2026-11-12T10:00:00.000Z")).toISOString()).toBe(
      "2026-11-14T21:00:00.000Z",
    );
  });

  it("follows the DST changes of the zone", () => {
    const early = { days: [1, 2, 3, 4, 5, 6, 7], start: "02:00", end: "04:00", timeZone: "Europe/Berlin" };
    // 2026-03-29: 02:00 CET does not exist; the next local 02:00-04:00 minute is 03:00 CEST = 01:00Z.
    expect(inWindow(early, d("2026-03-29T00:59:00.000Z"))).toBe(false);
    expect(nextWindowStart(early, d("2026-03-29T00:30:00.000Z")).toISOString()).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    // 2026-10-25: 02:00-03:00 happens twice (CEST, then CET); both are in.
    const sunday = { days: [7], start: "02:00", end: "03:00", timeZone: "Europe/Berlin" };
    expect(inWindow(sunday, d("2026-10-25T00:30:00.000Z"))).toBe(true);
    expect(inWindow(sunday, d("2026-10-25T01:30:00.000Z"))).toBe(true);
    expect(inWindow(sunday, d("2026-10-25T02:00:00.000Z"))).toBe(false);
  });

  it("start == end is the whole day; a time inside is its own next start", () => {
    const sundays = { days: [7], start: "00:00", end: "00:00", timeZone: "UTC" };
    const at = d("2026-11-15T13:37:00.000Z");
    expect(inWindow(sundays, at)).toBe(true);
    expect(nextWindowStart(sundays, at)).toBe(at);
  });

  it("checks and normalises; parses stored JSON", () => {
    expect(checkWindow({ days: [7, 6, 6], start: "22:00", end: "06:00", timeZone: "Europe/Berlin" }).days).toEqual([6, 7]);
    for (const bad of [
      { days: [], start: "22:00", end: "06:00", timeZone: "UTC" },
      { days: [8], start: "22:00", end: "06:00", timeZone: "UTC" },
      { days: [1], start: "24:00", end: "06:00", timeZone: "UTC" },
      { days: [1], start: "7:00", end: "08:00", timeZone: "UTC" },
      { days: [1], start: "07:00", end: "08:00", timeZone: "Mars/Olympus" },
    ])
      expect(() => checkWindow(bad)).toThrow();
    expect(parseWindow(null)).toBeNull();
    expect(parseWindow(JSON.stringify(NIGHTS))).toEqual(NIGHTS);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-window.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Create `rollouts/window.ts`:

```ts
import { appsError } from "../errors.js";

/** When a plan's instances may be updated (spec 14.8; decision R12). */
export interface UpdateWindow {
  /** ISO weekdays, 1 = Monday … 7 = Sunday: the days the window starts on. */
  days: number[];
  /** Local "HH:MM" (24 h). end <= start runs past midnight; equal: the whole day. */
  start: string;
  end: string;
  /** IANA time zone, e.g. Europe/Berlin. */
  timeZone: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (s: string) => {
  const m = HHMM.exec(s)!;
  return Number(m[1]) * 60 + Number(m[2]);
};
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const MINUTE_MS = 60_000;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws BAD_USER_INPUT on anything malformed; days come back sorted and unique. */
export function checkWindow(w: UpdateWindow): UpdateWindow {
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  if (days.length === 0 || days.some((x) => !Number.isInteger(x) || x < 1 || x > 7))
    throw appsError(
      "BAD_USER_INPUT",
      "An update window's days are 1 (Monday) to 7 (Sunday), at least one",
    );
  if (!HHMM.test(w.start) || !HHMM.test(w.end))
    throw appsError("BAD_USER_INPUT", "An update window's start and end are HH:MM (24 h)");
  if (!validTimeZone(w.timeZone))
    throw appsError(
      "BAD_USER_INPUT",
      `Unknown time zone ${w.timeZone} (use an IANA name such as Europe/Berlin)`,
    );
  return { days, start: w.start, end: w.end, timeZone: w.timeZone };
}

export function parseWindow(json: string | null | undefined): UpdateWindow | null {
  return json ? (JSON.parse(json) as UpdateWindow) : null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function local(at: Date, timeZone: string): { day: number; minute: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { day: WEEKDAY[p.weekday], minute: Number(p.hour) * 60 + Number(p.minute) };
}

export function inWindow(w: UpdateWindow, at: Date): boolean {
  const { day, minute } = local(at, w.timeZone);
  const s = minutesOf(w.start);
  const e = minutesOf(w.end);
  if (s === e) return w.days.includes(day);
  if (s < e) return w.days.includes(day) && minute >= s && minute < e;
  const previous = day === 1 ? 7 : day - 1;
  return (w.days.includes(day) && minute >= s) || (w.days.includes(previous) && minute < e);
}

/** The first minute at or after `from` inside the window; `from` itself when inside. */
export function nextWindowStart(w: UpdateWindow, from: Date): Date {
  if (inWindow(w, from)) return from;
  const last = from.getTime() + 8 * 24 * 60 * MINUTE_MS;
  for (let t = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS; t <= last; t += MINUTE_MS)
    if (inWindow(w, new Date(t))) return new Date(t);
  // Unreachable for a checked window (at least one day a week).
  return from;
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/rollouts/window.ts subgraphs/vetra-apps/__tests__/rollouts-window.test.ts && git commit -m "feat(rollouts): update windows with IANA time zones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Policies (pure)

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/policy.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-policy.test.ts`

**Interfaces:**
- Produces: `Policy = { kind: "manual" } | { kind: "patches" } | { kind: "minor" } | { kind: "follow"; branch: string }`; `parsePolicy(v: string): Policy` (BAD_USER_INPUT otherwise); `policyText(p): string`; `PolicyRelease = Pick<ReleaseRow, "version" | "kind" | "branch" | "run" | "withdrawn_at">`; `policyCandidate(p, current: string, releases: PolicyRelease[]): PolicyRelease | null` (decision R13).

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePolicy, policyCandidate, policyText } from "../rollouts/policy.js";

const r = (version: string, run: number, branch = "main", withdrawn_at: string | null = null) => ({
  version,
  kind: "release" as const,
  branch,
  run,
  withdrawn_at,
});
const RELEASES = [
  r("1.4.0", 100),
  r("1.4.1", 110),
  r("1.4.2-rc.1", 115, "next"),
  r("1.4.3", 116, "main", "2026-11-12T00:00:00.000Z"),
  r("1.5.0", 120),
  r("2.0.0", 130),
  r("2.1.0-beta.1", 140, "next"),
];
const pick = (policy: string, current = "1.4.0") =>
  policyCandidate(parsePolicy(policy), current, RELEASES)?.version ?? null;

describe("policies (spec section 7)", () => {
  it("manual: nothing; patches: the highest stable patch; minor: the highest stable minor; never a major, a prerelease or a withdrawn release", () => {
    expect(pick("manual")).toBeNull();
    expect(pick("patches")).toBe("1.4.1");
    expect(pick("minor")).toBe("1.5.0");
    expect(pick("patches", "1.4.1")).toBeNull();
    expect(pick("minor", "1.5.0")).toBeNull();
  });

  it("follow:<branch>: the newest release of the branch, majors and prereleases too, only when newer than the current one", () => {
    expect(pick("follow:next")).toBe("2.1.0-beta.1");
    expect(pick("follow:main")).toBe("2.0.0");
    expect(pick("follow:main", "2.0.0")).toBeNull();
    expect(pick("follow:next", "2.1.0-beta.1")).toBeNull();
  });

  it("parses and prints; refuses anything else", () => {
    expect(parsePolicy(" follow:release/x ")).toEqual({ kind: "follow", branch: "release/x" });
    expect(policyText(parsePolicy("minor"))).toBe("minor");
    expect(policyText(parsePolicy("follow:next"))).toBe("follow:next");
    for (const bad of ["", "auto", "follow:", "majors"]) expect(() => parsePolicy(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-policy.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `rollouts/policy.ts`:

```ts
import { appsError } from "../errors.js";
import type { ReleaseRow } from "../releases/repo.js";
import { compareReleases, parseVersion } from "../releases/version.js";

/** Whether new releases roll out to a plan by themselves (spec section 7). */
export type Policy =
  | { kind: "manual" }
  | { kind: "patches" }
  | { kind: "minor" }
  | { kind: "follow"; branch: string };

export function parsePolicy(v: string): Policy {
  const s = v.trim();
  if (s === "manual" || s === "patches" || s === "minor") return { kind: s };
  const m = /^follow:(.+)$/.exec(s);
  if (m && m[1].trim()) return { kind: "follow", branch: m[1].trim() };
  throw appsError(
    "BAD_USER_INPUT",
    `Policy "${v}" is not manual, patches, minor or follow:<branch>`,
  );
}

export const policyText = (p: Policy): string =>
  p.kind === "follow" ? `follow:${p.branch}` : p.kind;

export type PolicyRelease = Pick<ReleaseRow, "version" | "kind" | "branch" | "run" | "withdrawn_at">;

const stable = (v: string) => parseVersion(v)?.prerelease.length === 0;

/**
 * The release a plan's policy rolls out by itself from `current`, or null
 * (decision R13). patches: the highest stable x.y.* above current; minor: the
 * highest stable x.*.* above it (a major never); follow: the newest release
 * (highest run) of the branch when it is newer than current. Never a build or
 * a withdrawn release.
 */
export function policyCandidate(
  p: Policy,
  current: string,
  releases: PolicyRelease[],
): PolicyRelease | null {
  if (p.kind === "manual") return null;
  const usable = releases.filter((r) => r.kind === "release" && !r.withdrawn_at);
  if (p.kind === "follow") {
    const newest = usable
      .filter((r) => r.branch === p.branch)
      .sort((a, b) => Number(b.run) - Number(a.run))[0];
    if (!newest || newest.version === current) return null;
    const cur = releases.find((r) => r.version === current);
    if (cur && Number(cur.run) >= Number(newest.run)) return null;
    return newest;
  }
  const c = parseVersion(current);
  if (!c) return null;
  const fits = usable.filter((r) => {
    const v = parseVersion(r.version);
    if (!v || !stable(r.version) || v.major !== c.major) return false;
    if (p.kind === "patches" && v.minor !== c.minor) return false;
    return compareReleases(r.version, current) > 0;
  });
  fits.sort((a, b) => compareReleases(b.version, a.version));
  return fits[0] ?? null;
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/rollouts/policy.ts subgraphs/vetra-apps/__tests__/rollouts-policy.test.ts && git commit -m "feat(rollouts): plan policies (patches, minor, follow:<branch>)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: Checks, and the rollout test fixtures

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/check.ts`, `subgraphs/vetra-apps/__tests__/rollouts-fixtures.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-check.test.ts`

**Interfaces:**
- Produces (`check.ts`): `LICENCE_GATE_MIN_POWERHOUSE: string | null` (null; slice 5 sets it, D9); `ReleaseRequires`; `requiresOf(r)`; `releaseProblem(version, r: ReleaseRow | null): string | null`; `powerhouseAtLeast(v, min): boolean`; `planFitProblem(r, plan: Pick<PlanRow, "slug" | "size" | "access">, gateMin?): string | null`; `teamGateProblem(deps, appId, version): Promise<string | null>` (always null; slice 6).
- Produces (fixtures, used by Tasks 7-16): `HOLDER_A`, `HOLDER_B`, `RELEASES` (`1.4.0` b/100, `1.4.1` c/110, `1.5.0` d/120, `2.0.0` e/130), `rolloutHarness({ health?, hold? })` → `{ h, appId }` (plans on, health `enforce` by default, App on instances, the four releases), `seedPlan(h, appId, over)`, `readyInstance(h, appId, o)`, `becomeReady(h, id)`, `failUpdate(h, id, reason?)`, `instance(h, id)`, `code(c)`.

- [ ] **Step 1: The fixtures.** Create `__tests__/rollouts-fixtures.ts`:

```ts
import { expect } from "vitest";
import { DEFAULT_INSTANCE_HEALTH } from "../config.js";
import { getInstance, insertInstance, type InstanceRow } from "../instances/repo.js";
import { insertPlan, type PlanRow } from "../plans/repo.js";
import { makeHarness, OWNER, seedActiveApp, testConfig, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";

export const HOLDER_A = "0x1111111111111111111111111111111111111111";
export const HOLDER_B = "0x2222222222222222222222222222222222222222";
/** version, digest letter, run */
export const RELEASES = [
  ["1.4.0", "b", 100],
  ["1.4.1", "c", 110],
  ["1.5.0", "d", 120],
  ["2.0.0", "e", 130],
] as const;

export async function rolloutHarness(
  o: { health?: "enforce" | "report"; hold?: boolean } = {},
): Promise<{ h: Harness; appId: string }> {
  const h = await makeHarness(
    testConfig({
      instances: {
        enabled: true,
        labelSuffix: "",
        health: { ...DEFAULT_INSTANCE_HEALTH, mode: o.health ?? "enforce" },
      },
      plans: { enabled: true, stopAfterDays: 14, ...(o.hold ? { rolloutsHold: true } : {}) },
    }),
  );
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  for (const [version, letter, run] of RELEASES)
    await seedRelease(h, appId, { version, run, kind: "release", digest: digest(letter) });
  return { h, appId };
}

export function seedPlan(
  h: Harness,
  appId: string,
  over: Partial<PlanRow> & Pick<PlanRow, "id" | "slug" | "access">,
): Promise<PlanRow> {
  return insertPlan(h.db, {
    app_id: appId,
    name: over.slug,
    kind: over.slug,
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 0,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    update_window: null,
    policy_note: null,
    ...over,
  });
}

const release = (version: string) => {
  const r = RELEASES.find((x) => x[0] === version);
  if (!r) throw new Error(`no fixture release ${version}`);
  return { digest: digest(r[1]), run: r[2] };
};

/** A plan instance running `version` healthy, as the reconciler leaves it. */
export function readyInstance(
  h: Harness,
  appId: string,
  o: {
    id: string;
    planId: string;
    kind: "shared" | "own";
    version?: string;
    holder?: string;
    createdAt?: string;
  },
): Promise<InstanceRow> {
  const version = o.version ?? "1.4.0";
  const { digest: d, run } = release(version);
  return insertInstance(h.db, {
    id: o.id,
    app_id: appId,
    kind: o.kind,
    name: o.kind === "own" ? `own-${o.id}` : o.planId,
    branch: null,
    pr: null,
    host: `h-${o.id}`,
    environment_id: `env-${o.id}`,
    target_version: version,
    target_digest: d,
    target_repository: "cr.vetra.io/acme/shop",
    target_ph_host: "cli",
    target_run: run,
    running_version: version,
    running_digest: d,
    running_repository: "cr.vetra.io/acme/shop",
    status: "ready",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: o.planId,
    holder_address: o.holder ?? null,
    licence_root_id: o.kind === "own" ? `root-${o.id}` : null,
    created_at: o.createdAt ?? "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
}

/** What the reconciler writes once the instance runs its target healthy (health enforce). */
export const becomeReady = (h: Harness, id: string) =>
  h.db
    .updateTable("instances")
    .set((eb) => ({
      status: "ready",
      reason: null,
      running_version: eb.ref("target_version"),
      running_digest: eb.ref("target_digest"),
    }))
    .where("id", "=", id)
    .execute();

/** What the reconciler writes when the update failed (it also reverted the image to running_*). */
export const failUpdate = (h: Harness, id: string, reason = "unhealthy (crash: exit 1)") =>
  h.db
    .updateTable("instances")
    .set((eb) => ({ status: "failed", reason, failed_digest: eb.ref("target_digest") }))
    .where("id", "=", id)
    .execute();

export const instance = async (h: Harness, id: string) => (await getInstance(h.db, id))!;

export const code = (c: string) => ({ extensions: expect.objectContaining({ code: c }) });
```

- [ ] **Step 2: Write the failing test.** Create `__tests__/rollouts-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  planFitProblem,
  powerhouseAtLeast,
  releaseProblem,
} from "../rollouts/check.js";
import type { ReleaseRow } from "../releases/repo.js";

const rel = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  app_id: "app-1",
  version: "1.5.0",
  kind: "release",
  branch: "main",
  pr: null,
  run: 120,
  commit: "abc",
  notes: null,
  customer_notes: null,
  image_ref: "cr.vetra.io/acme/shop:1.5.0",
  image_digest: `sha256:${"d".repeat(64)}`,
  host: "cli",
  packages: "[]",
  requires: "{}",
  migrates: false,
  powerhouse_version: "6.2.3",
  base_image: "node:24",
  created_at: "2026-11-12T00:00:00.000Z",
  withdrawn_at: null,
  ...over,
});
const pro = { slug: "pro", size: "VETRA_AGENT_M", access: "own" };

describe("rollout checks (spec 7 step 1, 14.3)", () => {
  it("a target is a recorded, unwithdrawn release", () => {
    expect(releaseProblem("9.9.9", null)).toMatch(/no release 9.9.9/);
    expect(releaseProblem("1.5.0-main.3", rel({ kind: "build" }))).toMatch(/build/);
    expect(releaseProblem("1.5.0", rel({ withdrawn_at: "2026-11-12T00:00:00.000Z" }))).toMatch(/withdrawn/);
    expect(releaseProblem("1.5.0", rel())).toBeNull();
  });

  it("requires: no extra services, a size the plan has; the licence gate only for shared plans once set", () => {
    expect(planFitProblem(rel({ requires: '{"services":["DOCLING"]}' }), pro)).toMatch(/DOCLING/);
    expect(planFitProblem(rel({ requires: '{"size":"L"}' }), pro)).toMatch(/size L/);
    expect(planFitProblem(rel({ requires: '{"size":"VETRA_AGENT_M"}' }), pro)).toBeNull();
    expect(planFitProblem(rel({ requires: '{"size":"S","powerhouse":">=6.2.3"}' }), pro)).toBeNull();
    expect(planFitProblem(rel({ requires: '{"size":"huge"}' }), pro)).toMatch(/does not know/);
    expect(
      planFitProblem(rel({ powerhouse_version: "6.2.3" }), { ...pro, access: "shared" }, "6.3.0"),
    ).toMatch(/licence gate/);
    expect(planFitProblem(rel({ powerhouse_version: "6.2.3" }), pro, "6.3.0")).toBeNull();
    expect(powerhouseAtLeast("6.3.0-dev.152", "6.3.0")).toBe(true);
    expect(powerhouseAtLeast("6.2.9", "6.3.0")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-check.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement.** Create `rollouts/check.ts`:

```ts
import type { PlanRow } from "../plans/repo.js";
import { PLAN_SIZES } from "../plans/rules.js";
import type { ReleaseRow } from "../releases/repo.js";
import type { AppsDeps } from "../service.js";

/**
 * Slice 5 (D9): the first Powerhouse release with the licence gate. Shared
 * plans refuse releases built on an older one. Null until that release exists.
 */
export const LICENCE_GATE_MIN_POWERHOUSE: string | null = null;

export interface ReleaseRequires {
  powerhouse?: string;
  services?: string[];
  size?: string;
}

export function requiresOf(r: Pick<ReleaseRow, "requires">): ReleaseRequires {
  try {
    return (JSON.parse(r.requires) as ReleaseRequires | null) ?? {};
  } catch {
    return {};
  }
}

/** Why `version` cannot be a plan's target (spec section 2, 14.3), or null. */
export function releaseProblem(version: string, r: ReleaseRow | null): string | null {
  if (!r) return `the App has no release ${version}`;
  if (r.kind !== "release") return `${version} is a build; plans run releases only`;
  if (r.withdrawn_at) return `${version} was withdrawn`;
  return null;
}

const sizeRank = (s: string): number =>
  PLAN_SIZES.findIndex(
    (p) => p === `VETRA_AGENT_${s.trim().toUpperCase().replace(/^VETRA_AGENT_/, "")}`,
  );

const core = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** major.minor.patch order only: Powerhouse dev builds (6.3.0-dev.152) count as their core. */
export function powerhouseAtLeast(v: string, min: string): boolean {
  const a = core(v);
  const b = core(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Why the release cannot run on the plan's instances (decision R14), or null. */
export function planFitProblem(
  r: ReleaseRow,
  plan: Pick<PlanRow, "slug" | "size" | "access">,
  gateMin: string | null = LICENCE_GATE_MIN_POWERHOUSE,
): string | null {
  const req = requiresOf(r);
  const services = req.services ?? [];
  if (services.length > 0)
    return `${r.version} needs ${services.join(", ")}; plan instances run the App's host only`;
  if (req.size) {
    const need = sizeRank(req.size);
    if (need === -1) return `${r.version} needs size ${req.size}, which Vetra does not know`;
    if (need > sizeRank(plan.size))
      return `${r.version} needs size ${req.size}; ${plan.slug} runs ${plan.size}`;
  }
  if (plan.access === "shared" && gateMin && !powerhouseAtLeast(r.powerhouse_version, gateMin))
    return `${r.version} is built on Powerhouse ${r.powerhouse_version}; shared plans need ${gateMin} or newer (the licence gate)`;
  return null;
}

/**
 * Slice 6 hook (spec 7 step 1): when the App has a Team plan, a customer
 * rollout needs the release to have run healthy on the Team instance.
 */
export async function teamGateProblem(
  _deps: AppsDeps,
  _appId: string,
  _version: string,
): Promise<string | null> {
  return null;
}
```

- [ ] **Step 5: Run it again.** Same command. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts/check.ts subgraphs/vetra-apps/__tests__/rollouts-check.test.ts subgraphs/vetra-apps/__tests__/rollouts-fixtures.ts && git commit -m "feat(rollouts): release and plan-fit checks; rollout test fixtures" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---
### Task 6: Plan settings for rollouts (policy, notice, window); withdrawn targets refused

**Files:**
- Modify: `subgraphs/vetra-apps/plans/rules.ts`, `subgraphs/vetra-apps/plans/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/plans-api.test.ts`

**Interfaces:**
- Consumes: `checkWindow`, `parseWindow`, `UpdateWindow` (Task 3); `parsePolicy`, `policyText` (Task 4); `releaseProblem` (Task 5).
- Produces (`rules.ts`): `MAX_NOTICE_HOURS = 720`, `checkNoticeHours(n: number): number`.
- Produces (`service.ts`): `UpdatePlanInput` gains `policy?`, `noticeHours?`, `updateWindow?: UpdateWindow | null`, `clearUpdateWindow?: boolean | null`; `PlanJson` gains `updateWindow: UpdateWindow | null`, `policyNote: string | null`; `checkTarget` refuses withdrawn releases. `plan.updated` audits `policy`, `noticeHours`, `updateWindow` changes. A policy change clears `policy_note`.

- [ ] **Step 1: Write the failing test.** In `plans-api.test.ts` add `import { listAudit } from "../audit/repo.js";` and append inside `describe("plans API", …)`:

```ts
  it("sets a plan's policy, notice and update window, audited; refuses bad ones", async () => {
    const p = await createPlan(h.deps, owner, { appId, kind: "pro", access: "own" });
    const w = { days: [6, 7], start: "22:00", end: "06:00", timeZone: "Europe/Berlin" };
    expect(
      await updatePlanFor(h.deps, owner, {
        planId: p.id,
        policy: "patches",
        noticeHours: 24,
        updateWindow: w,
      }),
    ).toMatchObject({ policy: "patches", noticeHours: 24, updateWindow: w, policyNote: null });
    expect(
      (await updatePlanFor(h.deps, owner, { planId: p.id, clearUpdateWindow: true })).updateWindow,
    ).toBeNull();
    await expect(
      updatePlanFor(h.deps, owner, { planId: p.id, policy: "follow:feature-x" }),
    ).rejects.toThrow(/not a release branch/);
    expect(
      (await updatePlanFor(h.deps, owner, { planId: p.id, policy: "follow:main" })).policy,
    ).toBe("follow:main");
    await expect(
      updatePlanFor(h.deps, owner, { planId: p.id, noticeHours: 721 }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(
      updatePlanFor(h.deps, owner, {
        planId: p.id,
        updateWindow: { ...w, timeZone: "Nowhere/Land" },
      }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    const updates = (await listAudit(h.db, appId, { limit: 50 })).filter(
      (r) => r.action === "plan.updated",
    );
    expect(JSON.parse(updates.at(-1)!.detail).changes).toMatchObject({
      policy: { from: "manual", to: "patches" },
      noticeHours: { from: 72, to: 24 },
    });
  });

  it("refuses a withdrawn release as a target", async () => {
    await h.db
      .updateTable("releases")
      .set({ withdrawn_at: "2026-10-02T00:00:00.000Z" })
      .where("app_id", "=", appId)
      .where("version", "=", "1.4.0")
      .execute();
    await expect(
      createPlan(h.deps, owner, { appId, kind: "pro", access: "own", targetVersion: "1.4.0" }),
    ).rejects.toThrow(/withdrawn/);
  });
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/plans-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (unknown input fields; withdrawn accepted).
- [ ] **Step 3: Rules.** In `plans/rules.ts` append:

```ts
/** The longest notice a plan or rollout gives (30 days, as licensing's MAX_NOTICE_HOURS). */
export const MAX_NOTICE_HOURS = 24 * 30;

export function checkNoticeHours(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > MAX_NOTICE_HOURS)
    throw appsError(
      "BAD_USER_INPUT",
      `Notice is a whole number of hours from 0 to ${MAX_NOTICE_HOURS}`,
    );
  return n;
}
```

- [ ] **Step 4: Service.** In `plans/service.ts`:
  - imports: `checkNoticeHours` from `./rules.js`; `checkWindow, parseWindow, type UpdateWindow` from `../rollouts/window.js`; `parsePolicy, policyText` from `../rollouts/policy.js`; `releaseProblem` from `../rollouts/check.js`; `isReleaseBranch, parseReleaseBranches` from `../releases/branches.js`.
  - `PlanJson` gains `updateWindow: UpdateWindow | null; policyNote: string | null;` and `planJson` sets `updateWindow: parseWindow(p.update_window), policyNote: p.policy_note ?? null`.
  - `UpdatePlanInput` becomes:

```ts
export interface UpdatePlanInput {
  planId: string;
  name?: string | null;
  size?: string | null;
  /** manual | patches | minor | follow:<branch> (a release branch of the App). */
  policy?: string | null;
  /** Hours between a rollout's start and the plan's updates (0-720). */
  noticeHours?: number | null;
  /** When the plan's instances may be updated (spec 14.8). */
  updateWindow?: UpdateWindow | null;
  /** Removes the window: updates any time after the notice. */
  clearUpdateWindow?: boolean | null;
}
```

  - `checkTarget` becomes:

```ts
/** A plan's target is a recorded, unwithdrawn release of its App (spec section 2, 14.3). */
async function checkTarget(deps: AppsDeps, appId: string, version: string): Promise<string> {
  const r = await releaseByVersion(deps.db, appId, version);
  const problem = releaseProblem(version, r);
  if (problem)
    throw appsError("BAD_USER_INPUT", problem.charAt(0).toUpperCase() + problem.slice(1));
  return r!.version;
}
```

  - `updatePlanFor` becomes:

```ts
export async function updatePlanFor(
  deps: AppsDeps,
  caller: Caller,
  input: UpdatePlanInput,
): Promise<PlanJson> {
  const { plan, app } = await loadPlan(deps, caller, input.planId);
  const name = input.name == null ? undefined : input.name.trim();
  if (name === "") throw appsError("BAD_USER_INPUT", "A plan's name cannot be blank");
  if (name !== undefined) checkText("name", name);
  const policy = input.policy == null ? undefined : policyText(parsePolicy(input.policy));
  if (policy?.startsWith("follow:")) {
    const branch = policy.slice("follow:".length);
    if (!isReleaseBranch(branch, app.production_branch, parseReleaseBranches(app.release_branches)))
      throw appsError("BAD_USER_INPUT", `${branch} is not a release branch of the App`);
  }
  if (input.updateWindow && input.clearUpdateWindow)
    throw appsError("BAD_USER_INPUT", "Give an update window or clear it, not both");
  const window = input.clearUpdateWindow
    ? null
    : input.updateWindow
      ? JSON.stringify(checkWindow(input.updateWindow))
      : undefined;
  const patch = {
    ...(name ? { name } : {}),
    ...(input.size ? { size: parseSize(input.size) } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(input.noticeHours != null ? { notice_hours: checkNoticeHours(input.noticeHours) } : {}),
    ...(window !== undefined ? { update_window: window } : {}),
  };
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      // Re-read under lock: a concurrent change is audited once, from what is stored.
      const cur = await lockPlan(trx, plan.id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const note = (key: string, from: unknown, to: unknown) => {
        if (to !== undefined && to !== from) changes[key] = { from, to };
      };
      note("name", cur.name, patch.name);
      note("size", cur.size, patch.size);
      note("policy", cur.policy, patch.policy);
      note("noticeHours", cur.notice_hours, patch.notice_hours);
      note("updateWindow", cur.update_window ?? null, patch.update_window);
      const p = await updatePlan(
        trx,
        plan.id,
        // A new policy starts over: its last refusal no longer applies.
        changes.policy ? { ...patch, policy_note: null } : patch,
        nowIso,
      );
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
}
```

  (`updateWindow` audits the JSON text, from and to.)
- [ ] **Step 5: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/plans-audit.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/plans subgraphs/vetra-apps/__tests__/plans-api.test.ts && git commit -m "feat(plans): policy, notice and update window per plan; withdrawn releases are no target" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: Plan sync no longer moves existing targets

**Files:**
- Modify: `subgraphs/vetra-apps/plans/sync.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-plans.test.ts`

**Interfaces:**
- Changes: `syncPlanInstances` gives a **new** row the plan's target (as before) and never writes `target_*` of an existing shared or own row (decision R3). Everything else (size, holder, plan, stop reasons) is unchanged.

- [ ] **Step 1: Change the test.** In `instances-plans.test.ts` replace the test "follows a new plan target" with:

```ts
  it("keeps an existing row's target when the plan's moves; a new chain starts on the new target (slice 3: rollouts move rows)", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await sync();
    await seedRelease(h, appId, {
      version: "1.4.1",
      run: 110,
      kind: "release",
      digest: digest("c"),
    });
    await updatePlan(h.db, "plan-own", { target_version: "1.4.1" }, "2026-10-04T00:00:00.000Z");
    await sync();
    expect((await rows())[0]).toMatchObject({
      licence_root_id: "l1",
      target_version: "1.4.0",
      target_digest: digest("b"),
    });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: "0x3333333333333333333333333333333333333333",
      licenseId: "l3",
    });
    await sync();
    expect((await rows()).find((r) => r.licence_root_id === "l3")).toMatchObject({
      target_version: "1.4.1",
      target_digest: digest("c"),
    });
  });

  it("keeps a shared row's target when the plan's moves", async () => {
    await plan({ id: "plan-shared", slug: "starter", kind: "starter", access: "shared" });
    await sync();
    await seedRelease(h, appId, { version: "1.4.1", run: 110, kind: "release", digest: digest("c") });
    await updatePlan(h.db, "plan-shared", { target_version: "1.4.1" }, "2026-10-04T00:00:00.000Z");
    await sync();
    expect((await rows())[0]).toMatchObject({ kind: "shared", target_version: "1.4.0" });
  });
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (rows follow the plan).
- [ ] **Step 3: Implement.** In `plans/sync.ts`:
  - shared rows: replace `await patch(row, { ...(target ?? {}), target_size: plan.size, stop_reason: wanted ? null : PLAN_RETIRED });` with `await patch(row, { target_size: plan.size, stop_reason: wanted ? null : PLAN_RETIRED });`;
  - own rows: drop `...(target ?? {}),` from the patch of an existing row (keep `plan_id`, `holder_address`, `target_size`, `licence_ended_at: null`, `stop_reason: null`);
  - in the doc comment of `syncPlanInstances`, after "one own row per live licence chain of an own plan", add: "A new row starts on its plan's target; an existing row's target moves only through rollouts (rollouts/runner.ts) and pins (releases phase 3 slice 3)."
  - `targets` stays (new rows need it).
- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/plans-holder-view.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS. If another test in `instances-plans.test.ts` relied on rows following the plan, change its expectation to the row's original target and say so in the commit body.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/sync.ts subgraphs/vetra-apps/__tests__/instances-plans.test.ts && git commit -m "feat(plans): existing plan instances keep their target; rollouts move them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Starting a rollout (check, steps, plan targets); `setPlanTarget` starts one

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/service.ts`
- Modify: `subgraphs/vetra-apps/plans/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-start.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6; `listInstances`, `getPlan`, `lockPlan`, `updatePlan`, `releaseByVersion`, `compareReleases`, `loadAppForOwner`, `recordAudit`, `instanceHealth`, `rolloutsEnabled`, `withKeyLock`.
- Produces (`rollouts/service.ts`):
  - `RolloutActor { actor: string; source: "console" | "api" | "policy" }`, `callerActor(caller)`, `auditAs(db, who, entry)`;
  - `PlannedStep { plan; instance; status: "pending" | "skipped"; note }`, `plannedSteps(deps, appId, plans, version)`;
  - `rolloutProblems(deps, app, version, plans, steps): Promise<string[]>`;
  - `beginRollout(deps, app, version, plans, who: RolloutActor, noticeHours: number | null): Promise<RolloutRow>` — no access check; the caller holds `appInstancesLock(app.id)`; throws BAD_USER_INPUT `Cannot roll out <v>: <problems joined by "; ">`;
  - `StartRolloutInput { appId; version; planIds: string[]; noticeHours?: number | null }`, `startRollout(deps, caller, input): Promise<RolloutJson>`;
  - `RolloutJson`, `RolloutStepJson`, `rolloutJson(db, row)`;
  - `RolloutCheckJson { version; ok; problems; steps: StepPreviewJson[] }`, `checkRolloutFor(deps, caller, appId, version, planIds)`;
  - `appRolloutsFor(deps, caller, appId, limit)`, `rolloutFor(deps, caller, id): Promise<RolloutJson | null>`;
  - `loadRollout(deps, caller, rolloutId, need)`.
- Changes: `setPlanTarget` = `beginRollout` of one plan under the lock; a no-op when the plan already targets the version and no instance is behind.

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-start.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger, type Harness } from "./harness.js";
import {
  code,
  HOLDER_A,
  HOLDER_B,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getPlan } from "../plans/repo.js";
import { setPlanTarget } from "../plans/service.js";
import { stepsOf } from "../rollouts/repo.js";
import { checkRolloutFor, startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-starter", slug: "starter", access: "shared", notice_hours: 72 });
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own", notice_hours: 72 });
  await readyInstance(h, appId, { id: "s1", planId: "p-starter", kind: "shared" });
  await readyInstance(h, appId, { id: "o2", planId: "p-pro", kind: "own", holder: HOLDER_B, createdAt: "2026-10-01T00:00:02.000Z" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A, createdAt: "2026-10-01T00:00:01.000Z" });
  await readyInstance(h, appId, { id: "o3", planId: "p-pro", kind: "own", createdAt: "2026-10-01T00:00:03.000Z" });
  await h.db.updateTable("instances").set({ pinned_version: "1.4.0" }).where("id", "=", "o3").execute();
});
afterEach(async () => {
  await h.close();
});

describe("starting a rollout (spec 7 steps 1 and 3)", () => {
  it("plans steps shared first, then own by age, skips pinned ones with a note, moves the plans' targets, never an instance's", async () => {
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro", "p-starter"],
      noticeHours: 2,
    });
    expect(r).toMatchObject({ version: "1.4.1", status: "active", direction: "forward", source: "api", startedBy: owner.address });
    const steps = await stepsOf(h.db, r.id);
    expect(steps.map((s) => [s.instance_id, s.status, s.note])).toEqual([
      ["s1", "pending", null],
      ["o1", "pending", null],
      ["o2", "pending", null],
      ["o3", "skipped", "pinned at 1.4.0"],
    ]);
    expect(Date.parse(steps[0].due_at) - Date.parse(r.startedAt)).toBe(2 * 3_600_000);
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.1");
    expect((await getPlan(h.db, "p-starter"))?.target_version).toBe("1.4.1");
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    const actions = (await listAudit(h.db, appId, { limit: 20 })).map((a) => a.action);
    expect(actions.filter((a) => a === "plan.target_set")).toHaveLength(2);
    expect(actions).toContain("rollout.started");
  });

  it("refuses before anything moves: builds, unknown and withdrawn releases, sizes, older versions, a plan in an open rollout, retired plans, strangers", async () => {
    const start = (version: string, planIds = ["p-pro"]) =>
      startRollout(h.deps, owner, { appId, version, planIds });
    await expect(start("9.9.9")).rejects.toThrow(/no release 9.9.9/);
    await h.db.updateTable("releases").set({ withdrawn_at: "2026-10-02T00:00:00.000Z" }).where("version", "=", "2.0.0").execute();
    await expect(start("2.0.0")).rejects.toThrow(/withdrawn/);
    await h.db.updateTable("releases").set({ requires: '{"size":"XL"}' }).where("version", "=", "1.5.0").execute();
    await expect(start("1.5.0")).rejects.toThrow(/needs size XL/);
    await h.db.updateTable("plans").set({ target_version: "1.4.1" }).where("id", "=", "p-pro").execute();
    await expect(start("1.4.0")).rejects.toThrow(/older than pro's target/);
    await h.db.updateTable("plans").set({ target_version: "1.4.0" }).where("id", "=", "p-pro").execute();
    await start("1.4.1");
    await expect(start("1.4.1")).rejects.toThrow(/in the rollout of 1.4.1/);
    await h.db.updateTable("plans").set({ status: "retired" }).where("id", "=", "p-starter").execute();
    await expect(start("1.4.1", ["p-starter"])).rejects.toThrow(/retired/);
    await expect(
      startRollout(h.deps, stranger, { appId, version: "1.4.1", planIds: ["p-pro"] }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(start("1.4.1", ["nope"])).rejects.toMatchObject(code("NOT_FOUND"));
  });

  it("needs health enforce to move instances", async () => {
    h.deps.cfg.instances.health = { ...h.deps.cfg.instances.health!, mode: "report" };
    await expect(
      startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"] }),
    ).rejects.toThrow(/enforce/);
  });

  it("previews steps and problems without writing", async () => {
    const c = await checkRolloutFor(h.deps, owner, appId, "1.4.1", ["p-starter", "p-pro"]);
    expect(c.ok).toBe(true);
    expect(c.steps.map((s) => [s.instanceId, s.status])).toEqual([
      ["s1", "pending"],
      ["o1", "pending"],
      ["o2", "pending"],
      ["o3", "skipped"],
    ]);
    const bad = await checkRolloutFor(h.deps, owner, appId, "9.9.9", ["p-pro"]);
    expect(bad).toMatchObject({ ok: false, problems: [expect.stringMatching(/no release/)] });
    expect(await stepsOf(h.db, "any")).toEqual([]);
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.0");
  });

  it("setPlanTarget starts a rollout of one plan, and does nothing when nothing is behind", async () => {
    const p = await setPlanTarget(h.deps, owner, "p-pro", "1.4.1");
    expect(p.targetVersion).toBe("1.4.1");
    const started = (await listAudit(h.db, appId, { limit: 20 })).filter((a) => a.action === "rollout.started");
    expect(started).toHaveLength(1);
    expect(JSON.parse(started[0].detail)).toMatchObject({ version: "1.4.1", plans: ["pro"] });
    await h.db.updateTable("instances").set({ target_version: "1.4.1" }).where("plan_id", "=", "p-pro").execute();
    await h.db.updateTable("rollouts").set({ status: "complete" }).execute();
    await setPlanTarget(h.deps, owner, "p-pro", "1.4.1");
    expect(
      (await listAudit(h.db, appId, { limit: 20 })).filter((a) => a.action === "rollout.started"),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-start.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Create `rollouts/service.ts`:

```ts
import type { Kysely } from "kysely";
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { recordAudit, type AuditEntry } from "../audit/repo.js";
import { instanceHealth, rolloutsEnabled } from "../config.js";
import type { VetraAppsDB } from "../db/schema.js";
import { appsError } from "../errors.js";
import { listInstances, type InstanceRow } from "../instances/repo.js";
import { getPlan, lockPlan, updatePlan, type PlanRow } from "../plans/repo.js";
import { checkNoticeHours } from "../plans/rules.js";
import { releaseByVersion } from "../releases/repo.js";
import { compareReleases } from "../releases/version.js";
import type { AppRow } from "../repo.js";
import type { AppNeed } from "../roles/access.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { planFitProblem, releaseProblem, teamGateProblem } from "./check.js";
import {
  appInstancesLock,
  getRollout,
  insertRollout,
  insertRolloutPlans,
  insertSteps,
  listRollouts,
  openRolloutOfPlan,
  rolloutPlans,
  stepsOf,
  type RolloutRow,
  type RolloutStepRow,
} from "./repo.js";

const HOUR_MS = 3_600_000;

/** Who starts or changes a rollout, and from where. */
export interface RolloutActor {
  actor: string;
  source: "console" | "api" | "policy";
}
export const callerActor = (c: Caller): RolloutActor => ({
  actor: c.address,
  source: c.source ?? "api",
});

/** An audit row written as `who`. Pass the transaction of the change. */
export const auditAs = (
  db: Kysely<VetraAppsDB>,
  who: RolloutActor | { actor: string; source: "system" },
  e: Omit<AuditEntry, "actor" | "source">,
) => recordAudit(db, { ...e, actor: who.actor, source: who.source });

export interface RolloutStepJson {
  id: string;
  instanceId: string;
  instanceName: string;
  instanceKind: string;
  planId: string;
  position: number;
  fromVersion: string | null;
  toVersion: string;
  status: string;
  dueAt: string;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  error: string | null;
  note: string | null;
}

export interface RolloutJson {
  id: string;
  appId: string;
  version: string;
  status: string;
  direction: string;
  source: string;
  startedBy: string;
  startedAt: string;
  notes: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
  finishedAt: string | null;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  plans: { planId: string; fromVersion: string | null; noticeHours: number }[];
  steps: RolloutStepJson[];
}

export const stepJson = (s: RolloutStepRow): RolloutStepJson => ({
  id: s.id,
  instanceId: s.instance_id,
  instanceName: s.instance_name,
  instanceKind: s.instance_kind,
  planId: s.plan_id,
  position: s.position,
  fromVersion: s.from_version,
  toVersion: s.to_version,
  status: s.status,
  dueAt: s.due_at,
  requestedAt: s.requested_at,
  startedAt: s.started_at,
  finishedAt: s.finished_at,
  attempts: s.attempts,
  error: s.error,
  note: s.note,
});

export async function rolloutJson(
  db: Kysely<VetraAppsDB>,
  r: RolloutRow,
): Promise<RolloutJson> {
  const [plans, steps] = await Promise.all([rolloutPlans(db, r.id), stepsOf(db, r.id)]);
  return {
    id: r.id,
    appId: r.app_id,
    version: r.version,
    status: r.status,
    direction: r.direction,
    source: r.source,
    startedBy: r.started_by,
    startedAt: r.started_at,
    notes: r.notes,
    pausedAt: r.paused_at,
    pausedReason: r.paused_reason,
    finishedAt: r.finished_at,
    rolledBackBy: r.rolled_back_by,
    rolledBackAt: r.rolled_back_at,
    plans: plans.map((p) => ({
      planId: p.plan_id,
      fromVersion: p.from_version,
      noticeHours: p.notice_hours,
    })),
    steps: steps.map(stepJson),
  };
}

export interface PlannedStep {
  plan: PlanRow;
  instance: InstanceRow;
  status: "pending" | "skipped";
  note: string | null;
}

/**
 * The plans' live instances not already targeting `version`, in the order
 * they move: shared first, then own, each by plan order then age (spec 7
 * step 4). A pinned one is planned as skipped (spec section 7, pinning).
 */
export async function plannedSteps(
  deps: AppsDeps,
  appId: string,
  plans: PlanRow[],
  version: string,
): Promise<PlannedStep[]> {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const rows = (await listInstances(deps.db, appId)).filter(
    (r) =>
      (r.kind === "shared" || r.kind === "own") &&
      !!r.plan_id &&
      byId.has(r.plan_id) &&
      !r.removed_at &&
      r.status !== "removed" &&
      r.target_version !== version,
  );
  const out: PlannedStep[] = rows.map((r) => ({
    plan: byId.get(r.plan_id!)!,
    instance: r,
    status: r.pinned_version ? "skipped" : "pending",
    note: r.pinned_version ? `pinned at ${r.pinned_version}` : null,
  }));
  const rank = (s: PlannedStep) => (s.instance.kind === "shared" ? 0 : 1);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      plans.indexOf(a.plan) - plans.indexOf(b.plan) ||
      a.instance.created_at.localeCompare(b.instance.created_at) ||
      a.instance.id.localeCompare(b.instance.id),
  );
}

/** Every reason the rollout cannot start (spec 7 step 1); empty when it can. */
export async function rolloutProblems(
  deps: AppsDeps,
  app: AppRow,
  version: string,
  plans: PlanRow[],
  steps: PlannedStep[],
): Promise<string[]> {
  const release = await releaseByVersion(deps.db, app.id, version);
  const bad = releaseProblem(version, release);
  if (bad) return [bad];
  const out: string[] = [];
  for (const p of plans) {
    if (p.status === "retired") out.push(`${p.slug} is retired`);
    const fit = planFitProblem(release!, p);
    if (fit) out.push(fit);
    if (
      p.target_version &&
      p.target_version !== version &&
      compareReleases(version, p.target_version) < 0
    )
      out.push(
        `${version} is older than ${p.slug}'s target ${p.target_version}; roll back that rollout instead`,
      );
    const open = await openRolloutOfPlan(deps.db, p.id);
    if (open)
      out.push(
        `${p.slug} is in the rollout of ${open.version} (${open.status}); finish, cancel or roll it back first`,
      );
  }
  const team = await teamGateProblem(deps, app.id, version);
  if (team) out.push(team);
  if (
    steps.some((s) => s.status === "pending") &&
    instanceHealth(deps.cfg).mode !== "enforce"
  )
    out.push("rollouts need instance health in enforce mode (VETRA_APPS_INSTANCE_HEALTH=enforce)");
  if (steps.length === 0 && plans.every((p) => p.target_version === version))
    out.push(`${plans.map((p) => p.slug).join(", ")} already run ${version}`);
  return out;
}

/**
 * Starts a rollout. No access check: the caller checked it, and holds
 * appInstancesLock(app.id) (never taken again here). The plans' targets move
 * now (new instances start on the release, decision R3); instances move one
 * at a time through the runner.
 */
export async function beginRollout(
  deps: AppsDeps,
  app: AppRow,
  version: string,
  plans: PlanRow[],
  who: RolloutActor,
  noticeHours: number | null,
): Promise<RolloutRow> {
  const steps = await plannedSteps(deps, app.id, plans, version);
  const problems = await rolloutProblems(deps, app, version, plans, steps);
  if (problems.length > 0)
    throw appsError("BAD_USER_INPUT", `Cannot roll out ${version}: ${problems.join("; ")}`);
  const release = (await releaseByVersion(deps.db, app.id, version))!;
  const now = deps.now();
  const nowIso = now.toISOString();
  const id = deps.newId();
  const hours = new Map(plans.map((p) => [p.id, noticeHours ?? p.notice_hours]));
  const moving = steps.some((s) => s.status === "pending");
  return deps.db.transaction().execute(async (trx) => {
    const rollout = await insertRollout(trx, {
      id,
      app_id: app.id,
      version,
      status: moving ? "active" : "complete",
      direction: "forward",
      source: who.source,
      started_by: who.actor,
      started_at: nowIso,
      notes: release.customer_notes ?? release.notes,
      paused_at: null,
      paused_reason: null,
      finished_at: moving ? null : nowIso,
      rolled_back_by: null,
      rolled_back_at: null,
      updated_at: nowIso,
    });
    await insertRolloutPlans(
      trx,
      plans.map((p) => ({
        rollout_id: id,
        plan_id: p.id,
        from_version: p.target_version,
        notice_hours: hours.get(p.id)!,
      })),
    );
    await insertSteps(
      trx,
      steps.map((s, position) => ({
        id: deps.newId(),
        rollout_id: id,
        app_id: app.id,
        plan_id: s.plan.id,
        instance_id: s.instance.id,
        instance_kind: s.instance.kind as "shared" | "own",
        instance_name: s.instance.name,
        position,
        from_version: s.instance.target_version,
        to_version: version,
        status: s.status,
        due_at: new Date(now.getTime() + hours.get(s.plan.id)! * HOUR_MS).toISOString(),
        requested_at: null,
        started_at: null,
        finished_at: s.status === "skipped" ? nowIso : null,
        target_moved: false,
        attempts: 0,
        error: null,
        note: s.note,
        created_at: nowIso,
        updated_at: nowIso,
      })),
    );
    for (const p of plans) {
      const cur = await lockPlan(trx, p.id);
      if (cur.target_version === version) continue;
      await updatePlan(trx, p.id, { target_version: version }, nowIso);
      await auditAs(trx, who, {
        appId: app.id,
        at: nowIso,
        action: "plan.target_set",
        subject: `plan:${p.id}`,
        detail: { slug: p.slug, from: cur.target_version, to: version, rolloutId: id },
      });
    }
    await auditAs(trx, who, {
      appId: app.id,
      at: nowIso,
      action: "rollout.started",
      subject: `rollout:${id}`,
      detail: {
        version,
        plans: plans.map((p) => p.slug),
        steps: steps.filter((s) => s.status === "pending").length,
        skipped: steps.filter((s) => s.status === "skipped").length,
        noticeHours: plans.map((p) => hours.get(p.id)),
      },
    });
    return rollout;
  });
}

async function plansOf(deps: AppsDeps, app: AppRow, ids: string[]): Promise<PlanRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw appsError("BAD_USER_INPUT", "Name at least one plan");
  const out: PlanRow[] = [];
  for (const id of unique) {
    const p = await getPlan(deps.db, id);
    if (!p || p.app_id !== app.id) throw appsError("NOT_FOUND", `Plan ${id} not found`);
    out.push(p);
  }
  return out;
}

export interface StartRolloutInput {
  appId: string;
  version: string;
  planIds: string[];
  /** Hours before the plans' instances are updated; default each plan's notice. */
  noticeHours?: number | null;
}

export async function startRollout(
  deps: AppsDeps,
  caller: Caller,
  input: StartRolloutInput,
): Promise<RolloutJson> {
  if (!rolloutsEnabled(deps.cfg))
    throw appsError("BAD_USER_INPUT", "Plans and rollouts are not enabled on this Vetra");
  const app = await loadAppForOwner(deps, caller, input.appId, { need: "release" });
  const notice = input.noticeHours == null ? null : checkNoticeHours(input.noticeHours);
  const ids = (await plansOf(deps, app, input.planIds)).map((p) => p.id);
  return withKeyLock(appInstancesLock(app.id), async () => {
    // Read under the lock: another start may have moved them.
    const plans = await plansOf(deps, app, ids);
    const row = await beginRollout(
      deps,
      app,
      input.version.trim(),
      plans,
      callerActor(caller),
      notice,
    );
    return rolloutJson(deps.db, row);
  });
}

export interface StepPreviewJson {
  instanceId: string;
  instanceName: string;
  instanceKind: string;
  planId: string;
  fromVersion: string | null;
  status: string;
  note: string | null;
  dueAt: string;
}

export interface RolloutCheckJson {
  version: string;
  ok: boolean;
  problems: string[];
  steps: StepPreviewJson[];
}

/** What startRollout would do, without doing it (the console's "Roll out" dialog). */
export async function checkRolloutFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  version: string,
  planIds: string[],
): Promise<RolloutCheckJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const plans = await plansOf(deps, app, planIds);
  const v = version.trim();
  const steps = await plannedSteps(deps, app.id, plans, v);
  const problems = await rolloutProblems(deps, app, v, plans, steps);
  const now = deps.now().getTime();
  return {
    version: v,
    ok: problems.length === 0,
    problems,
    steps: steps.map((s) => ({
      instanceId: s.instance.id,
      instanceName: s.instance.name,
      instanceKind: s.instance.kind,
      planId: s.plan.id,
      fromVersion: s.instance.target_version,
      status: s.status,
      note: s.note,
      dueAt: new Date(now + s.plan.notice_hours * HOUR_MS).toISOString(),
    })),
  };
}

/** The rollout and its App, checked for `need` (NOT_FOUND / FORBIDDEN as for the App). */
export async function loadRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
  need: AppNeed,
): Promise<{ r: RolloutRow; app: AppRow }> {
  const r = await getRollout(deps.db, rolloutId);
  if (!r) throw appsError("NOT_FOUND", "Rollout not found");
  const app = await loadAppForOwner(deps, caller, r.app_id, { need });
  return { r, app };
}

export async function appRolloutsFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  limit: number | null | undefined,
): Promise<RolloutJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const rows = await listRollouts(deps.db, app.id, Math.min(Math.max(limit ?? 20, 1), 100));
  return Promise.all(rows.map((r) => rolloutJson(deps.db, r)));
}

export async function rolloutFor(
  deps: AppsDeps,
  caller: Caller,
  id: string,
): Promise<RolloutJson | null> {
  if (!(await getRollout(deps.db, id))) return null;
  const { r } = await loadRollout(deps, caller, id, "view");
  return rolloutJson(deps.db, r);
}
```

- [ ] **Step 4: `setPlanTarget`.** In `plans/service.ts` import `withKeyLock` from `../../../shared/key-lock.js`, `appInstancesLock` from `../rollouts/repo.js`, `beginRollout, callerActor, plannedSteps` from `../rollouts/service.js`, and replace `setPlanTarget` with:

```ts
/**
 * Starts a rollout of this one plan to `version` (spec section 7), with the
 * plan's notice. A no-op when the plan already targets it and no instance is
 * behind. Its instances move one at a time through the rollout runner.
 */
export async function setPlanTarget(
  deps: AppsDeps,
  caller: Caller,
  planId: string,
  version: string,
): Promise<PlanJson> {
  const { plan, app } = await loadPlan(deps, caller, planId);
  if (plan.status === "retired") throw appsError("BAD_USER_INPUT", "The plan is retired");
  const target = await checkTarget(deps, plan.app_id, version);
  await withKeyLock(appInstancesLock(app.id), async () => {
    const cur = (await getPlan(deps.db, plan.id))!;
    if (cur.status === "retired") throw appsError("BAD_USER_INPUT", "The plan is retired");
    if (
      cur.target_version === target &&
      (await plannedSteps(deps, app.id, [cur], target)).length === 0
    )
      return;
    await beginRollout(deps, app, target, [cur], callerActor(caller), null);
  });
  return planJson((await getPlan(deps.db, plan.id))!);
}
```

  Update its schema description in Task 16. Keep the `plan.target_set` audit (now written by `beginRollout`, with `rolloutId`).
- [ ] **Step 5: Run it again.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-start.test.ts subgraphs/vetra-apps/__tests__/plans-api.test.ts subgraphs/vetra-apps/__tests__/plans-audit.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS (the slice 2 plan tests run on plans without instances, so their rollouts complete at once and audit `plan.target_set` once).
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts/service.ts subgraphs/vetra-apps/plans/service.ts subgraphs/vetra-apps/__tests__/rollouts-start.test.ts && git commit -m "feat(rollouts): start a rollout (check, steps, plan targets); setPlanTarget starts one" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: The runner (one instance at a time, health-gated, pause on failure)

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/runner.ts`
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts`

**Interfaces:**
- Consumes: Tasks 2-8; `getInstance`, `updateInstance`, `targetOf`, `releaseByVersion`, `UPDATE_TIMEOUT_MS`, `rolloutsEnabled`, `rolloutsHeld`, `recordAudit`, `AUDIT_SYSTEM_ACTOR`.
- Produces: `STEP_TIMEOUT_MS`, `STOPPED_NOTE`, `REMOVED_NOTE`, `advanceRollouts(deps, app)`, `pointInstanceAt(db, appId, instanceId, version, nowIso)`, `stepEntry(step, to, at, more?, who?)`, `SYSTEM`.
- Changes: `reconcileApp` calls `advanceRollouts` after `syncPlanInstances` (own try/catch), before listing rows.

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-runner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import {
  becomeReady,
  failUpdate,
  HOLDER_A,
  HOLDER_B,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { getApp } from "../repo.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-starter", slug: "starter", access: "shared" });
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "s1", planId: "p-starter", kind: "shared" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A, createdAt: "2026-10-01T00:00:01.000Z" });
  await readyInstance(h, appId, { id: "o2", planId: "p-pro", kind: "own", holder: HOLDER_B, createdAt: "2026-10-01T00:00:02.000Z" });
});
afterEach(async () => {
  await h.close();
});

const advance = async () => advanceRollouts(h.deps, (await getApp(h.db, appId))!);
const start = (planIds = ["p-starter", "p-pro"], noticeHours = 0, version = "1.4.1") =>
  startRollout(h.deps, owner, { appId, version, planIds, noticeHours });
const statuses = async (id: string) =>
  (await stepsOf(h.db, id)).map((s) => `${s.instance_id}:${s.status}`);

describe("the rollout runner (spec 7 step 4)", () => {
  it("waits for the notice, then moves one instance at a time, shared first; a step succeeds only when ready on the target", async () => {
    const r = await start(undefined, 1);
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:pending", "o1:pending", "o2:pending"]);
    h.advance(3_600_000);
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:applying", "o1:pending", "o2:pending"]);
    expect(await instance(h, "s1")).toMatchObject({ target_version: "1.4.1", target_digest: digest("c") });
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:applying", "o1:pending", "o2:pending"]);
    await becomeReady(h, "s1");
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:succeeded", "o1:applying", "o2:pending"]);
    await becomeReady(h, "o1");
    await advance();
    await becomeReady(h, "o2");
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:succeeded", "o1:succeeded", "o2:succeeded"]);
    expect((await getRollout(h.db, r.id))?.status).toBe("complete");
    expect((await listAudit(h.db, appId, { limit: 50 })).map((a) => a.action)).toContain("rollout.completed");
  });

  it("pauses on a failed update (the reconciler reverted it) with an alert row; nothing else starts", async () => {
    const r = await start();
    await advance();
    await becomeReady(h, "s1");
    await advance();
    await failUpdate(h, "o1");
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:succeeded", "o1:failed", "o2:pending"]);
    expect(await getRollout(h.db, r.id)).toMatchObject({
      status: "paused",
      paused_reason: expect.stringMatching(/own-o1: unhealthy/),
    });
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:succeeded", "o1:failed", "o2:pending"]);
    const alert = (await listAudit(h.db, appId, { limit: 50 })).find((a) => a.action === "rollout.paused")!;
    expect(JSON.parse(alert.detail)).toMatchObject({ alert: true, instance: "own-o1" });
  });

  it("sends a step that times out back to its release and pauses", async () => {
    const r = await start(["p-pro"]);
    await advance();
    h.advance(31 * 60_000);
    await advance();
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/after 30 minutes/),
      target_moved: false,
    });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    expect((await getRollout(h.db, r.id))?.status).toBe("paused");
  });

  it("skips stopped instances (their target still moves) and instances pinned since the start", async () => {
    await h.db.updateTable("instances").set({ stop_reason: "the licence ended", status: "stopped" }).where("id", "=", "o1").execute();
    const r = await start(["p-pro"]);
    await h.db.updateTable("instances").set({ pinned_version: "1.4.0" }).where("id", "=", "o2").execute();
    await advance();
    expect((await stepsOf(h.db, r.id)).map((s) => [s.instance_id, s.status, s.note])).toEqual([
      ["o1", "skipped", "stopped: updated when it wakes"],
      ["o2", "skipped", "pinned at 1.4.0"],
    ]);
    expect((await instance(h, "o1")).target_version).toBe("1.4.1");
    expect((await instance(h, "o2")).target_version).toBe("1.4.0");
    expect((await getRollout(h.db, r.id))?.status).toBe("complete");
  });

  it("holds steps outside the plan's update window", async () => {
    await h.db
      .updateTable("plans")
      .set({ update_window: JSON.stringify({ days: [6, 7], start: "00:00", end: "00:00", timeZone: "UTC" }) })
      .where("id", "=", "p-pro")
      .execute();
    const r = await start(["p-pro"]);
    await advance(); // Friday 2026-10-02
    expect(await statuses(r.id)).toEqual(["o1:pending", "o2:pending"]);
    h.clock.now = new Date("2026-10-03T00:00:01.000Z");
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:applying", "o2:pending"]);
  });

  it("starts nothing while held, but settles what moves", async () => {
    const r = await start(["p-pro"]);
    await advance();
    h.deps.cfg.plans = { enabled: true, stopAfterDays: 14, rolloutsHold: true };
    await becomeReady(h, "o1");
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:succeeded", "o2:pending"]);
  });

  it("runs inside the reconciler's pass", async () => {
    const r = await start(["p-starter"]);
    await reconcileInstancesOnce(h.deps);
    expect((await stepsOf(h.db, r.id))[0].status).toBe("applying");
    expect((await instance(h, "s1")).target_version).toBe("1.4.1");
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Create `rollouts/runner.ts`:

```ts
import type { Kysely } from "kysely";
import { AUDIT_SYSTEM_ACTOR, recordAudit, type AuditEntry } from "../audit/repo.js";
import { rolloutsEnabled, rolloutsHeld } from "../config.js";
import type { RolloutStepStatus, VetraAppsDB } from "../db/schema.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import { UPDATE_TIMEOUT_MS } from "../instances/status.js";
import { targetOf } from "../instances/targets.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { releaseProblem } from "./check.js";
import {
  lockRollout,
  movingStep,
  openRollouts,
  stepsOf,
  transitionStep,
  updateRollout,
  type RolloutRow,
  type RolloutStepRow,
} from "./repo.js";
import type { RolloutActor } from "./service.js";
import { inWindow, parseWindow, type UpdateWindow } from "./window.js";

/** The reconciler's update timeout plus 10 minutes (decision R10). */
export const STEP_TIMEOUT_MS = UPDATE_TIMEOUT_MS + 10 * 60_000;
export const STOPPED_NOTE = "stopped: updated when it wakes";
export const REMOVED_NOTE = "the instance was removed";
export const SYSTEM = { actor: AUDIT_SYSTEM_ACTOR, source: "system" as const };

type Who = RolloutActor | typeof SYSTEM;

/** The audit row of a step's change (subject: its rollout). */
export function stepEntry(
  step: RolloutStepRow,
  to: RolloutStepStatus,
  at: string,
  more: { note?: string | null; error?: string | null } = {},
  who: Who = SYSTEM,
): AuditEntry {
  return {
    appId: step.app_id,
    at,
    actor: who.actor,
    source: who.source,
    action: "rollout.step",
    subject: `rollout:${step.rollout_id}`,
    detail: {
      stepId: step.id,
      instance: step.instance_name,
      kind: step.instance_kind,
      from: step.status,
      to,
      fromVersion: step.from_version,
      toVersion: step.to_version,
      note: more.note ?? null,
      error: more.error ?? null,
    },
  };
}

/**
 * Sets the instance's target to the App's release `version` and clears a
 * failed target, so the reconciler applies it (or goes back to it). Pass the
 * transaction.
 */
export async function pointInstanceAt(
  db: Kysely<VetraAppsDB>,
  appId: string,
  instanceId: string,
  version: string,
  nowIso: string,
): Promise<void> {
  const r = await releaseByVersion(db, appId, version);
  if (!r) throw new Error(`the App has no release ${version}`);
  await updateInstance(
    db,
    instanceId,
    { ...targetOf(r), failed_digest: null, failed_settings: null },
    nowIso,
  );
}

const due = (iso: string, nowMs: number) => {
  const t = Date.parse(iso);
  // Fails closed: a date that does not parse is never due.
  return Number.isFinite(t) && t <= nowMs;
};

/** Ends a step (guarded), with its audit row; `also` runs in the same transaction. */
async function endStep(
  deps: AppsDeps,
  step: RolloutStepRow,
  to: RolloutStepStatus,
  more: { note?: string | null; error?: string | null } = {},
  also?: (trx: Kysely<VetraAppsDB>, nowIso: string) => Promise<void>,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const done = await transitionStep(
      trx,
      step.id,
      [step.status],
      { status: to, note: more.note ?? step.note, error: more.error ?? null, finished_at: nowIso },
      nowIso,
    );
    if (!done) return;
    await also?.(trx, nowIso);
    await recordAudit(trx, stepEntry(step, to, nowIso, more));
  });
}

/**
 * A step failed: `failed` (forward) or `revert_failed` (rollback), the
 * instance sent back to `sendBackTo` when given (a timeout; the reconciler
 * already went back after a failed update), and the rollout paused with an
 * alert row (spec 7 step 4).
 */
async function failStep(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
  to: "failed" | "revert_failed",
  error: string,
  sendBackTo: string | null,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const done = await transitionStep(
      trx,
      step.id,
      [step.status],
      {
        status: to,
        error,
        finished_at: nowIso,
        ...(sendBackTo ? { target_moved: false } : {}),
      },
      nowIso,
    );
    if (!done) return;
    if (sendBackTo) await pointInstanceAt(trx, app.id, step.instance_id, sendBackTo, nowIso);
    await recordAudit(trx, stepEntry(step, to, nowIso, { error }));
    const r = await lockRollout(trx, step.rollout_id);
    if (r.status !== "active") return;
    await updateRollout(
      trx,
      r.id,
      {
        status: "paused",
        paused_at: nowIso,
        paused_reason: `${step.instance_name}: ${error}`.slice(0, 500),
      },
      nowIso,
    );
    await recordAudit(trx, {
      appId: app.id,
      at: nowIso,
      ...SYSTEM,
      action: "rollout.paused",
      subject: `rollout:${r.id}`,
      detail: { alert: true, version: r.version, instance: step.instance_name, reason: error },
    });
  });
  deps.logger.warn(
    `[vetra-apps] rollout ${step.rollout_id} of ${app.slug} paused: ${step.instance_name}: ${error}`,
  );
}

/** Settles the moving step from the instance row the reconciler wrote; true while it still moves. */
async function settle(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
): Promise<boolean> {
  const back = step.status === "reverting";
  const want = back ? step.from_version : step.to_version;
  const done: RolloutStepStatus = back ? "rolled_back" : "succeeded";
  const gone: RolloutStepStatus = back ? "rolled_back" : "skipped";
  const inst = await getInstance(deps.db, step.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, step, gone, { note: REMOVED_NOTE });
    return false;
  }
  if (inst.stop_reason || inst.status === "stopped") {
    await endStep(deps, step, gone, {
      note: back ? `stopped: back on ${want} when it wakes` : STOPPED_NOTE,
    });
    return false;
  }
  if (inst.target_version !== want) {
    await endStep(deps, step, gone, { note: `moved to ${inst.target_version} meanwhile` });
    return false;
  }
  if (
    inst.status === "ready" &&
    inst.running_version === want &&
    inst.running_digest === inst.target_digest
  ) {
    await endStep(deps, step, done);
    return false;
  }
  const to = back ? "revert_failed" : "failed";
  if (inst.status === "failed" && inst.failed_digest === inst.target_digest) {
    await failStep(deps, app, step, to, inst.reason ?? "the update failed", null);
    return false;
  }
  if (inst.status === "degraded" && inst.running_digest === inst.target_digest) {
    await failStep(deps, app, step, to, `not healthy after the update: ${inst.reason ?? "degraded"}`, null);
    return false;
  }
  const started = Date.parse(step.started_at ?? "");
  if (!Number.isFinite(started) || deps.now().getTime() - started > STEP_TIMEOUT_MS) {
    await failStep(
      deps,
      app,
      step,
      to,
      `not ready on ${want} after ${STEP_TIMEOUT_MS / 60_000} minutes`,
      back ? null : step.from_version,
    );
    return false;
  }
  return true;
}

/** Starts a forward step; true when an instance now moves (one per App). */
async function startStep(
  deps: AppsDeps,
  app: AppRow,
  s: RolloutStepRow,
): Promise<boolean> {
  const inst = await getInstance(deps.db, s.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, s, "skipped", { note: REMOVED_NOTE });
    return false;
  }
  if (inst.pinned_version && inst.pinned_version !== s.to_version) {
    await endStep(deps, s, "skipped", { note: `pinned at ${inst.pinned_version}` });
    return false;
  }
  if (
    inst.target_version === s.to_version &&
    inst.status === "ready" &&
    inst.running_version === s.to_version
  ) {
    await endStep(deps, s, "succeeded", { note: `already on ${s.to_version}` });
    return false;
  }
  const release = await releaseByVersion(deps.db, app.id, s.to_version);
  const problem = releaseProblem(s.to_version, release);
  if (problem) {
    await endStep(deps, s, "skipped", { note: problem });
    return false;
  }
  try {
    targetOf(release!);
  } catch (err) {
    await endStep(deps, s, "skipped", { note: String(err).slice(0, 500) });
    return false;
  }
  const stopped = !!inst.stop_reason || inst.status === "stopped";
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["pending"],
      stopped
        ? { status: "skipped", note: STOPPED_NOTE, target_moved: true, started_at: nowIso, finished_at: nowIso, attempts: s.attempts + 1 }
        : { status: "applying", target_moved: true, started_at: nowIso, error: null, attempts: s.attempts + 1 },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(trx, app.id, inst.id, s.to_version, nowIso);
    await recordAudit(trx, stepEntry(s, moved.status, nowIso, { note: moved.note }));
  });
  return !stopped;
}

/** Starts a rollback step (Task 11 fills this in). */
async function startRevert(
  _deps: AppsDeps,
  _app: AppRow,
  _s: RolloutStepRow,
): Promise<boolean> {
  return false;
}

async function windowsOf(deps: AppsDeps, r: RolloutRow): Promise<Map<string, UpdateWindow | null>> {
  const rows = await deps.db
    .selectFrom("plans")
    .innerJoin("rollout_plans", "rollout_plans.plan_id", "plans.id")
    .select(["plans.id as id", "plans.update_window as window"])
    .where("rollout_plans.rollout_id", "=", r.id)
    .execute();
  return new Map(rows.map((x) => [x.id, parseWindow(x.window)]));
}

/** Starts the next due step of the App's active rollouts, oldest rollout first; at most one moves. */
async function startNext(deps: AppsDeps, app: AppRow): Promise<void> {
  const now = deps.now();
  for (const r of await openRollouts(deps.db, app.id)) {
    if (r.status !== "active") continue;
    const steps = await stepsOf(deps.db, r.id);
    if (r.direction === "back") {
      const queue = steps
        .filter((s) => s.status === "revert_pending")
        .sort((a, b) => b.position - a.position);
      for (const s of queue) if (await startRevert(deps, app, s)) return;
      continue;
    }
    const pending = steps.filter((s) => s.status === "pending");
    const sharedLeft = pending.some((s) => s.instance_kind === "shared");
    const windows = await windowsOf(deps, r);
    for (const s of pending) {
      // Update now / retry (decision R4): no notice, window or shared-first.
      if (s.requested_at === null) {
        if (s.instance_kind === "own" && sharedLeft) continue;
        if (!due(s.due_at, now.getTime())) continue;
        const w = windows.get(s.plan_id);
        if (w && !inWindow(w, now)) continue;
      }
      if (await startStep(deps, app, s)) return;
    }
  }
}

const tally = (steps: RolloutStepRow[]) =>
  steps.reduce<Record<string, number>>((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {});

/** Open rollouts with nothing left to do are complete (forward) or rolled back (back). */
async function finishDone(deps: AppsDeps, app: AppRow): Promise<void> {
  for (const r of await openRollouts(deps.db, app.id)) {
    const steps = await stepsOf(deps.db, r.id);
    const open: RolloutStepStatus[] =
      r.direction === "forward"
        ? ["pending", "applying", "failed"]
        : ["revert_pending", "reverting", "revert_failed"];
    if (steps.some((s) => open.includes(s.status))) continue;
    const status = r.direction === "forward" ? "complete" : "rolled_back";
    const nowIso = deps.now().toISOString();
    await deps.db.transaction().execute(async (trx) => {
      const cur = await lockRollout(trx, r.id);
      if (cur.status !== "active" && cur.status !== "paused") return;
      await updateRollout(trx, r.id, { status, finished_at: nowIso, paused_at: null, paused_reason: null }, nowIso);
      await recordAudit(trx, {
        appId: app.id,
        at: nowIso,
        ...SYSTEM,
        action: status === "complete" ? "rollout.completed" : "rollout.rolled_back",
        subject: `rollout:${r.id}`,
        detail: { version: r.version, steps: tally(steps) },
      });
    });
  }
}

/**
 * One pass of the App's rollouts (spec section 7). Runs inside the
 * reconciler's per-App pass, under appInstancesLock (never taken here):
 * settles the moving step from the instance row, starts the next due step
 * (one moving instance per App), and closes finished rollouts. The
 * reconciler applies a moved target in the same pass.
 */
export async function advanceRollouts(deps: AppsDeps, app: AppRow): Promise<void> {
  if (!rolloutsEnabled(deps.cfg)) return;
  const moving = await movingStep(deps.db, app.id);
  const stillMoving = moving ? await settle(deps, app, moving) : false;
  if (!stillMoving && !rolloutsHeld(deps.cfg)) await startNext(deps, app);
  await finishDone(deps, app);
}
```

- [ ] **Step 4: Wire it.** In `instances/reconciler.ts` import `advanceRollouts` from `../rollouts/runner.js`, and in `reconcileApp`, inside `if (plans.enabled && wantsInstances(app)) { … }`, after the `syncPlanInstances` try/catch, add:

```ts
    try {
      // Before the rows are read: a target a step moves is applied in this pass.
      await advanceRollouts(deps, app);
    } catch (err) {
      deps.logger.warn(`[vetra-apps] rollouts of ${app.slug}: ${message(err)}`);
    }
```

- [ ] **Step 5: Run it again.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts subgraphs/vetra-apps/__tests__/instances-plans.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts/runner.ts subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts && git commit -m "feat(rollouts): runner moves one instance at a time, health-gated, pauses on failure" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---
### Task 10: Pause, resume, cancel, retry, skip

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/controls.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-controls.test.ts`

**Interfaces:**
- Consumes: `loadRollout`, `rolloutJson`, `callerActor`, `auditAs` (Task 8); `pointInstanceAt`, `stepEntry` (Task 9); repo (Task 2).
- Produces: `pauseRollout(deps, caller, rolloutId, reason?)`, `resumeRollout(deps, caller, rolloutId)`, `cancelRollout(deps, caller, rolloutId)`, `retryRolloutStep(deps, caller, stepId)`, `skipRolloutStep(deps, caller, stepId)`, all `Promise<RolloutJson>`, all `need: "release"`, all under `appInstancesLock`.
- Semantics:
  - pause: `active` → `paused` (idempotent when paused); audit `rollout.paused { alert: false }`.
  - resume: `paused` → `active`; refused while a step is `failed` or `revert_failed` ("retry or skip … first").
  - cancel (forward only): pending steps → `skipped` ("rollout cancelled"); failed steps → `skipped`, their instance back to `from_version`; an applying step is left to settle; plans keep the new target (new instances start on it; `rollBackRollout` still works on a cancelled rollout).
  - retry: `failed` → `pending` with `requested_at` (runs at once, decision R4), `revert_failed` → `revert_pending`; then the rollout resumes when nothing else blocks.
  - skip: `pending` or `failed` → `skipped`, the instance back to `from_version` when the step had moved it; `revert_pending`/`revert_failed` → `skipped` ("left on <to>"); then resume when nothing else blocks.

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-controls.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger, type Harness } from "./harness.js";
import {
  becomeReady,
  code,
  failUpdate,
  HOLDER_A,
  HOLDER_B,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import {
  cancelRollout,
  pauseRollout,
  resumeRollout,
  retryRolloutStep,
  skipRolloutStep,
} from "../rollouts/controls.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A, createdAt: "2026-10-01T00:00:01.000Z" });
  await readyInstance(h, appId, { id: "o2", planId: "p-pro", kind: "own", holder: HOLDER_B, createdAt: "2026-10-01T00:00:02.000Z" });
});
afterEach(async () => {
  await h.close();
});

const advance = async () => advanceRollouts(h.deps, (await getApp(h.db, appId))!);
const start = () => startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 0 });
const step = async (rolloutId: string, instanceId: string) =>
  (await stepsOf(h.db, rolloutId)).find((s) => s.instance_id === instanceId)!;

describe("rollout controls (spec 7 step 5)", () => {
  it("pause holds the next step; resume continues", async () => {
    const r = await start();
    await advance();
    await pauseRollout(h.deps, owner, r.id, "waiting for support");
    await becomeReady(h, "o1");
    await advance();
    expect((await step(r.id, "o1")).status).toBe("succeeded");
    expect((await step(r.id, "o2")).status).toBe("pending");
    expect((await getRollout(h.db, r.id))?.paused_reason).toBe("waiting for support");
    await resumeRollout(h.deps, owner, r.id);
    await advance();
    expect((await step(r.id, "o2")).status).toBe("applying");
  });

  it("retry runs a failed step again at once and resumes; resume alone is refused while it is failed", async () => {
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await expect(resumeRollout(h.deps, owner, r.id)).rejects.toThrow(/Retry or skip own-o1/);
    await retryRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    expect((await getRollout(h.db, r.id))?.status).toBe("active");
    await advance();
    expect(await step(r.id, "o1")).toMatchObject({ status: "applying", attempts: 2 });
    expect((await instance(h, "o1")).failed_digest).toBeNull();
  });

  it("skip sends a failed step's instance back and resumes with the next one", async () => {
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await skipRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    expect(await step(r.id, "o1")).toMatchObject({ status: "skipped", target_moved: false });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    await advance();
    expect((await step(r.id, "o2")).status).toBe("applying");
  });

  it("cancel skips what waits, sends failed instances back, lets the moving one settle, keeps the plan's target", async () => {
    await readyInstance(h, appId, { id: "o3", planId: "p-pro", kind: "own", createdAt: "2026-10-01T00:00:03.000Z" });
    const r = await start();
    await advance();
    await failUpdate(h, "o1");
    await advance();
    await skipRolloutStep(h.deps, owner, (await step(r.id, "o1")).id);
    await advance(); // o2 applying
    await cancelRollout(h.deps, owner, r.id);
    expect((await getRollout(h.db, r.id))?.status).toBe("cancelled");
    expect((await step(r.id, "o3")).status).toBe("skipped");
    expect((await step(r.id, "o2")).status).toBe("applying");
    await becomeReady(h, "o2");
    await advance();
    expect((await step(r.id, "o2")).status).toBe("succeeded");
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.1");
  });

  it("is for operators and release managers; unknown ids are NOT_FOUND", async () => {
    const r = await start();
    await expect(pauseRollout(h.deps, stranger, r.id)).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(pauseRollout(h.deps, owner, "nope")).rejects.toMatchObject(code("NOT_FOUND"));
    await expect(skipRolloutStep(h.deps, owner, "nope")).rejects.toMatchObject(code("NOT_FOUND"));
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-controls.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Create `rollouts/controls.ts`:

```ts
import type { Kysely } from "kysely";
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { recordAudit } from "../audit/repo.js";
import type { RolloutStepStatus, VetraAppsDB } from "../db/schema.js";
import { appsError } from "../errors.js";
import type { AppsDeps } from "../service.js";
import {
  appInstancesLock,
  getStep,
  lockRollout,
  OPEN_ROLLOUT,
  stepsOf,
  transitionStep,
  updateRollout,
  type RolloutRow,
} from "./repo.js";
import { pointInstanceAt, stepEntry } from "./runner.js";
import {
  auditAs,
  callerActor,
  loadRollout,
  rolloutJson,
  type RolloutActor,
  type RolloutJson,
} from "./service.js";

const BLOCKING: RolloutStepStatus[] = ["failed", "revert_failed"];

/** Runs `change` under the App's lock in one transaction, then returns the rollout as it is. */
async function underLock(
  deps: AppsDeps,
  appId: string,
  rolloutId: string,
  change: (trx: Kysely<VetraAppsDB>, cur: RolloutRow, nowIso: string) => Promise<void>,
): Promise<RolloutJson> {
  return withKeyLock(appInstancesLock(appId), async () => {
    const nowIso = deps.now().toISOString();
    await deps.db.transaction().execute(async (trx) => {
      await change(trx, await lockRollout(trx, rolloutId), nowIso);
    });
    return rolloutJson(deps.db, (await deps.db
      .selectFrom("rollouts")
      .selectAll()
      .where("id", "=", rolloutId)
      .executeTakeFirstOrThrow()));
  });
}

async function loadStepFor(deps: AppsDeps, caller: Caller, stepId: string) {
  const s = await getStep(deps.db, stepId);
  if (!s) throw appsError("NOT_FOUND", "Rollout step not found");
  const { r, app } = await loadRollout(deps, caller, s.rollout_id, "release");
  return { s, r, app };
}

/** A paused rollout whose last blocking step was retried or skipped goes on. */
async function resumeIfClear(
  trx: Kysely<VetraAppsDB>,
  cur: RolloutRow,
  who: RolloutActor,
  nowIso: string,
): Promise<void> {
  if (cur.status !== "paused") return;
  if ((await stepsOf(trx, cur.id)).some((s) => BLOCKING.includes(s.status))) return;
  await updateRollout(trx, cur.id, { status: "active", paused_at: null, paused_reason: null }, nowIso);
  await auditAs(trx, who, {
    appId: cur.app_id,
    at: nowIso,
    action: "rollout.resumed",
    subject: `rollout:${cur.id}`,
    detail: { version: cur.version },
  });
}

export async function pauseRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
  reason?: string | null,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  const why = reason?.trim().slice(0, 500) || `paused by ${caller.address}`;
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (cur.status === "paused") return;
    if (cur.status !== "active") throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    await updateRollout(trx, cur.id, { status: "paused", paused_at: nowIso, paused_reason: why }, nowIso);
    await auditAs(trx, callerActor(caller), {
      appId: app.id,
      at: nowIso,
      action: "rollout.paused",
      subject: `rollout:${cur.id}`,
      detail: { alert: false, version: cur.version, reason: why },
    });
  });
}

export async function resumeRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (cur.status === "active") return;
    if (cur.status !== "paused") throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    const stuck = (await stepsOf(trx, cur.id)).filter((s) => BLOCKING.includes(s.status));
    if (stuck.length > 0)
      throw appsError(
        "BAD_USER_INPUT",
        `Retry or skip ${stuck.map((s) => s.instance_name).join(", ")} first`,
      );
    await updateRollout(trx, cur.id, { status: "active", paused_at: null, paused_reason: null }, nowIso);
    await auditAs(trx, callerActor(caller), {
      appId: app.id,
      at: nowIso,
      action: "rollout.resumed",
      subject: `rollout:${cur.id}`,
      detail: { version: cur.version },
    });
  });
}

export async function cancelRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  const who = callerActor(caller);
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (!(OPEN_ROLLOUT as readonly string[]).includes(cur.status))
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    if (cur.direction === "back")
      throw appsError(
        "BAD_USER_INPUT",
        "A rollback is not cancelled: pause it, or retry or skip its steps",
      );
    for (const s of await stepsOf(trx, cur.id)) {
      if (s.status === "pending") {
        await transitionStep(trx, s.id, ["pending"], { status: "skipped", note: "rollout cancelled", finished_at: nowIso }, nowIso);
        await recordAudit(trx, stepEntry(s, "skipped", nowIso, { note: "rollout cancelled" }, who));
      } else if (s.status === "failed") {
        if (s.target_moved && s.from_version)
          await pointInstanceAt(trx, app.id, s.instance_id, s.from_version, nowIso);
        const note = `rollout cancelled; back on ${s.from_version}`;
        await transitionStep(trx, s.id, ["failed"], { status: "skipped", note, target_moved: false, finished_at: nowIso }, nowIso);
        await recordAudit(trx, stepEntry(s, "skipped", nowIso, { note }, who));
      }
    }
    await updateRollout(trx, cur.id, { status: "cancelled", finished_at: nowIso, paused_at: null, paused_reason: null }, nowIso);
    await auditAs(trx, who, {
      appId: app.id,
      at: nowIso,
      action: "rollout.cancelled",
      subject: `rollout:${cur.id}`,
      detail: { version: cur.version },
    });
  });
}

export async function retryRolloutStep(
  deps: AppsDeps,
  caller: Caller,
  stepId: string,
): Promise<RolloutJson> {
  const { s, r, app } = await loadStepFor(deps, caller, stepId);
  const who = callerActor(caller);
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (!(OPEN_ROLLOUT as readonly string[]).includes(cur.status))
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    const step = (await getStep(trx, s.id))!;
    const to =
      step.status === "failed" ? "pending" : step.status === "revert_failed" ? "revert_pending" : null;
    if (!to)
      throw appsError("BAD_USER_INPUT", `Only a failed step is retried (this one is ${step.status})`);
    await transitionStep(trx, step.id, [step.status], { status: to, error: null, finished_at: null, requested_at: nowIso }, nowIso);
    await recordAudit(trx, stepEntry(step, to, nowIso, { note: "retried" }, who));
    await resumeIfClear(trx, cur, who, nowIso);
  });
}

export async function skipRolloutStep(
  deps: AppsDeps,
  caller: Caller,
  stepId: string,
): Promise<RolloutJson> {
  const { s, r, app } = await loadStepFor(deps, caller, stepId);
  const who = callerActor(caller);
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    const step = (await getStep(trx, s.id))!;
    let note: string;
    let back = false;
    if (step.status === "pending" || step.status === "failed") {
      // A failed (or retried, now pending) step's instance targets the new release: back it goes.
      back = step.target_moved && !!step.from_version;
      note = back
        ? `skipped by ${caller.address}; back on ${step.from_version}`
        : `skipped by ${caller.address}`;
    } else if (step.status === "revert_pending" || step.status === "revert_failed")
      note = `left on ${step.to_version}`;
    else
      throw appsError(
        "BAD_USER_INPUT",
        `Only a pending or failed step is skipped (this one is ${step.status})`,
      );
    if (back) await pointInstanceAt(trx, app.id, step.instance_id, step.from_version!, nowIso);
    await transitionStep(trx, step.id, [step.status], { status: "skipped", note, target_moved: back ? false : step.target_moved, finished_at: nowIso }, nowIso);
    await recordAudit(trx, stepEntry(step, "skipped", nowIso, { note }, who));
    await resumeIfClear(trx, cur, who, nowIso);
  });
}
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/rollouts/controls.ts subgraphs/vetra-apps/__tests__/rollouts-controls.test.ts && git commit -m "feat(rollouts): pause, resume, cancel, retry and skip" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 11: Roll back (image swap)

**Files:**
- Modify: `subgraphs/vetra-apps/rollouts/controls.ts`, `subgraphs/vetra-apps/rollouts/runner.ts` (`startRevert`)
- Test: `subgraphs/vetra-apps/__tests__/rollouts-rollback.test.ts`

**Interfaces:**
- Produces: `rollBackRollout(deps, caller, rolloutId): Promise<RolloutJson>` (decision R5).
  - Allowed on a forward rollout that is `active`, `paused`, `complete` or `cancelled`. Refused for a release with `migrates: true` ("needs the backup restore of slice 4"), for a plan that has moved on to another target, for a plan that had no target before.
  - In one transaction: each plan's target goes back to `rollout_plans.from_version` (audited `plan.target_set` with `rollback: true`); pending steps → `skipped` ("rolled back before its turn"); `applying`, `succeeded`, `failed` and `skipped` steps with `target_moved` → `revert_pending`; instances of the plans that joined on the rollout's version without a step get a `revert_pending` step ("joined during the rollout"); the rollout becomes `direction: back`, `active` (or `rolled_back` at once when there is nothing to revert); audit `rollout.rolling_back`.
- Changes (`runner.ts`): `startRevert` moves one `revert_pending` step (reverse position order, ignoring notice and windows): removed → `rolled_back`; pinned elsewhere → `skipped`; already on `from_version` and ready (e.g. a failed step the reconciler reverted) → `rolled_back`; stopped → target set, `rolled_back` ("stopped: back on X when it wakes"); else target set, `reverting`. The existing `settle` finishes `reverting` (`rolled_back`, or `revert_failed` + pause).

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-rollback.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import {
  becomeReady,
  failUpdate,
  HOLDER_A,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import { rollBackRollout, retryRolloutStep } from "../rollouts/controls.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-starter", slug: "starter", access: "shared" });
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "s1", planId: "p-starter", kind: "shared" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
});
afterEach(async () => {
  await h.close();
});

const advance = async () => advanceRollouts(h.deps, (await getApp(h.db, appId))!);
const statuses = async (id: string) => (await stepsOf(h.db, id)).map((s) => `${s.instance_id}:${s.status}`);

async function completed() {
  const r = await startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-starter", "p-pro"], noticeHours: 0 });
  await advance();
  await becomeReady(h, "s1");
  await advance();
  await becomeReady(h, "o1");
  await advance();
  expect((await getRollout(h.db, r.id))?.status).toBe("complete");
  return r;
}

describe("rolling back (spec section 7, image swap)", () => {
  it("sets the plans' targets back and returns instances one at a time, own first, including one that joined on the new release", async () => {
    const r = await completed();
    await readyInstance(h, appId, { id: "o9", planId: "p-pro", kind: "own", version: "1.4.1", createdAt: "2026-10-05T00:00:00.000Z" });
    await rollBackRollout(h.deps, owner, r.id);
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.0");
    expect((await getPlan(h.db, "p-starter"))?.target_version).toBe("1.4.0");
    expect(await getRollout(h.db, r.id)).toMatchObject({ direction: "back", status: "active", rolled_back_by: owner.address });
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:revert_pending", "o1:revert_pending", "o9:reverting"]);
    expect((await instance(h, "o9")).target_version).toBe("1.4.0");
    await becomeReady(h, "o9");
    await advance();
    await becomeReady(h, "o1");
    await advance();
    await becomeReady(h, "s1");
    await advance();
    expect(await statuses(r.id)).toEqual(["s1:rolled_back", "o1:rolled_back", "o9:rolled_back"]);
    expect((await getRollout(h.db, r.id))?.status).toBe("rolled_back");
  });

  it("refuses a release that migrates, a plan that moved on, and a second rollback", async () => {
    const r = await completed();
    await h.db.updateTable("releases").set({ migrates: true }).where("version", "=", "1.4.1").execute();
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(/migrates/);
    await h.db.updateTable("releases").set({ migrates: false }).where("version", "=", "1.4.1").execute();
    await h.db.updateTable("plans").set({ target_version: "1.5.0" }).where("id", "=", "p-pro").execute();
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(/pro has moved on to 1.5.0/);
    await h.db.updateTable("plans").set({ target_version: "1.4.1" }).where("id", "=", "p-pro").execute();
    await rollBackRollout(h.deps, owner, r.id);
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(/already rolled back/);
  });

  it("a failed way back pauses; retry tries it again", async () => {
    const r = await completed();
    await rollBackRollout(h.deps, owner, r.id);
    await advance();
    await failUpdate(h, "o1", "unhealthy (crash)");
    await advance();
    expect((await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")?.status).toBe("revert_failed");
    expect((await getRollout(h.db, r.id))?.status).toBe("paused");
    await retryRolloutStep(h.deps, owner, (await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")!.id);
    await advance();
    expect((await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")?.status).toBe("reverting");
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-rollback.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`rollBackRollout` missing).
- [ ] **Step 3: `startRevert`.** In `runner.ts` replace the stub `startRevert` (Task 9) with:

```ts
/** Starts one rollback step; true when an instance now moves. Ignores notice and windows (decision R5). */
async function startRevert(
  deps: AppsDeps,
  app: AppRow,
  s: RolloutStepRow,
): Promise<boolean> {
  const back = s.from_version;
  const inst = await getInstance(deps.db, s.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, s, "rolled_back", { note: REMOVED_NOTE });
    return false;
  }
  if (!back) {
    await endStep(deps, s, "skipped", { note: "no release to go back to" });
    return false;
  }
  if (inst.pinned_version && inst.pinned_version !== back) {
    await endStep(deps, s, "skipped", { note: `pinned at ${inst.pinned_version}: left alone` });
    return false;
  }
  if (inst.target_version === back && inst.status === "ready" && inst.running_version === back) {
    await endStep(deps, s, "rolled_back");
    return false;
  }
  if (!(await releaseByVersion(deps.db, app.id, back))) {
    await failStep(deps, app, s, "revert_failed", `the App has no release ${back}`, null);
    return false;
  }
  const stopped = !!inst.stop_reason || inst.status === "stopped";
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["revert_pending"],
      stopped
        ? { status: "rolled_back", note: `stopped: back on ${back} when it wakes`, target_moved: false, started_at: nowIso, finished_at: nowIso }
        : { status: "reverting", target_moved: false, started_at: nowIso, finished_at: null, error: null },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(trx, app.id, inst.id, back, nowIso);
    await recordAudit(trx, stepEntry(s, moved.status, nowIso, { note: moved.note }));
  });
  return !stopped;
}
```

  A `revert_failed` → `revert_pending` retry (Task 10) re-enters here.
- [ ] **Step 4: `rollBackRollout`.** In `controls.ts` add imports `releaseByVersion` from `../releases/repo.js`, `listInstances` from `../instances/repo.js`, `lockPlan, updatePlan` from `../plans/repo.js`, `insertSteps, rolloutPlans` from `./repo.js`, and:

```ts
const REVERTIBLE: RolloutStepStatus[] = ["applying", "succeeded", "failed"];

/**
 * Rolls a rollout back by image (spec section 7; decision R5): the plans'
 * targets go back now, instances one at a time through the runner.
 */
export async function rollBackRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  const who = callerActor(caller);
  const release = await releaseByVersion(deps.db, app.id, r.version);
  if (release?.migrates)
    throw appsError(
      "BAD_USER_INPUT",
      `${r.version} migrates its database; rolling it back needs the backup restore (releases phase 3 slice 4)`,
    );
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (cur.direction === "back")
      throw appsError("BAD_USER_INPUT", "The rollout is already rolled back (or rolling back)");
    if (!["active", "paused", "complete", "cancelled"].includes(cur.status))
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    const plans = await rolloutPlans(trx, cur.id);
    const fromOf = new Map<string, string>();
    for (const rp of plans) {
      const p = await lockPlan(trx, rp.plan_id);
      if (p.target_version !== cur.version)
        throw appsError(
          "BAD_USER_INPUT",
          `${p.slug} has moved on to ${p.target_version}; roll that rollout back first`,
        );
      if (!rp.from_version)
        throw appsError("BAD_USER_INPUT", `${p.slug} had no release before this rollout`);
      fromOf.set(p.id, rp.from_version);
      await updatePlan(trx, p.id, { target_version: rp.from_version }, nowIso);
      await auditAs(trx, who, {
        appId: app.id,
        at: nowIso,
        action: "plan.target_set",
        subject: `plan:${p.id}`,
        detail: { slug: p.slug, from: cur.version, to: rp.from_version, rolloutId: cur.id, rollback: true },
      });
    }
    const steps = await stepsOf(trx, cur.id);
    let queued = 0;
    for (const s of steps) {
      if (s.status === "pending") {
        await transitionStep(trx, s.id, ["pending"], { status: "skipped", note: "rolled back before its turn", finished_at: nowIso }, nowIso);
      } else if (REVERTIBLE.includes(s.status) || (s.status === "skipped" && s.target_moved)) {
        await transitionStep(trx, s.id, [s.status], { status: "revert_pending", requested_at: null, error: null, finished_at: null }, nowIso);
        queued++;
      }
    }
    // Instances that joined on the new release (decision R3) go back too.
    const stepped = new Set(steps.map((s) => s.instance_id));
    const joined = (await listInstances(trx, app.id)).filter(
      (i) =>
        !!i.plan_id &&
        fromOf.has(i.plan_id) &&
        !i.removed_at &&
        i.target_version === cur.version &&
        !stepped.has(i.id),
    );
    const last = steps.reduce((m, s) => Math.max(m, s.position), -1);
    await insertSteps(
      trx,
      joined.map((i, n) => ({
        id: deps.newId(),
        rollout_id: cur.id,
        app_id: app.id,
        plan_id: i.plan_id!,
        instance_id: i.id,
        instance_kind: i.kind as "shared" | "own",
        instance_name: i.name,
        position: last + 1 + n,
        from_version: fromOf.get(i.plan_id!)!,
        to_version: cur.version,
        status: "revert_pending" as const,
        due_at: nowIso,
        requested_at: null,
        started_at: null,
        finished_at: null,
        target_moved: true,
        attempts: 0,
        error: null,
        note: "joined during the rollout",
        created_at: nowIso,
        updated_at: nowIso,
      })),
    );
    queued += joined.length;
    await updateRollout(
      trx,
      cur.id,
      {
        direction: "back",
        status: queued > 0 ? "active" : "rolled_back",
        paused_at: null,
        paused_reason: null,
        finished_at: queued > 0 ? null : nowIso,
        rolled_back_by: who.actor,
        rolled_back_at: nowIso,
      },
      nowIso,
    );
    await auditAs(trx, who, {
      appId: app.id,
      at: nowIso,
      action: "rollout.rolling_back",
      subject: `rollout:${cur.id}`,
      detail: { version: cur.version, steps: queued },
    });
  });
}
```

- [ ] **Step 5: Run it again.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-rollback.test.ts subgraphs/vetra-apps/__tests__/rollouts-controls.test.ts subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts subgraphs/vetra-apps/__tests__/rollouts-rollback.test.ts && git commit -m "feat(rollouts): roll back by image, one instance at a time" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 12: Pin and unpin own instances

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/pins.ts`
- Modify: `subgraphs/vetra-apps/instances/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-pins.test.ts`

**Interfaces:**
- Produces: `pinInstance(deps, caller, instanceId, version): Promise<InstanceJson>`, `unpinInstance(deps, caller, instanceId): Promise<InstanceJson>` (decision R11); `InstanceJson.pinnedVersion: string | null`.
- Semantics: own instances only; the version passes `releaseProblem` and `planFitProblem` for the instance's plan; refused while the instance's step is moving; a pending step of it → `skipped` ("pinned at X"); a target different from the version moves at once (failed fields cleared); audit `instance.pinned { name, version, previous, moved }` / `instance.unpinned { name, was }`. Unpin never moves the target.

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-pins.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import {
  code,
  HOLDER_A,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getApp } from "../repo.js";
import { stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import { pinInstance, unpinInstance } from "../rollouts/pins.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-starter", slug: "starter", access: "shared" });
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "s1", planId: "p-starter", kind: "shared" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
});
afterEach(async () => {
  await h.close();
});

describe("pinning (spec section 7)", () => {
  it("pins an own instance: its waiting step is skipped; the next rollout skips it; unpinning moves nothing", async () => {
    const r = await startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 5 });
    const pinned = await pinInstance(h.deps, owner, "o1", "1.4.0");
    expect(pinned).toMatchObject({ pinnedVersion: "1.4.0", targetVersion: "1.4.0" });
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({ status: "skipped", note: "pinned at 1.4.0" });
    const unpinned = await unpinInstance(h.deps, owner, "o1");
    expect(unpinned).toMatchObject({ pinnedVersion: null, targetVersion: "1.4.0" });
    const actions = (await listAudit(h.db, appId, { limit: 50 })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["instance.pinned", "instance.unpinned"]));
  });

  it("pinning to another release moves the instance at once", async () => {
    expect(await pinInstance(h.deps, owner, "o1", "1.5.0")).toMatchObject({
      pinnedVersion: "1.5.0",
      targetVersion: "1.5.0",
    });
  });

  it("refuses shared instances, builds and withdrawn releases, and an instance whose update is moving", async () => {
    await expect(pinInstance(h.deps, owner, "s1", "1.4.0")).rejects.toThrow(/Only own instances/);
    await h.db.updateTable("releases").set({ withdrawn_at: "2026-10-02T00:00:00.000Z" }).where("version", "=", "2.0.0").execute();
    await expect(pinInstance(h.deps, owner, "o1", "2.0.0")).rejects.toThrow(/withdrawn/);
    await expect(pinInstance(h.deps, owner, "nope", "1.4.0")).rejects.toMatchObject(code("NOT_FOUND"));
    await startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 0 });
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    await expect(pinInstance(h.deps, owner, "o1", "1.4.0")).rejects.toThrow(/in progress/);
    expect((await instance(h, "o1")).pinned_version ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-pins.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: `instanceJson`.** In `instances/service.ts` add `pinnedVersion: string | null;` to `InstanceJson` (after `holder`) and `pinnedVersion: r.pinned_version ?? null,` to `instanceJson`.
- [ ] **Step 4: Implement.** Create `rollouts/pins.ts`:

```ts
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { recordAudit } from "../audit/repo.js";
import { appsError } from "../errors.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import { instanceJson, type InstanceJson } from "../instances/service.js";
import { targetOf } from "../instances/targets.js";
import { getPlan } from "../plans/repo.js";
import { releaseByVersion } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { planFitProblem, releaseProblem } from "./check.js";
import { appInstancesLock, movingStep, pendingStepOfInstance, transitionStep } from "./repo.js";
import { stepEntry } from "./runner.js";
import { callerActor } from "./service.js";

async function loadOwnInstance(deps: AppsDeps, caller: Caller, instanceId: string) {
  const inst = await getInstance(deps.db, instanceId);
  if (!inst || inst.removed_at) throw appsError("NOT_FOUND", "Instance not found");
  const app = await loadAppForOwner(deps, caller, inst.app_id, { need: "release" });
  if (inst.kind !== "own")
    throw appsError(
      "BAD_USER_INPUT",
      "Only own instances are pinned (spec section 7); a shared instance follows its plan",
    );
  return { inst, app };
}

/** Pins an own instance to a release (decision R11): rollouts skip it; another release is applied at once. */
export async function pinInstance(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  version: string,
): Promise<InstanceJson> {
  const { inst, app } = await loadOwnInstance(deps, caller, instanceId);
  const v = version.trim();
  const release = await releaseByVersion(deps.db, app.id, v);
  const plan = inst.plan_id ? await getPlan(deps.db, inst.plan_id) : null;
  const problem = releaseProblem(v, release) ?? (plan ? planFitProblem(release!, plan) : null);
  if (problem) throw appsError("BAD_USER_INPUT", `Cannot pin to ${v}: ${problem}`);
  const target = targetOf(release!);
  return withKeyLock(appInstancesLock(app.id), async () => {
    const nowIso = deps.now().toISOString();
    const row = await deps.db.transaction().execute(async (trx) => {
      const moving = await movingStep(trx, app.id);
      if (moving?.instance_id === inst.id)
        throw appsError(
          "BAD_USER_INPUT",
          `Its update to ${moving.to_version} is in progress; pin it once that settles`,
        );
      const cur = (await getInstance(trx, inst.id))!;
      if (cur.pinned_version === v && cur.target_version === v) return cur;
      const waiting = await pendingStepOfInstance(trx, inst.id);
      if (waiting) {
        const note = `pinned at ${v}`;
        await transitionStep(trx, waiting.step.id, ["pending"], { status: "skipped", note, finished_at: nowIso }, nowIso);
        await recordAudit(trx, stepEntry(waiting.step, "skipped", nowIso, { note }, callerActor(caller)));
      }
      const moved = cur.target_version !== v;
      const updated = await updateInstance(
        trx,
        inst.id,
        { pinned_version: v, ...(moved ? { ...target, failed_digest: null, failed_settings: null } : {}) },
        nowIso,
      );
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "instance.pinned",
        subject: `instance:${inst.id}`,
        detail: { name: inst.name, version: v, previous: cur.target_version, moved },
      });
      return updated;
    });
    return instanceJson(row);
  });
}

/** Unpins: the instance stays where it is; a rollout of its plan's target catches it up (decision R8). */
export async function unpinInstance(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<InstanceJson> {
  const { inst, app } = await loadOwnInstance(deps, caller, instanceId);
  return withKeyLock(appInstancesLock(app.id), async () => {
    const nowIso = deps.now().toISOString();
    const row = await deps.db.transaction().execute(async (trx) => {
      const cur = (await getInstance(trx, inst.id))!;
      if (!cur.pinned_version) return cur;
      const updated = await updateInstance(trx, inst.id, { pinned_version: null }, nowIso);
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "instance.unpinned",
        subject: `instance:${inst.id}`,
        detail: { name: inst.name, was: cur.pinned_version },
      });
      return updated;
    });
    return instanceJson(row);
  });
}
```

- [ ] **Step 5: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` (the `AppInstance` shape grew a field; update a `toEqual` there to include `pinnedVersion: null` if one fails). Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts/pins.ts subgraphs/vetra-apps/instances/service.ts subgraphs/vetra-apps/__tests__ && git commit -m "feat(rollouts): pin and unpin own instances" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 13: Withdraw a release

**Files:**
- Create: `subgraphs/vetra-apps/releases/withdraw.ts`
- Modify: `subgraphs/vetra-apps/releases/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/releases-withdraw.test.ts`

**Interfaces:**
- Produces: `withdrawRelease(deps, caller, appId, version, reason?): Promise<ReleaseJson>` (spec 14.3, decision R6; `need: "release"`; idempotent; refused for builds, for a release a plan targets, or one an instance is pinned to); `ReleaseJson.withdrawn: { at: string; by: string; reason: string | null } | null`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/releases-withdraw.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger, type Harness } from "./harness.js";
import { code, readyInstance, rolloutHarness, seedPlan } from "./rollouts-fixtures.js";
import { seedRelease } from "./instances-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { withdrawRelease } from "../releases/withdraw.js";
import { checkRolloutFor } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own", target_version: "1.4.1" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", version: "1.4.1" });
});
afterEach(async () => {
  await h.close();
});

describe("withdrawing a release (spec 14.3)", () => {
  it("withdraws once, audited; a withdrawn release cannot be rolled out", async () => {
    const w = await withdrawRelease(h.deps, owner, appId, "1.5.0", "breaks exports");
    expect(w.withdrawn).toMatchObject({ by: owner.address, reason: "breaks exports" });
    expect((await withdrawRelease(h.deps, owner, appId, "1.5.0", null)).withdrawn?.at).toBe(w.withdrawn?.at);
    expect(
      (await listAudit(h.db, appId, { limit: 10 })).filter((a) => a.action === "release.withdrawn"),
    ).toHaveLength(1);
    expect((await checkRolloutFor(h.deps, owner, appId, "1.5.0", ["p-pro"])).problems).toEqual([
      "1.5.0 was withdrawn",
    ]);
  });

  it("refuses a release a plan targets or an instance is pinned to, builds, and strangers", async () => {
    await expect(withdrawRelease(h.deps, owner, appId, "1.4.1", null)).rejects.toThrow(/pro targets 1.4.1/);
    await h.db.updateTable("instances").set({ pinned_version: "2.0.0" }).where("id", "=", "o1").execute();
    await expect(withdrawRelease(h.deps, owner, appId, "2.0.0", null)).rejects.toThrow(/own-o1 is pinned/);
    await seedRelease(h, appId, { version: "1.6.0-main.4", run: 140 });
    await expect(withdrawRelease(h.deps, owner, appId, "1.6.0-main.4", null)).rejects.toThrow(/build/);
    await expect(withdrawRelease(h.deps, stranger, appId, "1.5.0", null)).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(withdrawRelease(h.deps, owner, appId, "9.9.9", null)).rejects.toMatchObject(code("NOT_FOUND"));
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/releases-withdraw.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: `ReleaseJson`.** In `releases/service.ts` add to `ReleaseJson`:

```ts
  /** Withdrawn by the publisher (spec 14.3); null while it may be targeted. */
  withdrawn: { at: string; by: string; reason: string | null } | null;
```

  and to `releaseJson`:

```ts
    withdrawn: r.withdrawn_at
      ? { at: r.withdrawn_at, by: r.withdrawn_by ?? "", reason: r.withdrawn_reason ?? null }
      : null,
```

- [ ] **Step 4: Implement.** Create `releases/withdraw.ts`:

```ts
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { appsError } from "../errors.js";
import { appInstancesLock } from "../rollouts/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { releaseJson, type ReleaseJson } from "./service.js";

/**
 * Withdraws a release (spec 14.3; decision R6): no plan may target it from
 * now on, policies pass it by, instances still on it are flagged by the
 * console. Never un-withdrawn; the record stays.
 */
export async function withdrawRelease(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  version: string,
  reason: string | null | undefined,
): Promise<ReleaseJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "release" });
  const why = reason?.trim().slice(0, 500) || null;
  return withKeyLock(appInstancesLock(app.id), () =>
    deps.db.transaction().execute(async (trx) => {
      const r = await trx
        .selectFrom("releases")
        .selectAll()
        .where("app_id", "=", app.id)
        .where("version", "=", version)
        .forUpdate()
        .executeTakeFirst();
      if (!r) throw appsError("NOT_FOUND", `The App has no release ${version}`);
      if (r.kind !== "release")
        throw appsError("BAD_USER_INPUT", `${version} is a build; builds are pruned, not withdrawn`);
      if (r.withdrawn_at) return releaseJson({ ...r, run: Number(r.run) });
      const targeting = await trx
        .selectFrom("plans")
        .select("slug")
        .where("app_id", "=", app.id)
        .where("target_version", "=", version)
        .execute();
      if (targeting.length > 0)
        throw appsError(
          "BAD_USER_INPUT",
          `${targeting.map((p) => p.slug).join(", ")} ${targeting.length === 1 ? "targets" : "target"} ${version}: roll back its rollout or roll out another release first`,
        );
      const pinned = await trx
        .selectFrom("instances")
        .select("name")
        .where("app_id", "=", app.id)
        .where("pinned_version", "=", version)
        .where("removed_at", "is", null)
        .execute();
      if (pinned.length > 0)
        throw appsError(
          "BAD_USER_INPUT",
          `${pinned.map((i) => i.name).join(", ")} ${pinned.length === 1 ? "is" : "are"} pinned at ${version}: pin elsewhere first`,
        );
      const nowIso = deps.now().toISOString();
      const row = await trx
        .updateTable("releases")
        .set({ withdrawn_at: nowIso, withdrawn_by: caller.address, withdrawn_reason: why })
        .where("app_id", "=", app.id)
        .where("version", "=", version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "release.withdrawn",
        subject: `release:${version}`,
        detail: { version, reason: why },
      });
      return releaseJson({ ...row, run: Number(row.run) });
    }),
  );
}
```

- [ ] **Step 5: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/releases-report.test.ts subgraphs/vetra-apps/__tests__/releases-query.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` (`ReleaseJson` grew `withdrawn: null`; update a `toEqual` that lists every field). Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/releases subgraphs/vetra-apps/__tests__ && git commit -m "feat(releases): withdraw a release; withdrawn releases are never targeted" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---
### Task 14: Policies start rollouts by themselves

**Files:**
- Modify: `subgraphs/vetra-apps/rollouts/runner.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-policies.test.ts`

**Interfaces:**
- Consumes: `parsePolicy`, `policyCandidate` (Task 4); `beginRollout` (Task 8); `listPlans`, `updatePlan`, `listReleases`, `openRolloutOfPlan`.
- Changes: `advanceRollouts` first runs `runPolicies(deps, app)` (unless held): for each active plan with a policy other than `manual` and a target, the candidate release (Task 4) starts a rollout of that plan alone, actor `vetra`, source `policy`, the plan's notice. A plan in an open rollout waits (R7). A check refusal is recorded once per plan and version (`plans.policy_note` + `rollout.policy_refused`) and cleared when the policy has nothing to do or succeeds. Runs under the App's lock already (inside `reconcileApp`), so it calls `beginRollout` directly.

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-policies.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { HOLDER_A, readyInstance, rolloutHarness, seedPlan } from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import { listRollouts, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
});
afterEach(async () => {
  await h.close();
});
const advance = async () => advanceRollouts(h.deps, (await getApp(h.db, appId))!);

describe("policies (spec section 7)", () => {
  it("patches rolls out 1.4.1 by itself, as Vetra, and its step starts in the same pass", async () => {
    await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own", policy: "patches" });
    await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
    await advance();
    const [r] = await listRollouts(h.db, appId, 5);
    expect(r).toMatchObject({ version: "1.4.1", source: "policy", started_by: "vetra" });
    expect((await stepsOf(h.db, r.id))[0].status).toBe("applying");
  });

  it("minor takes 1.5.0 and never the major; follow:main takes the branch's newest, 2.0.0; then nothing more", async () => {
    await seedPlan(h, appId, { id: "p-minor", slug: "minor", access: "own", policy: "minor" });
    await seedPlan(h, appId, { id: "p-follow", slug: "team-ish", access: "shared", policy: "follow:main" });
    await advance();
    expect((await getPlan(h.db, "p-minor"))?.target_version).toBe("1.5.0");
    expect((await getPlan(h.db, "p-follow"))?.target_version).toBe("2.0.0");
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toHaveLength(2);
  });

  it("waits while the plan is in an open rollout, then takes the next patch", async () => {
    await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
    await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
    const manual = await startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 5 });
    await h.db.updateTable("plans").set({ policy: "patches" }).where("id", "=", "p-pro").execute();
    await seedRelease(h, appId, { version: "1.4.2", run: 115, kind: "release", digest: digest("f") });
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toHaveLength(1);
    await h.db.updateTable("rollouts").set({ status: "complete" }).where("id", "=", manual.id).execute();
    await advance();
    expect((await listRollouts(h.db, appId, 10))[0]).toMatchObject({ version: "1.4.2", source: "policy" });
  });

  it("records a refusal once per plan and version, and starts nothing", async () => {
    await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own", policy: "patches" });
    await h.db.updateTable("releases").set({ requires: '{"size":"XL"}' }).where("version", "=", "1.4.1").execute();
    await advance();
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toEqual([]);
    expect((await getPlan(h.db, "p-pro"))?.policy_note).toMatch(/^1\.4\.1: Cannot roll out 1\.4\.1: 1\.4\.1 needs size XL/);
    const refused = (await listAudit(h.db, appId, { limit: 20 })).filter((a) => a.action === "rollout.policy_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ actor: "vetra", source: "policy" });
  });

  it("starts nothing while held", async () => {
    await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own", policy: "patches" });
    h.deps.cfg.plans = { enabled: true, stopAfterDays: 14, rolloutsHold: true };
    await advance();
    expect(await listRollouts(h.db, appId, 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-policies.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (no rollout starts).
- [ ] **Step 3: Implement.** In `runner.ts` add imports `GraphQLError` from `graphql`, `listPlans, updatePlan` from `../plans/repo.js`, `listReleases` from `../releases/repo.js`, `openRolloutOfPlan` from `./repo.js`, `parsePolicy, policyCandidate, type Policy` from `./policy.js`, `beginRollout` from `./service.js` (a value import now; `service.ts` imports nothing from `runner.ts`), and:

```ts
const POLICY = { actor: AUDIT_SYSTEM_ACTOR, source: "policy" as const };

/**
 * Policies start rollouts by themselves (spec section 7; decision R13): one
 * plan per rollout, as Vetra, with the plan's notice. A plan in an open
 * rollout waits for it (R7). A refusal is recorded once per plan and version.
 */
async function runPolicies(deps: AppsDeps, app: AppRow): Promise<void> {
  const plans = (await listPlans(deps.db, app.id)).filter(
    (p) => p.status === "active" && p.policy !== "manual" && !!p.target_version,
  );
  if (plans.length === 0) return;
  const releases = await listReleases(deps.db, app.id, { kind: "release", limit: 200 });
  for (const plan of plans) {
    let policy: Policy;
    try {
      policy = parsePolicy(plan.policy);
    } catch {
      continue;
    }
    const want = policyCandidate(policy, plan.target_version!, releases);
    const nowIso = deps.now().toISOString();
    if (!want) {
      if (plan.policy_note) await updatePlan(deps.db, plan.id, { policy_note: null }, nowIso);
      continue;
    }
    if (await openRolloutOfPlan(deps.db, plan.id)) continue;
    try {
      await beginRollout(deps, app, want.version, [plan], POLICY, null);
      if (plan.policy_note) await updatePlan(deps.db, plan.id, { policy_note: null }, nowIso);
    } catch (err) {
      if (!(err instanceof GraphQLError)) throw err;
      const note = `${want.version}: ${err.message}`.slice(0, 500);
      if (plan.policy_note === note) continue;
      await deps.db.transaction().execute(async (trx) => {
        await updatePlan(trx, plan.id, { policy_note: note }, nowIso);
        await recordAudit(trx, {
          appId: app.id,
          at: nowIso,
          ...POLICY,
          action: "rollout.policy_refused",
          subject: `plan:${plan.id}`,
          detail: { slug: plan.slug, version: want.version, policy: plan.policy, reason: err.message },
        });
      });
    }
  }
}
```

  and in `advanceRollouts`, before `const moving = …`:

```ts
  if (!rolloutsHeld(deps.cfg)) await runPolicies(deps, app);
```

- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-runner.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/rollouts/runner.ts subgraphs/vetra-apps/__tests__/rollouts-policies.test.ts && git commit -m "feat(rollouts): plan policies start rollouts by themselves" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 15: The holder's notice and "Update now"

**Files:**
- Create: `subgraphs/vetra-apps/rollouts/holder.ts`
- Modify: `subgraphs/vetra-apps/plans/holder-view.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-holder.test.ts`

**Interfaces:**
- Produces: `HolderUpdateJson { rolloutId; version; dueAt; notes; paused; canUpdateNow }`; `holderUpdateOf(deps, instanceId, kind): Promise<HolderUpdateJson | null>` (the instance's pending step in an open forward rollout; `dueAt` = now when requested, else the later of `due_at` and now, moved to the plan's next window); `updateInstanceNow(deps, caller, instanceId): Promise<HolderUpdateJson>` (the own instance's holder only; refused while paused, held, or with nothing waiting; audited `instance.update_requested`).
- Changes: `HolderInstanceJson.update: HolderUpdateJson | null` on every `myInstances` row (spec 7 step 3, D5: in-app only).

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-holder.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Caller } from "../auth.js";
import { owner, stranger, type Harness } from "./harness.js";
import {
  code,
  HOLDER_A,
  HOLDER_B,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { myInstancesFor } from "../plans/holder-view.js";
import { getApp } from "../repo.js";
import { stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import { pauseRollout } from "../rollouts/controls.js";
import { updateInstanceNow } from "../rollouts/holder.js";

const holder = (address: string): Caller => ({ ...stranger, address });
let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A, createdAt: "2026-10-01T00:00:01.000Z" });
  await readyInstance(h, appId, { id: "o2", planId: "p-pro", kind: "own", holder: HOLDER_B, createdAt: "2026-10-01T00:00:02.000Z" });
  await h.db.updateTable("releases").set({ customer_notes: "Faster exports" }).where("version", "=", "1.4.1").execute();
});
afterEach(async () => {
  await h.close();
});
const start = (noticeHours: number) =>
  startRollout(h.deps, owner, { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours });

describe("holders are told and may update now (spec 7 step 3, 14.8)", () => {
  it("shows the coming update with its notes and due date", async () => {
    const r = await start(24);
    const [mine] = await myInstancesFor(h.deps, holder(HOLDER_A));
    expect(mine.update).toEqual({
      rolloutId: r.id,
      version: "1.4.1",
      dueAt: (await stepsOf(h.db, r.id))[0].due_at,
      notes: "Faster exports",
      paused: false,
      canUpdateNow: true,
    });
  });

  it("moves the due date to the plan's next window", async () => {
    await h.db
      .updateTable("plans")
      .set({ update_window: JSON.stringify({ days: [6, 7], start: "00:00", end: "00:00", timeZone: "UTC" }) })
      .where("id", "=", "p-pro")
      .execute();
    await start(0);
    const [mine] = await myInstancesFor(h.deps, holder(HOLDER_A));
    expect(mine.update?.dueAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("update now starts the holder's step at once, before the notice and the others; only for its holder, never while paused", async () => {
    const r = await start(24);
    expect(await updateInstanceNow(h.deps, holder(HOLDER_A), "o1")).toMatchObject({ canUpdateNow: false });
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    expect((await stepsOf(h.db, r.id)).map((s) => s.status)).toEqual(["applying", "pending"]);
    await expect(updateInstanceNow(h.deps, holder(HOLDER_B), "o1")).rejects.toMatchObject(code("NOT_FOUND"));
    await pauseRollout(h.deps, owner, r.id);
    await expect(updateInstanceNow(h.deps, holder(HOLDER_B), "o2")).rejects.toThrow(/paused/);
    expect(
      (await listAudit(h.db, appId, { limit: 50 })).filter((a) => a.action === "instance.update_requested"),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-holder.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create `rollouts/holder.ts`:

```ts
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { rolloutsEnabled, rolloutsHeld } from "../config.js";
import { appsError } from "../errors.js";
import { getInstance } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { appInstancesLock, pendingStepOfInstance, transitionStep } from "./repo.js";
import { nextWindowStart, parseWindow } from "./window.js";

/** What a holder is told about a coming update (spec 7 step 3; D5: in-app only). */
export interface HolderUpdateJson {
  rolloutId: string;
  version: string;
  /** When it is expected: now when asked for, else after the notice, inside the plan's window. */
  dueAt: string;
  notes: string | null;
  paused: boolean;
  canUpdateNow: boolean;
}

export async function holderUpdateOf(
  deps: AppsDeps,
  instanceId: string,
  kind: string,
): Promise<HolderUpdateJson | null> {
  if (!rolloutsEnabled(deps.cfg)) return null;
  const waiting = await pendingStepOfInstance(deps.db, instanceId);
  if (!waiting) return null;
  const { step, rollout } = waiting;
  const plan = await deps.db
    .selectFrom("plans")
    .select("update_window")
    .where("id", "=", step.plan_id)
    .executeTakeFirst();
  const now = deps.now();
  const window = parseWindow(plan?.update_window);
  const notBefore = new Date(Math.max(Date.parse(step.due_at) || now.getTime(), now.getTime()));
  const dueAt = step.requested_at ? now : window ? nextWindowStart(window, notBefore) : notBefore;
  return {
    rolloutId: rollout.id,
    version: step.to_version,
    dueAt: dueAt.toISOString(),
    notes: rollout.notes,
    paused: rollout.status === "paused",
    canUpdateNow:
      kind === "own" && rollout.status === "active" && !step.requested_at && !rolloutsHeld(deps.cfg),
  };
}

/** "Update now" (spec 7 step 3, 14.8): the holder's own instance is due at once (decision R4). */
export async function updateInstanceNow(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<HolderUpdateJson> {
  const inst = await getInstance(deps.db, instanceId);
  if (
    !inst ||
    inst.kind !== "own" ||
    inst.removed_at ||
    inst.holder_address !== caller.address.toLowerCase()
  )
    throw appsError("NOT_FOUND", "Instance not found");
  if (rolloutsHeld(deps.cfg))
    throw appsError("BAD_USER_INPUT", "Updates are on hold on this Vetra; try again later");
  return withKeyLock(appInstancesLock(inst.app_id), async () => {
    const waiting = await pendingStepOfInstance(deps.db, inst.id);
    if (!waiting) throw appsError("BAD_USER_INPUT", "No update of this instance is waiting");
    if (waiting.rollout.status === "paused")
      throw appsError("BAD_USER_INPUT", "This update is paused until the publisher resumes it");
    if (!waiting.step.requested_at) {
      const nowIso = deps.now().toISOString();
      await deps.db.transaction().execute(async (trx) => {
        await transitionStep(trx, waiting.step.id, ["pending"], { requested_at: nowIso }, nowIso);
        await auditCaller(trx, caller, {
          appId: inst.app_id,
          at: nowIso,
          action: "instance.update_requested",
          subject: `instance:${inst.id}`,
          detail: { name: inst.name, version: waiting.step.to_version, rolloutId: waiting.rollout.id },
        });
      });
    }
    return (await holderUpdateOf(deps, inst.id, inst.kind))!;
  });
}
```

- [ ] **Step 4: Holder view.** In `plans/holder-view.ts` import `holderUpdateOf, type HolderUpdateJson` from `../rollouts/holder.js`; add `update: HolderUpdateJson | null;` to `HolderInstanceJson`; add `"instances.kind as kind"` to the `select`; and replace the final `return` with:

```ts
  return Promise.all(
    [...own, ...shared].map(async ({ host, kind, ...r }) => ({
      ...r,
      url: host ? `https://${host}.${INSTANCE_BASE_DOMAIN}` : null,
      update: await holderUpdateOf(deps, r.instanceId, kind),
    })),
  );
```

- [ ] **Step 5: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/plans-holder-view.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20` (add `update: null` to its full-row expectations if they use `toEqual`). Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts/holder.ts subgraphs/vetra-apps/plans/holder-view.ts subgraphs/vetra-apps/__tests__ && git commit -m "feat(rollouts): holder update notice and update now" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 16: GraphQL

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`
- Test: `subgraphs/vetra-apps/__tests__/rollouts-graphql.test.ts` (and `resolvers.test.ts` "SDL", unchanged, must pass)

**Interfaces:**
- Produces (SDL, below): types `AppRollout`, `AppRolloutPlan`, `AppRolloutStep`, `AppRolloutCheck`, `AppRolloutStepPreview`, `PlanUpdateWindow`, `HolderUpdate`; inputs `StartRolloutInput`, `PlanUpdateWindowInput`; fields `AppPlan.updateWindow`, `AppPlan.policyNote`, `AppRelease.withdrawnAt/withdrawnBy/withdrawnReason`, `AppInstance.pinnedVersion`, `HolderInstance.update`, `UpdatePlanInput.policy/noticeHours/updateWindow/clearUpdateWindow`; queries `appRollouts`, `rollout`, `checkRollout`; mutations `startRollout`, `pauseRollout`, `resumeRollout`, `cancelRollout`, `retryRolloutStep`, `skipRolloutStep`, `rollBackRollout`, `pinInstance`, `unpinInstance`, `withdrawRelease`, `updateInstanceNow`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/rollouts-graphql.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER, STRANGER, type Harness } from "./harness.js";
import { HOLDER_A, readyInstance, rolloutHarness, seedPlan } from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { createResolvers } from "../resolvers.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, { id: "o1", planId: "p-pro", kind: "own", holder: HOLDER_A });
});
afterEach(async () => {
  await h.close();
});

const ctx = (address: string, headers: Record<string, string> = {}) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  headers,
});
const CONSOLE = { origin: "https://vetra.io" };

describe("rollouts over GraphQL", () => {
  it("checks, starts from the console (audited as console), lists, reads and pauses", async () => {
    const r = createResolvers(h.deps);
    const check = await r.Query.checkRollout(null, { appId, version: "1.4.1", planIds: ["p-pro"] }, ctx(OWNER));
    expect(check).toMatchObject({ ok: true, problems: [], steps: [expect.objectContaining({ instanceId: "o1" })] });
    const ro = await r.Mutation.startRollout(
      null,
      { input: { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 1 } },
      ctx(OWNER, CONSOLE),
    );
    expect(ro).toMatchObject({ source: "console", status: "active", steps: [expect.objectContaining({ instanceName: "own-o1", status: "pending" })] });
    expect((await r.Query.appRollouts(null, { appId, limit: null }, ctx(OWNER))).map((x) => x.id)).toEqual([ro.id]);
    expect((await r.Query.rollout(null, { id: ro.id }, ctx(OWNER)))?.version).toBe("1.4.1");
    expect(await r.Query.rollout(null, { id: "nope" }, ctx(OWNER))).toBeNull();
    expect((await r.Mutation.pauseRollout(null, { rolloutId: ro.id, reason: null }, ctx(OWNER))).status).toBe("paused");
    const started = (await listAudit(h.db, appId, { limit: 20 })).find((a) => a.action === "rollout.started")!;
    expect(started.source).toBe("console");
  });

  it("a holder sees the update and asks for it now; pins and withdrawals go through", async () => {
    const r = createResolvers(h.deps);
    await r.Mutation.startRollout(null, { input: { appId, version: "1.4.1", planIds: ["p-pro"], noticeHours: 24 } }, ctx(OWNER));
    const [mine] = await r.Query.myInstances(null, {}, ctx(HOLDER_A));
    expect(mine.update).toMatchObject({ version: "1.4.1", canUpdateNow: true });
    expect(await r.Mutation.updateInstanceNow(null, { instanceId: "o1" }, ctx(HOLDER_A))).toMatchObject({ canUpdateNow: false });
    expect((await r.Mutation.pinInstance(null, { instanceId: "o1", version: "1.4.0" }, ctx(OWNER))).pinnedVersion).toBe("1.4.0");
    expect((await r.Mutation.withdrawRelease(null, { appId, version: "2.0.0", reason: "bad" }, ctx(OWNER))).withdrawnReason).toBe("bad");
    await expect(
      r.Mutation.withdrawRelease(null, { appId, version: "1.5.0", reason: null }, ctx(STRANGER)),
    ).rejects.toMatchObject({ extensions: expect.objectContaining({ code: "FORBIDDEN" }) });
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-graphql.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: SDL.** In `schema.ts`:
  - `AppRelease`, after `powerhouseVersion`: `"Withdrawn by the publisher (spec 14.3): no plan may target it" withdrawnAt: String` `withdrawnBy: String` `withdrawnReason: String`.
  - `AppInstance`, after `holder`: `"own: the release the publisher pinned it to; rollouts skip it" pinnedVersion: String`.
  - `AppPlan`: replace the `policy` description with `"manual | patches | minor | follow:<branch>: whether new releases roll out by themselves"`, and add after `noticeHours`: `"When the plan's instances may be updated; null: any time after the notice" updateWindow: PlanUpdateWindow` and `"The last release the policy could not roll out, and why" policyNote: String`.
  - `HolderInstance`: `"A coming update of this instance; null when none" update: HolderUpdate`.
  - `UpdatePlanInput`: `policy: String`, `noticeHours: Int`, `updateWindow: PlanUpdateWindowInput`, `clearUpdateWindow: Boolean`.
  - New types:

```graphql
  "Weekdays 1 (Monday) to 7 (Sunday) the window starts on; local HH:MM; end <= start runs past midnight; equal: the whole day"
  type PlanUpdateWindow {
    days: [Int!]!
    start: String!
    end: String!
    "IANA time zone, e.g. Europe/Berlin"
    timeZone: String!
  }

  input PlanUpdateWindowInput {
    days: [Int!]!
    start: String!
    end: String!
    timeZone: String!
  }

  "A move of one or more plans to a release, one instance at a time (spec: releases and instances, section 7)"
  type AppRollout {
    id: ID!
    appId: ID!
    version: String!
    "active | paused | complete | cancelled | rolled_back"
    status: String!
    "forward | back (a rollback)"
    direction: String!
    "console | api | policy"
    source: String!
    "An address, or vetra (a policy)"
    startedBy: String!
    startedAt: String!
    "What holders are told: the release's customer notes when it started"
    notes: String
    pausedAt: String
    pausedReason: String
    finishedAt: String
    rolledBackBy: String
    rolledBackAt: String
    plans: [AppRolloutPlan!]!
    steps: [AppRolloutStep!]!
  }

  type AppRolloutPlan {
    planId: ID!
    "The plan's target before the rollout"
    fromVersion: String
    noticeHours: Int!
  }

  type AppRolloutStep {
    id: ID!
    instanceId: ID!
    instanceName: String!
    "shared | own"
    instanceKind: String!
    planId: ID!
    position: Int!
    fromVersion: String
    toVersion: String!
    "pending | applying | succeeded | failed | skipped | revert_pending | reverting | revert_failed | rolled_back"
    status: String!
    "Not before (the notice); the plan's window applies after it"
    dueAt: String!
    "Update now (holder) or retry (publisher)"
    requestedAt: String
    startedAt: String
    finishedAt: String
    attempts: Int!
    error: String
    "pinned at 1.4.2, stopped: updated when it wakes, …"
    note: String
  }

  "What startRollout would do"
  type AppRolloutCheck {
    version: String!
    ok: Boolean!
    problems: [String!]!
    steps: [AppRolloutStepPreview!]!
  }

  type AppRolloutStepPreview {
    instanceId: ID!
    instanceName: String!
    instanceKind: String!
    planId: ID!
    fromVersion: String
    "pending | skipped"
    status: String!
    note: String
    dueAt: String!
  }

  "A coming update a holder is told about (in-app)"
  type HolderUpdate {
    rolloutId: ID!
    version: String!
    dueAt: String!
    notes: String
    paused: Boolean!
    canUpdateNow: Boolean!
  }

  input StartRolloutInput {
    appId: ID!
    "A release of the App"
    version: String!
    planIds: [ID!]!
    "Hours before instances are updated; default each plan's notice"
    noticeHours: Int
  }
```

  - `Query`: `"The App's rollouts, newest first (default 20, at most 100)" appRollouts(appId: ID!, limit: Int): [AppRollout!]!`, `rollout(id: ID!): AppRollout`, `"What a rollout would move, and why it cannot start" checkRollout(appId: ID!, version: String!, planIds: [ID!]!): AppRolloutCheck!`.
  - `Mutation`: replace the `setPlanTarget` description with `"Start a rollout of this plan to a release (the plan's notice; instances one at a time)"`, and add:

```graphql
    "Start a rollout of plans to a release (operators and release managers)"
    startRollout(input: StartRolloutInput!): AppRollout!
    pauseRollout(rolloutId: ID!, reason: String): AppRollout!
    "Refused while a step is failed (retry or skip it)"
    resumeRollout(rolloutId: ID!): AppRollout!
    "Skip what waits; moved instances stay; plans keep the new target"
    cancelRollout(rolloutId: ID!): AppRollout!
    retryRolloutStep(stepId: ID!): AppRollout!
    skipRolloutStep(stepId: ID!): AppRollout!
    "Plans back to their previous release; instances back one at a time (image only)"
    rollBackRollout(rolloutId: ID!): AppRollout!
    "Own instances: rollouts skip it; another release is applied at once"
    pinInstance(instanceId: ID!, version: String!): AppInstance!
    unpinInstance(instanceId: ID!): AppInstance!
    "No plan may target it any more (spec 14.3)"
    withdrawRelease(appId: ID!, version: String!, reason: String): AppRelease!
    "A holder's own instance: its waiting update starts now, outside the notice and window"
    updateInstanceNow(instanceId: ID!): HolderUpdate!
```

- [ ] **Step 4: Resolvers.** In `resolvers.ts`:
  - imports: `appRolloutsFor, checkRolloutFor, rolloutFor, startRollout, type StartRolloutInput` from `./rollouts/service.js`; `cancelRollout, pauseRollout, resumeRollout, retryRolloutStep, rollBackRollout, skipRolloutStep` from `./rollouts/controls.js`; `pinInstance, unpinInstance` from `./rollouts/pins.js`; `updateInstanceNow` from `./rollouts/holder.js`; `withdrawRelease` from `./releases/withdraw.js`; `type ReleaseJson` from `./releases/service.js`.
  - Move the `appReleases` mapping into a top-level function and add the withdrawn fields:

```ts
const releaseOut = (r: ReleaseJson) => ({
  version: r.version,
  kind: r.kind,
  branch: r.branch,
  pr: r.pr,
  commit: r.commit,
  notes: r.notes,
  customerNotes: r.customerNotes,
  imageRef: r.image.ref,
  imageDigest: r.image.digest,
  host: r.image.host,
  packages: r.packages,
  migrates: r.migrates,
  powerhouseVersion: r.built.powerhouse,
  createdAt: r.createdAt,
  withdrawnAt: r.withdrawn?.at ?? null,
  withdrawnBy: r.withdrawn?.by ?? null,
  withdrawnReason: r.withdrawn?.reason ?? null,
});
```

    and use `(await appReleasesFor(…)).map(releaseOut)` in `appReleases`.
  - `Query` additions:

```ts
      appRollouts: (_: unknown, { appId, limit }: { appId: string; limit?: number | null }, ctx: AppsContext) =>
        guard(deps, "appRollouts", () => appRolloutsFor(deps, requireCaller(ctx), appId, limit)),
      rollout: (_: unknown, { id }: { id: string }, ctx: AppsContext) =>
        guard(deps, "rollout", () => rolloutFor(deps, requireCaller(ctx), id)),
      checkRollout: (
        _: unknown,
        { appId, version, planIds }: { appId: string; version: string; planIds: string[] },
        ctx: AppsContext,
      ) =>
        guard(deps, "checkRollout", () =>
          checkRolloutFor(deps, requireCaller(ctx), appId, version, planIds),
        ),
```

  - `Mutation` additions (audited ones use `person(ctx)`):

```ts
      startRollout: (_: unknown, { input }: { input: StartRolloutInput }, ctx: AppsContext) =>
        guard(deps, "startRollout", () => startRollout(deps, person(ctx), input)),
      pauseRollout: (
        _: unknown,
        { rolloutId, reason }: { rolloutId: string; reason?: string | null },
        ctx: AppsContext,
      ) => guard(deps, "pauseRollout", () => pauseRollout(deps, person(ctx), rolloutId, reason)),
      resumeRollout: (_: unknown, { rolloutId }: { rolloutId: string }, ctx: AppsContext) =>
        guard(deps, "resumeRollout", () => resumeRollout(deps, person(ctx), rolloutId)),
      cancelRollout: (_: unknown, { rolloutId }: { rolloutId: string }, ctx: AppsContext) =>
        guard(deps, "cancelRollout", () => cancelRollout(deps, person(ctx), rolloutId)),
      retryRolloutStep: (_: unknown, { stepId }: { stepId: string }, ctx: AppsContext) =>
        guard(deps, "retryRolloutStep", () => retryRolloutStep(deps, person(ctx), stepId)),
      skipRolloutStep: (_: unknown, { stepId }: { stepId: string }, ctx: AppsContext) =>
        guard(deps, "skipRolloutStep", () => skipRolloutStep(deps, person(ctx), stepId)),
      rollBackRollout: (_: unknown, { rolloutId }: { rolloutId: string }, ctx: AppsContext) =>
        guard(deps, "rollBackRollout", () => rollBackRollout(deps, person(ctx), rolloutId)),
      pinInstance: (
        _: unknown,
        { instanceId, version }: { instanceId: string; version: string },
        ctx: AppsContext,
      ) => guard(deps, "pinInstance", () => pinInstance(deps, person(ctx), instanceId, version)),
      unpinInstance: (_: unknown, { instanceId }: { instanceId: string }, ctx: AppsContext) =>
        guard(deps, "unpinInstance", () => unpinInstance(deps, person(ctx), instanceId)),
      withdrawRelease: (
        _: unknown,
        { appId, version, reason }: { appId: string; version: string; reason?: string | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "withdrawRelease", async () =>
          releaseOut(await withdrawRelease(deps, person(ctx), appId, version, reason)),
        ),
      updateInstanceNow: (_: unknown, { instanceId }: { instanceId: string }, ctx: AppsContext) =>
        guard(deps, "updateInstanceNow", () => updateInstanceNow(deps, person(ctx), instanceId)),
```

  `updatePlan` passes `input` through unchanged; `UpdatePlanInput` (Task 6) already has the new fields.
- [ ] **Step 5: Run it again.** Same command as Step 2, plus `npx vitest run subgraphs/vetra-apps/__tests__/audit-graphql.test.ts subgraphs/vetra-apps/__tests__/releases-query.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/schema.ts subgraphs/vetra-apps/resolvers.ts subgraphs/vetra-apps/__tests__/rollouts-graphql.test.ts && git commit -m "feat(apps): rollouts, pins, withdrawals and holder updates over GraphQL" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 17: Full checks, PR

- [ ] **Step 1: Full checks.**
  - `npm run tsc 2>&1 | tail -20`
  - `npm run lint 2>&1 | grep -E "error|✖" | head -20`
  - `npx vitest run subgraphs/vetra-apps shared subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`

  Expected: no new errors compared with Task 0's baseline. Fix what this branch broke (most likely full-object expectations of `AppInstance`, `ReleaseJson`, `HolderInstance` or `AppPlan` in older tests). Leave pre-existing failures alone. Commit fixes as `test(apps): …` with the trailer.
- [ ] **Step 2: Search for direct target writers.** `grep -rn "target_version\|targetOf(" subgraphs/vetra-apps --include=*.ts | grep -v __tests__`. Every write of an existing shared/own row's target must be in `rollouts/runner.ts` (`pointInstanceAt`), `rollouts/pins.ts`, or the new-row path of `plans/sync.ts`. Anything else is a bug: fix it here.
- [ ] **Step 3: PR.** `git push -u origin feat/releases-phase-3-rollouts` and `gh pr create --title "feat(apps): rollouts (releases phase 3, slice 3)"`. The body covers:
  - what ships (three tables, the runner in the reconciler pass, controls, rollback by image, pins, withdrawals, policies, windows, holder notices, GraphQL);
  - that targets of shared and own instances now move only through rollouts, that `setPlanTarget` starts one, and that production is unaffected while `VETRA_APPS_PLANS` is off;
  - decisions R1-R16 as built; `VETRA_APPS_ROLLOUTS_HOLD`;
  - that staging must run `VETRA_APPS_INSTANCE_HEALTH=enforce` before rollouts can move instances there;
  - the staging steps (Task 18).

  End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

### Task 18: Staging verification (needs the user)

The staging canary App `96e56853-7041-4c32-a8f7-e9cc8afb50d4` (`powerhouse-inc/vetra-publish-canary`) has releases `1.0.0` and `1.1.0`, the shared plan **Starter** and the own plan **Pro**, both on `1.1.0`. GraphQL goes to `https://switchboard.staging.vetra.io/graphql/vetra-apps` as the App owner (**O**) unless a step says otherwise. Two holders of Pro are needed: **A** and **B** (publisher grants of Pro's term; issue a second one if only one exists). Record every result in the PR.

- [ ] **Step 1: A narrower crash switch in the canary** (separate PR in `powerhouse-inc/vetra-publish-canary`, branch `feat/crash-admin`). `CANARY_CRASH=1` crashes every instance at once (a settings change rolls them all), so it cannot fail one rollout step. In `index.js`, right after the `CANARY_CRASH` block:

```js
  // Crashes only instances whose ADMINS include this address: one holder's
  // own instance fails a rollout step while the others succeed.
  const crashFor = (process.env.CANARY_CRASH_ADMIN ?? "").trim().toLowerCase();
  const admins = (process.env.ADMINS ?? "").toLowerCase().split(",").map((a) => a.trim());
  if (crashFor && admins.includes(crashFor)) {
    console.error(`CANARY_CRASH_ADMIN=${crashFor}: exiting`);
    process.exit(1);
  }
```

  Check locally: `cd /home/froid/projects/vetra-publish-canary && CANARY_CRASH_ADMIN=0xb ADMINS=0xa,0xB node index.js; echo $?` prints `1`; with `ADMINS=0xa` it listens (stop it with Ctrl-C). Commit `feat: CANARY_CRASH_ADMIN crashes one admin's instances` (trailer), open the PR; the user merges it and the release PR, which publishes **`1.2.0`**. Instances on `1.1.0` ignore the setting (the code is not in their image).
- [ ] **Step 2: Pin and switch.** The user merges a `powerhouse-k8s-hosting` PR that pins the new vetra-cloud-package in `tenants/staging/powerhouse-values.yaml` (`PH_REGISTRY_PACKAGES`, two places) and sets `VETRA_APPS_INSTANCE_HEALTH: "enforce"` there. Production stays as it is. Check `kubectl -n staging logs deploy/powerhouse-staging-switchboard | grep -i "rollouts of" | tail` shows no errors.
- [ ] **Step 3: Today's state.** `appPlans(appId)` → Starter and Pro on `1.1.0`, `policy: "manual"`. `appInstances(appId)` → the Starter instance and A's and B's Pro instances `ready` on `1.1.0`. Note their URLs; `GET <url>/version` answers `1.1.0`.
- [ ] **Step 4: Plan settings.** `updatePlan(input: {planId: <Pro>, noticeHours: 1, updateWindow: {days: [1,2,3,4,5,6,7], start: "<now, local, rounded down>", end: "<now + 3 h>", timeZone: "Europe/Berlin"}})`. The plan shows the window; `appAudit` shows `plan.updated` with the changes.
- [ ] **Step 5: The crash setting.** `setAppSetting(input: {appId, name: "CANARY_CRASH_ADMIN", value: "<B's address>", secret: false})`. All instances roll their settings on `1.1.0` and come back `ready`.
- [ ] **Step 6: Check, then start.** `checkRollout(appId, version: "1.2.0", planIds: [<Starter>, <Pro>])` → `ok: true`, three steps: the Starter instance, then A's, then B's. `checkRollout(appId, "1.0.0", [<Pro>])` → "older than pro's target". Then `startRollout(input: {appId, version: "1.2.0", planIds: [<Starter>, <Pro>], noticeHours: 1})`.
- [ ] **Step 7: The holder's notice.** As A: `myInstances` → the Pro row's `update` is `{version: "1.2.0", dueAt: <start + 1 h>, notes: <1.2.0's notes>, canUpdateNow: true}`. As A: `updateInstanceNow(instanceId: <A's>)`. Within a minute A's step is `applying`, then `succeeded` once health is `healthy` (a few minutes); `GET <A's url>/version` → `1.2.0`. The Starter and B steps stay `pending` (notice).
- [ ] **Step 8: The failure.** After the hour, the Starter step applies and succeeds; then B's step applies, crash-loops, and within about 5-8 minutes: step `failed` (`error` names the crash), rollout `paused` with `pausedReason` `own-…: …`, `appAudit` has `rollout.paused` with `"alert": true`, and `GET <B's url>/version` answers `1.1.0` again (the reconciler's revert).
- [ ] **Step 9: Retry, then skip.** `resumeRollout` → refused ("Retry or skip … first"). `retryRolloutStep(<B's step>)` → it applies at once and fails again. `skipRolloutStep(<B's step>)` → B's instance targets `1.1.0`, the rollout is `complete`.
- [ ] **Step 10: Catch up.** `deleteAppSetting(appId, name: "CANARY_CRASH_ADMIN")`. `checkRollout(appId, "1.2.0", [<Pro>])` → one step (B). `startRollout(… version: "1.2.0", planIds: [<Pro>], noticeHours: 0)` → B succeeds; the rollout completes.
- [ ] **Step 11: Roll back.** `rollBackRollout(<the first rollout's id>)` is refused (Pro moved on through the catch-up rollout); `rollBackRollout(<the catch-up rollout's id>)` → Pro's target is `1.1.0` again and B goes back (`/version` → `1.1.0`); then `rollBackRollout(<the first rollout>)` → Starter and A go back, own first; the rollout ends `rolled_back`.
- [ ] **Step 12: Pin.** `pinInstance(<A's>, "1.1.0")`. `startRollout(… "1.2.0", [<Pro>], noticeHours: 0)` → A's step `skipped`, note `pinned at 1.1.0`; B updates. `unpinInstance(<A's>)` → A stays on `1.1.0`; a catch-up rollout of `1.2.0` moves it.
- [ ] **Step 13: Policy.** `updatePlan(input: {planId: <Pro>, policy: "patches", noticeHours: 0, clearUpdateWindow: true})`. Push a `fix:` commit to the canary (e.g. a README line) and merge its release PR → **`1.2.1`**. Within a minute of the release being recorded, `appRollouts(appId)` shows a rollout of `1.2.1` with `source: "policy"`, `startedBy: "vetra"`, and Pro's instances update one at a time. A `feat:` release (`1.3.0`) is **not** taken by `patches` (check `appRollouts` stays put); set `policy: "minor"` and it is.
- [ ] **Step 14: Withdraw.** Set Pro's `policy: "manual"` first (else the policy re-rolls what you roll back). `withdrawRelease(appId, "1.3.0", reason: "test")` → refused (Pro targets it). Roll the `1.3.0` rollout back, then withdraw → `withdrawnAt` set; `checkRollout(appId, "1.3.0", [<Pro>])` → `1.3.0 was withdrawn`.
- [ ] **Step 15: Brake.** Optional: set `VETRA_APPS_ROLLOUTS_HOLD: "on"` in the staging values, start a rollout with notice 0, and see no step start; remove it and the step starts within a pass.
- [ ] **Step 16: The log.** `appAudit(appId, limit: 100)` shows the story above: `rollout.started` (console/api, then policy), `rollout.step` rows (actor `vetra`, source `system`), `rollout.paused` (alert), `rollout.resumed`, `rollout.completed`, `rollout.rolling_back`, `rollout.rolled_back`, `instance.pinned`/`unpinned`, `instance.update_requested` (actor A), `release.withdrawn`, `plan.updated`, `plan.target_set`. Then the production pin follows the Sektar rollout check (Global Constraints); production keeps `VETRA_APPS_PLANS` off, so nothing changes there.

---

### Task 19: Console follow-up (vetra.to; separate PR after staging works; no code here)

A separate plan or task in the vetra.to repository, on a `feat/app-rollouts` branch, after Task 18 passes:

- **Types.** `npm run codegen` against the staging vetra-apps schema. Queries and mutations in `modules/apps/graphql.ts`: `appRollouts`, `rollout`, `checkRollout`, `startRollout`, `pauseRollout`, `resumeRollout`, `cancelRollout`, `retryRolloutStep`, `skipRolloutStep`, `rollBackRollout`, `pinInstance`, `unpinInstance`, `withdrawRelease`, `updateInstanceNow`, and the new fields of `AppPlan`, `AppRelease`, `AppInstance`, `HolderInstance`. Hooks in `modules/apps/hooks/use-apps.ts`. Controls show only with `appAccess(appId).release`.
- **Plans tab.** Each plan shows its target and, when a newer release exists, "x.y.z available" with **Roll out**. The Roll out dialog: pick a release (withdrawn ones hidden), tick plans (default: the plan clicked), notice in hours (default the plan's), then `checkRollout` lists the steps in order (shared first, pinned ones marked) and every problem; the Start button is disabled while `ok` is false. A plan's settings card edits policy (manual, patches, minor, follow a release branch: a select of the App's release branches), notice, and the update window (weekday chips, start and end times, a time-zone select defaulting to the browser's), and shows `policyNote` as a warning when set.
- **Rollout view.** A route `app/user/apps/[id]/rollouts/[rolloutId]` (and a list in a "Rollouts" tab, newest first): version, who started it (Renown name, or "Vetra (policy)"), status badge, paused reason as an alert, the steps as a timeline (instance name, holder as Renown name and picture, from → to, status, due time in the viewer's zone, note, error), polled every 10 s while active or paused. Buttons: Pause/Resume, Cancel, Retry and Skip on a failed step, Skip on a pending step, **Roll back** (with a confirmation that lists what goes back; disabled with the reason for a release that `migrates`).
- **Releases tab.** "Withdraw" on a release (with a reason field); withdrawn releases are struck through with the reason; instances still running a withdrawn release get a warning badge in the Instances tab.
- **Instances tab.** Own instances get Pin (a release select) and Unpin; a pinned instance shows "pinned at x.y.z".
- **Holder view** (`app/user` "My instances", `modules/subscriptions`): when `update` is set, a banner "Version x.y.z on <date, local time>" with the customer notes (Markdown) and an **Update now** button (`canUpdateNow`); "paused by the publisher" when `paused`.
- **People are Renown names** (`usePersonName`); `vetra` shows as "Vetra".
- **Tests.** Storybook stories for the step timeline (every step status) and the holder banner; a Playwright check of start → pause → resume against a mocked API.

---

## Self-review

- **Spec coverage:**
  - Section 6 last paragraph (shared and own targets only through a rollout) → Task 7, Task 8 (`setPlanTarget`), Task 17 Step 2.
  - Section 7 "Plans": policy table and "a major never by itself" → Tasks 4, 14; `noticeHours` → Tasks 6, 8.
  - Section 7 "A rollout": step 1 check → Tasks 5, 8 (scan status is phase 4; Team gate is the slice 6 hook `teamGateProblem`); step 2 rehearse → not in this slice; step 3 announce → Tasks 8, 15 (D5: in-app only); step 4 one at a time, shared first, health, pause and alert → Task 9 (backups → slice 4); step 5 retry, skip, roll back → Tasks 10, 11. Pinning → Task 12. Rollback by image → Task 11 (restore → slice 4, R5).
  - Section 10 (start/pause/roll back, pin by operators and release managers, audited) → `need: "release"` everywhere, audit rows in every task.
  - Section 11 (Plans "Roll out", Rollout view, release health) → Task 16 API, Task 19.
  - 14.3 → Task 13 (and Tasks 5, 6, 14 refuse withdrawn releases). 14.7 → R2 (enforce). 14.8 → Tasks 3, 9, 15.
  - Overview slice 3 (tables, columns, check, announce, apply, controls, pins, policies, `setPlanTarget`, `withdrawRelease`, compat: existing instances keep their target, `license_environments` never touched; risks: enforce first, stopped instances, DST) → all tasks; the switch is replaced by R1's hold brake.
- **Concurrency:** one lock per App (`appInstancesLock` = the reconciler's), transactions per change, guarded step transitions, a partial unique index for one moving step. The runner never takes the lock (it runs under it). Mutations never call the runner.
- **Placeholders:** none. `startRevert` is a stub in Task 9 by design and is replaced in Task 11 (Task 9's tests never reach it).
- **Type consistency:**
  - `RolloutRow`/`RolloutStepRow`/`RolloutPlanRow` (Task 2) are used by service, runner, controls, pins, holder.
  - `RolloutActor` (Task 8) is used by `beginRollout`, `stepEntry`, controls; `SYSTEM` and `POLICY` (runner) match `AuditSource`.
  - `UpdateWindow` (Task 3) is used by plans (Task 6), runner (Task 9), holder (Task 15), SDL `PlanUpdateWindow` (Task 16).
  - `PolicyRelease` (Task 4) is satisfied by `ReleaseRow` from `listReleases`.
  - `InstanceJson.pinnedVersion` (Task 12), `ReleaseJson.withdrawn` (Task 13), `HolderInstanceJson.update` (Task 15), `PlanJson.updateWindow/policyNote` (Task 6) all reach the SDL in Task 16.
- **Later slices:** slice 4 adds a backup before `startStep` moves a target and a restore path to `rollBackRollout` for `migrates` releases (R5's refusal goes). Slice 5 sets `LICENCE_GATE_MIN_POWERHOUSE`. Slice 6 fills `teamGateProblem` and uses `follow:<branch>` for the Team plan. Slice 9 needs rollouts on in production (`VETRA_APPS_PLANS`, health `enforce`).
