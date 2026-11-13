# Releases phase 3, plan 6: the Team plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organisation App gets an optional **Team plan** with one click (spec section 5 "Team plan", section 7 step 1, journey section 12 rows 3, 4 and 6):
- one shared instance, `<app>-team-<h>`, for the owning organisation's own people: no terms, codes or grants;
- it admits the organisation's **active members**, checked per address against Renown through the licence gate of slice 5 (`reason: "member"`; decision D8: no `ACCESS=members`, no member list in the environment);
- its `ADMINS` are the organisation's OWNER/ADMIN members when Renown lists them publicly, else the App owner (phase 2 gap 9);
- it follows a release branch (`policy = follow:<branch>`, notice 0): every release from that branch rolls out to it by itself through slice 3's policy runner;
- a **customer** rollout of a release is refused until that release ran healthy on Team (with the patch exemption of decision T5).

**Architecture:**
- The Team plan is a `plans` row with `team = true`, slug `team` (already reserved by `checkPlanSlug`), access `shared`, and **no kind** (`kind` becomes nullable). At most one per App (partial unique index). It is never deleted: "disable" retires it, "enable" revives the same row, so the instance (and its data) comes back.
- Plan sync (`plans/sync.ts`) treats it as a shared plan. Its instance is stopped (never deleted) when the plan is retired or the App is no organisation's any more.
- A new per-pass step `syncTeamPlan(deps, app)` (`plans/team.ts`), inside `reconcileApp` under the App's lock, does three things for the active Team plan:
  1. gives it its first target (the newest release of its branch) through slice 3's `beginRollout` as Vetra (`source: "policy"`);
  2. refreshes the Team instance's `ADMINS` from Renown at most every 15 minutes (`instances.admins_override`, which `adminsOf` prefers);
  3. records a release as **ran healthy on Team** once the Team instance has been `ready` and `healthy` on it for `VETRA_APPS_TEAM_SOAK_MINUTES` (table `team_release_runs`, audit `team.ran_healthy`).
- Slice 3's check hook `teamGateProblem` (a stub returning null in `rollouts/check.ts`) gets its body and the rollout's plans as a fourth argument.
- Slice 5's gate route gets one branch: for an instance of a Team plan, the answer is org membership (`teamGateAnswer`), not a licence.
- GraphQL: `enableTeamPlan(appId, followBranch)`, `disableTeamPlan(appId)` (owner and org admins only, spec section 10: `need: "administer"`), `AppPlan.team`, `AppPlan.kind` nullable, `AppRelease.teamHealthyAt`.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, GraphQL (vetra-apps subgraph), Renown `renown-orgs` GraphQL (public reads).

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md`:
- section 5, "Team plan" (optional, off by default, one click on the App page, org apps only; admits the org's members; a release must have run healthy on it before a customer rollout) and the "What every instance runs" table (`ADMINS`: "for publishers: the owner, or the org's admins");
- section 5, "Instance hosts" (`sektar-team`; `team` reserved);
- section 7, policy `follow <branch>` ("Team, Early access") and "A rollout" step 1 ("when the app has a Team instance, that the release has run healthy on it (the Team plan itself is exempt)");
- section 10 ("Turn on the Team plan: owner and org admins"; audited);
- section 12, rows 3, 4 and 6.

Slice scope: `docs/superpowers/plans/2026-11-12-releases-phase-3-overview.md` slice 6, D8, gaps 8 and 11. Conventions and the code this builds on: plans 1 and 2 of phase 3 (on `main`), plan 3 (rollouts, `feat/releases-phase-3-plan-3`), and slice 5 (licence gate, planned in parallel; only its contract is used here).

## Decisions to confirm (recommended default first; the plan is written with the default)

- **T1 Team plan shape.** A `plans` row with `team = true`, `kind = NULL` (the column becomes nullable; Postgres lets the existing `(app_id, kind)` unique constraint hold several NULLs), slug `team`, name "Team", access `shared`, size `VETRA_AGENT_S`, `notice_hours = 0`, policy `follow:<branch>`. *Alternative:* keep `kind` NOT NULL and store a reserved kind (`vetra:team`) that `createPlan` refuses. Rejected: a fake kind leaks into every reader of `plans.kind` (licensing's plan-kinds reader, holder views) and into the API.
- **T2 Who.** `enableTeamPlan`/`disableTeamPlan`: `need: "administer"` (personal owner never applies: org Apps only; org OWNER/ADMIN; platform admins). Everything else on the Team plan (size, `startRollout`, pause, retry, roll back) is a normal plan action (`need: "release"`). `retirePlan` refuses a Team plan ("disable the Team plan instead"), so a release manager cannot switch off the customer gate. `updatePlanFor` refuses a policy change on Team (the branch moves with `enableTeamPlan`).
- **T3 Members.** Every **ACTIVE** member of the owning organisation, any role (OWNER, ADMIN, PUBLISHER, MEMBER), whatever their app scope. A disputed organisation (`apps.org_disputed`) admits nobody but `ADMINS`. *Alternative:* only members whose effective scope covers the App.
- **T4 ADMINS.** The organisation's public ACTIVE OWNER/ADMIN members (Renown `organizationMembers(orgId)` without auth = the public list; hidden members and private orgs give nothing), sorted, at most 50, refreshed at most every 15 minutes, written only on change (an `ADMINS` change restarts the pod). When Renown lists nobody (members private) or has never answered: the App owner (`apps.owner_address`), as every shared instance today. A Renown failure keeps the last list. *Needs the user:* whether the owner-only fallback is acceptable (an org App's `owner_address` may be a person who left the org; the alternative is an empty `ADMINS`, which Powerhouse may treat as "no admin at all").
- **T5 What the Team gate covers.** A customer rollout of version `v` needs `v` to have run healthy on Team, **except** for a plan whose target is on the same `major.minor` and `v` is a stable patch above it (`1.4.0 → 1.4.1`). Reason: the journey (section 12 row ‖) has Starter and Pro (`patches`) take `1.4.1` from `main` by themselves while Team follows `next`; a strict gate would block every hotfix forever. Releases of any branch are covered otherwise (2.0.0 from `main` must have run on Team). *Alternative (strict spec):* every release is gated; then Team must follow the branch customers are fed from.
- **T6 "Ran healthy".** The Team instance was `ready` on `v` (`running_version = v`, `running_digest` = the release's digest) with `health = "healthy"` on that digest (`health_digest`) continuously for `VETRA_APPS_TEAM_SOAK_MINUTES` (default 30, 0-1440), measured from `health_since`. Recorded once per (App, version) in `team_release_runs`, kept forever (the release table is never pruned of releases either), audited `team.ran_healthy`. Needs health `enforce` (slice 3 R2 needs it anyway); in `report`/`off` mode nothing is recorded and customer rollouts of new versions are refused with that reason.
- **T7 Rollouts mixing Team and customers** are refused ("roll out to Team on its own first"): Team must have run the release before customers start, and one rollout runs its shared instances first but does not wait for a soak.
- **T8 Disable.** `disableTeamPlan` retires the plan: its instance is stopped (data kept), the gate stops admitting members (the instance is asleep anyway), and the Team gate on customer rollouts is **off** while it is disabled (audited `plan.team_disabled`, so the console can show who turned it off). Re-enabling revives the same plan and wakes its instance on its old release; the follow policy moves it forward with the next newer release of its branch.
- **T9 App leaves its organisation.** The Team plan stays but its instance is stopped (`TEAM_NOT_ORG`) and the gate admits only `ADMINS`; it wakes when the App is an organisation's again. Enabling Team on a personal App is refused.
- **T10 Apps with licensed environments** (Sektar) may enable Team: it adopts no kind, so overview rule 1 is untouched. The gate only applies to plan rollouts (slice 3); licensing's gated rollouts are not affected.
- **T11 Branch.** `followBranch` defaults to the App's production branch and must be a release branch of the App (`isReleaseBranch`). Changing it (calling `enableTeamPlan` again with another branch) never moves the instance backwards: the policy only takes newer releases (slice 3 R8/R13); to go to an older line the publisher rolls out by hand (Team is exempt from the gate, but not from R8).
- **T12 No `myInstances` entry.** Members see the Team instance on the App page (any org member may view the App). Listing it under "My instances" would need Renown's member-of list per caller; a follow-up if wanted.

## What exists today (checked 2026-11-12 on `main` = 0.0.117, plus plan 3 as written)

- **Plans** (`subgraphs/vetra-apps/plans/`):
  - `PlansTable` (`db/schema.ts`): `kind: string` (NOT NULL, unique per App with `plans_app_kind_uq`), `slug` (unique, `plans_app_slug_uq`), `access`, `size`, `target_version`, `policy`, `notice_hours`, `status` (`active | retired`). Migration `ensurePlansTable` (`db/migrations.ts`).
  - `rules.ts` `checkPlanSlug` already refuses `main`, `team`, `own`, `own-*`, `pr-<n>`, release-branch names. `parseSize`, `PLAN_SIZES`.
  - `service.ts`: `planJson`, `createPlan` (refuses Apps with licensed environments, kinds with licences), `updatePlanFor`, `setPlanTarget`, `retirePlan` (all `need: "release"`, audited via `auditCaller` in one transaction), `appPlansFor` (`view`).
  - `sync.ts` `syncPlanInstances`: per shared plan, `held = [...live.values()].some((c) => c.kind === plan.kind)` (an untyped live licence has `kind === null`, which would match a kind-less plan: fixed in Task 3), `wanted = plan.status === "active" || held`, one row named `plan.slug`, `stop_reason: wanted ? null : PLAN_RETIRED`.
  - `holder-view.ts` joins `plans.kind = <licence kind>` (a NULL kind never matches).
- **Instances** (`subgraphs/vetra-apps/instances/reconciler.ts`): `reconcileApp` → `syncBranchInstances`, `syncPreviewInstances`, then (plans on, `wantsInstances(app)`) `syncPlanInstances` in its own try/catch, then `reconcileInstance` per row. `adminsOf(app, row)`: the holder of an own instance, else `app.owner_address`; it feeds `fusionEnv` (`ADMINS`, comma-separated, as `shared/admins.ts` reads it) at create and update. `planInstanceLabel` hashes shared instances as `plan:<slug>`, so the Team host is `<app slug>-team-<h><suffix>`.
- **Health** (`instances/monitor.ts`, `health.ts`): the monitor writes `health`, `health_digest`, `health_since` ("when the health value last changed, or the judged digest"); the reconciler writes `status = ready` and `running_*` only when health passes in `enforce`.
- **Access** (slice 2): `loadAppForOwner(deps, caller, appId, { need })` with `view | operate | release | administer` (`roles/access.ts` `allows`); `shared/org-access.ts` `canAdminister`. `audit/repo.ts` `AUDIT_ACTIONS` (closed tuple), `AUDIT_SYSTEM_ACTOR = "vetra"`, `recordAudit`; `audit/service.ts` `auditCaller`.
- **Renown** (`shared/renown-orgs.ts`): `RenownOrgs { membership, orgApps, appPublisher, personApps, orgHandle, personHandle }`, all cached (`positiveTtlMs` 30 s, `negativeTtlMs` 10 s), failures throw `RenownOrgsUnavailableError` and are never cached. There is **no** member-list read. Renown's `renown-orgs` subgraph has `organizationMembers(orgId, includeInactive, auth): [OrgMember!]!` ("others see the public list") and `organization(id) { membersPublic archived takenDown }`; `OrgMember { address role status hidden }`. Test fake: `__tests__/harness.ts` `fakeOrgs()` (`join(orgId, address, role)`, `down`).
- **Plan 3 (rollouts), as written** (`/home/froid/projects/vetra-cloud-package-phase3c`, `docs/superpowers/plans/2026-11-12-releases-phase-3-plan-3-rollouts.md`): see "Interfaces this plan needs" below. `plans.policy` accepts `follow:<branch>`; the policy runner (`rollouts/runner.ts` `runPolicies`) skips plans without a target and retries a refused candidate every pass (recording `policy_note` once per plan and version), so a customer policy rollout starts by itself in the pass after Team records the release.
- **Slice 5 (licence gate):** not built yet; its contract is in the overview (slice 5). See below.

## Interfaces this plan needs from other slices

### From slice 3 (rollouts) — must be on `main` before Task 6

| Interface | Used for |
|---|---|
| `rollouts/check.ts` `teamGateProblem(deps, appId, version): Promise<string \| null>` (stub returning null), called once by `rollouts/service.ts` `rolloutProblems(deps, app, version, plans, steps)` | Task 6 replaces the body and adds the plans as a 4th argument, and updates that one call site |
| `rollouts/service.ts` `beginRollout(deps, app, version, plans, who: RolloutActor, noticeHours)` (no access check, caller holds the App lock; throws `BAD_USER_INPUT` with the problems) | Task 5: the Team plan's first target |
| `rollouts/repo.ts` `appInstancesLock(appId)` (= `instances:<appId>`, the reconciler's lock key) | Task 4: `enableTeamPlan` |
| `rollouts/policy.ts` `parsePolicy` (`follow:<branch>`) and the runner taking every newer release of the branch (R13) | Team follows its branch with no code here |
| `plans.policy_note` (optional column) | Task 5 records a first-target refusal like the runner does |
| `updatePlanFor` accepting `policy` | Task 4 refuses it for Team |
| Health `enforce` required for rollouts that move instances (R2) | T6 |

If slice 3 changes a name, keep the behaviour and adjust the import; the tests here go through `checkRolloutFor`/`startRollout` (public) wherever possible.

### From slice 5 (licence gate) — must be on `main` before Task 7

| Interface | Contract (overview slice 5) |
|---|---|
| Every **shared** plan instance gets the gate env (`ACCESS=licensed`, `VETRA_APP_ID`, `VETRA_GATE_URL`) and a gate token (`VETRA_GATE_TOKEN`, sha256 in `instance_gate_tokens`) | The Team instance is a shared plan instance: it gets them with no Team code |
| `POST apps/gate/check` → `200 { allowed, reason: "admin" \| "licence" \| "member" \| "none", until, ttlSeconds: 60 }`, 401 bad token, **503 on any Vetra-side failure** | Task 7 returns `reason: "member"`; a Renown failure must become 503 (the host keeps its 24 h grace) |
| One decision function that, after resolving the token to `(instance, plan)` and answering `admin` from the instance's `ADMINS`, decides the licence answer for a plan | Task 7 inserts `if (plan.team) return teamGateAnswer(deps, app, address)` before the licence lookup. Called `gateDecision` below; use its real name |
| `LICENCE_GATE_MIN_POWERHOUSE` set (D9) in slice 3's `rollouts/check.ts` | Applies to Team as to any shared plan: its releases must carry the gate |

### What this plan gives later slices

- `isTeamPlan(plan)`, `activeTeamPlan(db, appId)`, `teamRunOf(db, appId, version)` (`plans/team.ts`, `plans/team-runs.ts`).
- `instances.admins_override`: an `ADMINS` value that `adminsOf` prefers. Slice 7's support access (publisher added to `ADMINS` for a time) should write the same column rather than add another path.

## Model (as built here)

**`plans`** (changed)

| Column | Change |
|---|---|
| `kind` | nullable; NULL only for the Team plan |
| `team` | new, `boolean`, NULL/false for every other plan; partial unique index `plans_app_team_uq` on `(app_id) where team = true` |

**`instances`** (new nullable columns)

| Column | Meaning |
|---|---|
| `admins_override` | the `ADMINS` value to render instead of `adminsOf`'s default (Team: the org's admins) |
| `admins_checked_at` | when Renown was last asked (throttle, 15 min) |

**`team_release_runs`** (new) — primary key `(app_id, version)`; `digest`, `instance_id`, `healthy_since` (the `health_since` that qualified), `recorded_at`.

**New audit actions:** `plan.team_enabled` (detail `branch`, `from` when the branch changed, `revived` when it was retired), `plan.team_disabled`, `team.ran_healthy` (subject `release:<version>`, detail `digest`, `instanceId`, `soakMinutes`), `instance.admins_set` (subject `instance:<id>`, detail `count`, `fallback: boolean`; addresses are not repeated in the log).

**Constants** (`plans/team.ts`): `TEAM_SLUG = "team"`, `TEAM_NAME = "Team"`, `TEAM_NOT_ORG = "the App is not an organisation's"`, `TEAM_ADMINS_REFRESH_MS = 15 * 60_000`, `TEAM_ADMINS_MAX = 50`.

## Global Constraints

- Additive schema, plus one relaxation (`plans.kind` DROP NOT NULL), all through idempotent, race-tolerant `ensure…` migrations in the namespaced schema builder. New optional columns are declared with `?` in `db/schema.ts` so existing row literals still type-check.
- Nothing changes for an App without a Team plan: no new query in its reconciler pass beyond the plan list it already reads, and `teamGateProblem` returns null after one indexed read.
- Team is only ever a shared plan; it never adopts a kind, never has own instances, and is invisible to licensing (`createPlanKindsReader` ignores NULL kinds).
- The gate check for members asks Renown per address (`membership`), never lists members (overview slice 6 risk).
- `ADMINS` changes are written only when the sorted list changes.
- Every mutation writes its audit row in the same transaction as the change.
- Commits: one per task, conventional (`feat(plans): …`, `feat(rollouts): …`, `feat(gate): …`, `feat(instances): …`, `feat(apps): …`), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-3-team-plan` from `main`.
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. At the end: `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`.
- No production pin of vetra-cloud-package while a Sektar gated rollout is APPLYING (overview rule 4): check `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` first.

## File structure

| File | Change |
|---|---|
| `shared/renown-orgs.ts` | optional `RenownOrgs.orgAdmins?(orgId)`; query `VetraOrgAdmins`; implementation |
| `subgraphs/vetra-apps/config.ts` | `PlansConfig.teamSoakMinutes?`, `VETRA_APPS_TEAM_SOAK_MINUTES`, `teamSoakMs(cfg)` |
| `subgraphs/vetra-apps/db/schema.ts` | `PlansTable.kind: string \| null`, `team?`; `InstancesTable.admins_override?`, `admins_checked_at?`; `TeamReleaseRunsTable`; `VetraAppsDB.team_release_runs` |
| `subgraphs/vetra-apps/db/migrations.ts` | `ensureTeamPlanSchema` in `up` |
| `subgraphs/vetra-apps/audit/repo.ts` | four actions |
| `subgraphs/vetra-apps/plans/team.ts` (new) | constants, `isTeamPlan`, `isOrgApp`, `activeTeamPlan`, `teamPlanOf`, `enableTeamPlan`, `disableTeamPlan`, `syncTeamPlan` |
| `subgraphs/vetra-apps/plans/team-runs.ts` (new) | `teamRunOf`, `teamRunsOf`, `recordTeamRun`, `qualifiesAsRun` |
| `subgraphs/vetra-apps/plans/team-gate.ts` (new) | `teamGateAnswer` |
| `subgraphs/vetra-apps/plans/service.ts` | `planJson` (`team`, nullable `kind`); `retirePlan` and `updatePlanFor` refuse Team where T2 says |
| `subgraphs/vetra-apps/plans/sync.ts` | shared loop: Team never "held"; `TEAM_NOT_ORG` |
| `subgraphs/vetra-licensing/plan-kinds.ts` | NULL kinds ignored |
| `subgraphs/vetra-apps/instances/reconciler.ts` | `adminsOf` prefers `admins_override`; `syncTeamPlan` in `reconcileApp` |
| `subgraphs/vetra-apps/rollouts/check.ts`, `rollouts/service.ts` | `teamGateProblem` body and 4th argument |
| slice 5's gate module | Team branch |
| `subgraphs/vetra-apps/releases/service.ts` | `ReleaseJson.teamHealthyAt` in `appReleasesFor` |
| `subgraphs/vetra-apps/schema.ts`, `resolvers.ts` | `AppPlan.team`, `AppPlan.kind` nullable, `AppRelease.teamHealthyAt`; `enableTeamPlan`, `disableTeamPlan` |
| Tests (new) | `__tests__/team-fixtures.ts`, `team-plan-api.test.ts`, `team-sync.test.ts`, `team-runs.test.ts`, `team-rollout-gate.test.ts`, `team-gate.test.ts`, `team-graphql.test.ts` |
| Tests (changed) | `shared/renown-orgs.test.ts`, `config.test.ts`, `migrations.test.ts`, `instances-plans.test.ts`, `subgraphs/vetra-licensing/__tests__/plan-kinds.test.ts` (or wherever `createPlanKindsReader` is tested) |

---

### Task 0: Pre-flight (no code)

- [ ] **Step 1: Dependencies.** Slice 3 (rollouts) is merged on `main` (`ls subgraphs/vetra-apps/rollouts/check.ts`), and slice 5's Vetra side is merged before Task 7 (`grep -rn "gate/check" subgraphs/vetra-apps`). Tasks 1-6 may land before slice 5; Task 7 waits for it. If slice 3 is not merged, stop: Tasks 5 and 6 cannot be written.
- [ ] **Step 2: Branch.** `git fetch && git checkout -b feat/releases-phase-3-team-plan origin/main`. Never stash; never touch other worktrees (`git worktree list`).
- [ ] **Step 3: Baseline.** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Record pre-existing failures in the PR; do not fix them here.
- [ ] **Step 4: Read the names.** Open `rollouts/check.ts` (`teamGateProblem`), `rollouts/service.ts` (`rolloutProblems`, `beginRollout`, `RolloutActor`), `rollouts/repo.ts` (`appInstancesLock`) and slice 5's gate module, and note any name that differs from this plan. Use the real names throughout.

---

### Task 1: Renown lists an organisation's public admins

**Files:**
- Modify: `shared/renown-orgs.ts`
- Test: `shared/renown-orgs.test.ts`

**Interfaces:**
- Produces: `RenownOrgs.orgAdmins?(orgId: string): Promise<string[] | null>` (optional, so the test fakes that implement `RenownOrgs` need no change). `null`: unknown, archived or taken-down organisation, or members private (`membersPublic: false`). Otherwise the lowercased addresses of public ACTIVE members with role OWNER or ADMIN, sorted, de-duplicated. Cached under `oa|<orgId>` like the other reads; failures throw `RenownOrgsUnavailableError`.

- [ ] **Step 1: Write the failing test.** In `shared/renown-orgs.test.ts`, following the file's existing pattern of a scripted `fetch` (look at how `orgApps` is tested and reuse its helper), append:

```ts
describe("orgAdmins", () => {
  it("lists public ACTIVE owners and admins, lowercased and sorted; null for private, archived or unknown orgs", async () => {
    const answers: unknown[] = [
      {
        data: {
          organization: { membersPublic: true, archived: false, takenDown: false },
          organizationMembers: [
            { address: "0xBB", role: "ADMIN", status: "ACTIVE" },
            { address: "0xaa", role: "OWNER", status: "ACTIVE" },
            { address: "0xcc", role: "MEMBER", status: "ACTIVE" },
            { address: "0xdd", role: "ADMIN", status: "ENDED" },
            { address: "0xaa", role: "OWNER", status: "ACTIVE" },
          ],
        },
      },
      { data: { organization: { membersPublic: false, archived: false, takenDown: false }, organizationMembers: [] } },
      { data: { organization: null, organizationMembers: [] } },
    ];
    const orgs = createRenownOrgs({
      orgsEndpoint: "https://r/graphql/renown-orgs",
      statsEndpoint: "https://r/graphql/renown-stats",
      fetch: (async () =>
        new Response(JSON.stringify(answers.shift()), { status: 200 })) as typeof fetch,
    });
    expect(await orgs.orgAdmins!("o1")).toEqual(["0xaa", "0xbb"]);
    expect(await orgs.orgAdmins!("o1")).toEqual(["0xaa", "0xbb"]); // cached: no second fetch
    expect(await orgs.orgAdmins!("o2")).toBeNull();
    expect(await orgs.orgAdmins!("o3")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run shared/renown-orgs.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`orgAdmins` is undefined).
- [ ] **Step 3: Implement.** In `shared/renown-orgs.ts`:
  - in `interface RenownOrgs`, after `personHandle`:

```ts
  /**
   * The org's public ACTIVE OWNER/ADMIN addresses (lowercased, sorted); null
   * when the org is unknown, archived, taken down or keeps its members
   * private. Public read: hidden members are never listed (releases phase 3
   * slice 6, Team instance ADMINS). Optional: test fakes may leave it out.
   */
  orgAdmins?(orgId: string): Promise<string[] | null>;
```

  - after `PERSON_HANDLE`:

```ts
const ORG_ADMINS = `query VetraOrgAdmins($id: String!) {
  organization(id: $id) { membersPublic archived takenDown }
  organizationMembers(orgId: $id) { address role status }
}`;
```

  - in the returned object, after `personHandle`:

```ts
    orgAdmins(orgId) {
      return cached(`oa|${orgId}`, async () => {
        const data = await post<{
          organization: { membersPublic: boolean; archived: boolean; takenDown: boolean } | null;
          organizationMembers: { address: string; role: OrgRole; status: string }[] | null;
        }>(cfg.orgsEndpoint, ORG_ADMINS, { id: orgId });
        const org = data.organization;
        if (!org || org.archived || org.takenDown || !org.membersPublic) return null;
        const out = new Set<string>();
        for (const m of data.organizationMembers ?? [])
          if (m.status === "ACTIVE" && (m.role === "OWNER" || m.role === "ADMIN"))
            out.add(m.address.toLowerCase());
        return [...out].sort();
      });
    },
```

- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Fake.** In `subgraphs/vetra-apps/__tests__/harness.ts` `fakeOrgs()` add `admins: new Map<string, string[] | null>()` to `self` and:

```ts
    async orgAdmins(orgId: string) {
      if (self.down) throw new RenownOrgsUnavailableError("down");
      return self.admins.has(orgId) ? self.admins.get(orgId)! : null;
    },
```

- [ ] **Step 6: Commit.** `git add shared/renown-orgs.ts shared/renown-orgs.test.ts subgraphs/vetra-apps/__tests__/harness.ts && git commit -m "feat(renown): list an organisation's public admins" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 2: Schema, config and audit actions

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts`, `subgraphs/vetra-apps/db/migrations.ts`, `subgraphs/vetra-apps/config.ts`, `subgraphs/vetra-apps/audit/repo.ts`
- Test: `subgraphs/vetra-apps/__tests__/migrations.test.ts`, `subgraphs/vetra-apps/__tests__/config.test.ts`

**Interfaces:**
- Produces (schema): `PlansTable.kind: string | null`, `PlansTable.team?: boolean | null`; `InstancesTable.admins_override?: string | null`, `admins_checked_at?: string | null`; `TeamReleaseRunsTable { app_id; version; digest; instance_id; healthy_since; recorded_at }` (all `string`); `VetraAppsDB.team_release_runs`.
- Produces (migrations): `ensureTeamPlanSchema(db)` called at the end of `up`.
- Produces (config): `PlansConfig.teamSoakMinutes?: number`; `VETRA_APPS_TEAM_SOAK_MINUTES` (0-1440, default 30); `teamSoakMs(cfg: VetraAppsConfig): number`.
- Produces (audit): `"plan.team_enabled"`, `"plan.team_disabled"`, `"team.ran_healthy"`, `"instance.admins_set"` in `AUDIT_ACTIONS`.

- [ ] **Step 1: Write the failing tests.**
  - `migrations.test.ts`: add `ensureTeamPlanSchema` to the import and append:

```ts
describe("Team plan schema", () => {
  it("lets kind be NULL, allows one Team plan per App, and creates team_release_runs, idempotently and concurrently", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const db = root.withSchema("vetra-apps");
      await up(db);
      await Promise.all([1, 2, 3].map(() => ensureTeamPlanSchema(db)));
      const plan = (id: string, slug: string, team: boolean, kind: string | null) => ({
        id, app_id: "a1", slug, name: slug, kind, access: "shared", size: "VETRA_AGENT_S",
        target_version: null, policy: "manual", notice_hours: 0, status: "active",
        created_by: "0xaa", created_at: "t", updated_at: "t", team,
      });
      await db.insertInto("plans").values(plan("p1", "team", true, null)).execute();
      await db.insertInto("plans").values(plan("p2", "free", false, "free")).execute();
      await db.insertInto("plans").values(plan("p3", "other", false, null)).execute(); // two NULL kinds
      await expect(
        db.insertInto("plans").values(plan("p4", "team-2", true, null)).execute(),
      ).rejects.toThrow();
      await db
        .insertInto("team_release_runs")
        .values({ app_id: "a1", version: "1.0.0", digest: "sha256:x", instance_id: "i1", healthy_since: "t", recorded_at: "t" })
        .execute();
      await db.updateTable("instances").set({ admins_override: "0xaa", admins_checked_at: "t" }).execute();
    } finally {
      await root.destroy();
    }
  });
});
```

  - `config.test.ts`: change the expectation of `loadAppsConfig({}).plans` to include `teamSoakMinutes: 30` (keep whatever else slice 3 put there), and add:

```ts
  it("reads VETRA_APPS_TEAM_SOAK_MINUTES (0-1440) and refuses bad values", () => {
    expect(loadAppsConfig({ VETRA_APPS_TEAM_SOAK_MINUTES: "0" }).plans?.teamSoakMinutes).toBe(0);
    expect(teamSoakMs(loadAppsConfig({ VETRA_APPS_TEAM_SOAK_MINUTES: "45" }))).toBe(45 * 60_000);
    expect(() => loadAppsConfig({ VETRA_APPS_TEAM_SOAK_MINUTES: "1441" })).toThrow();
    expect(teamSoakMs({ ...loadAppsConfig({}), plans: { enabled: true, stopAfterDays: 14 } })).toBe(30 * 60_000);
  });
```

- [ ] **Step 2: Run them.** `npx vitest run subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/config.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Schema.** In `db/schema.ts`:
  - `PlansTable`: `kind: string | null;` with the comment "The licensing term kind adopted; NULL only for the Team plan (no term). Unique per App when set." and, after `status`, `/** The App's Team plan (spec section 5): kind NULL, slug team, one per App. */ team?: boolean | null;`
  - `InstancesTable`, after `target_size`: `/** ADMINS to render instead of the kind's default (Team: the org's admins). */ admins_override?: string | null;` and `/** When the override was last refreshed from Renown. */ admins_checked_at?: string | null;`
  - new table and its entry in `VetraAppsDB` (`team_release_runs: TeamReleaseRunsTable`):

```ts
/** A release that ran healthy on the App's Team instance (spec section 7 step 1). */
export interface TeamReleaseRunsTable {
  app_id: string;
  version: string;
  digest: string;
  instance_id: string;
  /** The health_since that qualified (healthy on the digest since then). */
  healthy_since: string;
  recorded_at: string;
}
```

  Then fix the type errors `npm run tsc 2>&1 | grep error | head -20` reports for `kind` being nullable: `plans/service.ts` `PlanJson.kind: string | null`; `plans/sync.ts` `new Map(plans.map((p) => [p.kind, p]))` becomes `new Map(plans.flatMap((p) => (p.kind ? [[p.kind, p] as const] : [])))`; `subgraphs/vetra-licensing/plan-kinds.ts` `new Set(rows.map((r) => r.kind))` becomes `new Set(rows.flatMap((r) => (r.kind ? [r.kind] : [])))`. Any other site: a NULL kind matches no licence.
- [ ] **Step 4: Migration.** In `db/migrations.ts`, call `await ensureTeamPlanSchema(db);` at the end of `up`, and add:

```ts
/** The Team plan (releases phase 3 slice 6). Schema builder only (namespaced). */
export async function ensureTeamPlanSchema(db: Kysely<any>): Promise<void> {
  const tolerate = (err: unknown) => {
    if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
  };
  try {
    await db.schema.alterTable("plans").addColumn("team", "boolean", (c) => c.ifNotExists()).execute();
  } catch (err) {
    tolerate(err);
  }
  // A kind-less plan; DROP NOT NULL on a nullable column is a no-op.
  try {
    await db.schema.alterTable("plans").alterColumn("kind", (c) => c.dropNotNull()).execute();
  } catch (err) {
    tolerate(err);
  }
  try {
    await db.schema
      .createIndex("plans_app_team_uq")
      .ifNotExists()
      .unique()
      .on("plans")
      .column("app_id")
      .where(sql.ref("team"), "=", true)
      .execute();
  } catch (err) {
    tolerate(err);
  }
  for (const [name, type] of [
    ["admins_override", "text"],
    ["admins_checked_at", "varchar(64)"],
  ] as const) {
    try {
      await db.schema.alterTable("instances").addColumn(name, type, (c) => c.ifNotExists()).execute();
    } catch (err) {
      tolerate(err);
    }
  }
  try {
    await db.schema
      .createTable("team_release_runs")
      .ifNotExists()
      .addColumn("app_id", "varchar(255)", (c) => c.notNull())
      .addColumn("version", "varchar(255)", (c) => c.notNull())
      .addColumn("digest", "varchar(128)", (c) => c.notNull())
      .addColumn("instance_id", "varchar(64)", (c) => c.notNull())
      .addColumn("healthy_since", "varchar(64)", (c) => c.notNull())
      .addColumn("recorded_at", "varchar(64)", (c) => c.notNull())
      .addPrimaryKeyConstraint("team_release_runs_pk", ["app_id", "version"])
      .execute();
  } catch (err) {
    tolerate(err);
  }
}
```

- [ ] **Step 5: Config.** In `config.ts`: `PlansConfig` gains `/** Minutes a release must run healthy on Team before customers get it (slice 6). */ teamSoakMinutes?: number;`; `plansConfig(env)` returns `teamSoakMinutes: intIn(env, "VETRA_APPS_TEAM_SOAK_MINUTES", 30, 0, 1440)`; and

```ts
export const teamSoakMs = (cfg: VetraAppsConfig): number =>
  (plansConfigOf(cfg).teamSoakMinutes ?? 30) * 60_000;
```

- [ ] **Step 6: Audit actions.** Append `"plan.team_enabled"`, `"plan.team_disabled"`, `"team.ran_healthy"`, `"instance.admins_set"` to `AUDIT_ACTIONS`.
- [ ] **Step 7: Run them again.** Same command as Step 2, plus `npm run tsc 2>&1 | tail -5`. Expected: PASS, no type errors.
- [ ] **Step 8: Commit.** `git add -A subgraphs/vetra-apps/db subgraphs/vetra-apps/config.ts subgraphs/vetra-apps/audit/repo.ts subgraphs/vetra-apps/plans subgraphs/vetra-licensing/plan-kinds.ts subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/config.test.ts && git commit -m "feat(plans): Team plan schema (kind-less plan, team runs, ADMINS override)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: Plan sync and ADMINS know the Team plan

**Files:**
- Create: `subgraphs/vetra-apps/plans/team.ts` (constants and pure helpers only in this task)
- Modify: `subgraphs/vetra-apps/plans/sync.ts`, `subgraphs/vetra-apps/instances/reconciler.ts`
- Create: `subgraphs/vetra-apps/__tests__/team-fixtures.ts`
- Test: `subgraphs/vetra-apps/__tests__/team-sync.test.ts`

**Interfaces:**
- Produces (`team.ts`): `TEAM_SLUG`, `TEAM_NAME`, `TEAM_NOT_ORG`, `TEAM_ADMINS_REFRESH_MS`, `TEAM_ADMINS_MAX`; `isTeamPlan(p: Pick<PlanRow, "team">): boolean`; `isOrgApp(app: Pick<AppRow, "owner_org_id" | "org_disputed">): boolean` (an org, not disputed); `activeTeamPlan(db, appId): Promise<PlanRow | null>`; `teamPlanOf(db, appId): Promise<PlanRow | null>` (any status).
- Changes: `syncPlanInstances` — a Team plan is never `held`; its shared row gets `stop_reason = TEAM_NOT_ORG` when `!isOrgApp(app)` (else `PLAN_RETIRED` when retired, else null). `adminsOf(app, row)` returns `row.admins_override` when set.
- Produces (fixtures): `teamHarness()` → `{ h, appId }` (plans on, instances on, health `enforce`, App moved into `ORG`, releases `1.0.0` (run 100, branch `main`) and `1.1.0` (run 101, branch `main`)); `seedTeamPlan(h, appId, over?)` (inserts the plan row directly); `teamRow(h, appId)`; `ORG_ADMIN_A`, `ORG_ADMIN_B`, `ORG_MEMBER`.

- [ ] **Step 1: Fixtures.** Create `__tests__/team-fixtures.ts`:

```ts
import { admin, APP_DID, makeHarness, MEMBER, ORG, OWNER, seedActiveApp, testConfig, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { appForOwner } from "../service.js";
import { insertPlan, type PlanRow } from "../plans/repo.js";
import { listInstances } from "../instances/repo.js";

export const ORG_ADMIN_A = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
export const ORG_ADMIN_B = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export const ORG_MEMBER = "0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

export async function teamHarness(): Promise<{ h: Harness; appId: string }> {
  const base = testConfig({ plans: { enabled: true, stopAfterDays: 14, teamSoakMinutes: 30 } });
  const h = await makeHarness({
    ...base,
    instances: { ...base.instances, health: { ...base.instances.health!, mode: "enforce" } },
  });
  const appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  // Into the org (as org-apps.test.ts moveToOrg does).
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  await appForOwner(h.deps, admin, appId);
  h.orgs.join(ORG, OWNER, "OWNER");
  h.orgs.join(ORG, ORG_ADMIN_A, "ADMIN");
  h.orgs.join(ORG, ORG_MEMBER, "MEMBER");
  h.orgs.join(ORG, MEMBER, "MEMBER");
  await seedRelease(h, appId, { version: "1.0.0", run: 100, kind: "release", digest: digest("a") });
  await seedRelease(h, appId, { version: "1.1.0", run: 101, kind: "release", digest: digest("b") });
  return { h, appId };
}

export const seedTeamPlan = (h: Harness, appId: string, over: Partial<PlanRow> = {}) =>
  insertPlan(h.db, {
    id: "p-team",
    app_id: appId,
    slug: "team",
    name: "Team",
    kind: null,
    team: true,
    access: "shared",
    size: "VETRA_AGENT_S",
    target_version: "1.0.0",
    policy: "follow:main",
    notice_hours: 0,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over,
  } as PlanRow);

export const teamRow = async (h: Harness, appId: string) =>
  (await listInstances(h.db, appId, "shared")).find((r) => r.plan_id === "p-team") ?? null;
```

  Adjust the health config shape and `seedRelease` options to what `harness.ts` and `instances-fixtures.ts` really take (Task 0 Step 4); if slice 3 added `rollouts-fixtures.ts` with a ready-made `rolloutHarness`, build on it instead.
- [ ] **Step 2: Write the failing test.** Create `__tests__/team-sync.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { seedLicence } from "./instances-fixtures.js";
import { seedTeamPlan, teamHarness, teamRow } from "./team-fixtures.js";
import { syncPlanInstances, PLAN_RETIRED } from "../plans/sync.js";
import { TEAM_NOT_ORG } from "../plans/team.js";
import { adminsOf } from "../instances/reconciler.js";
import { getApp } from "../repo.js";
import { updatePlan } from "../plans/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const sync = async () => syncPlanInstances(h.deps, (await getApp(h.db, appId))!);

describe("Team plan instances", () => {
  it("one shared row named team; an untyped live licence never keeps a retired Team plan held", async () => {
    await seedTeamPlan(h, appId);
    await seedLicence(h, { appId, kind: null, holder: "0x1111111111111111111111111111111111111111", licenseId: "l1" });
    await sync();
    const row = await teamRow(h, appId);
    expect(row).toMatchObject({ kind: "shared", name: "team", target_version: "1.0.0", stop_reason: null });
    await updatePlan(h.db, "p-team", { status: "retired" }, "2026-10-02T00:00:00.000Z");
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBe(PLAN_RETIRED);
  });

  it("is stopped while the App is no organisation's, and wanted again once it is", async () => {
    await seedTeamPlan(h, appId);
    await sync();
    await h.db.updateTable("apps").set({ owner_org_id: null }).where("id", "=", appId).execute();
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBe(TEAM_NOT_ORG);
    await h.db.updateTable("apps").set({ org_disputed: true, owner_org_id: "org-acme" }).where("id", "=", appId).execute();
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBe(TEAM_NOT_ORG);
    await h.db.updateTable("apps").set({ org_disputed: false }).where("id", "=", appId).execute();
    await sync();
    expect((await teamRow(h, appId))?.stop_reason).toBeNull();
  });

  it("adminsOf prefers the instance's override", async () => {
    await seedTeamPlan(h, appId);
    await sync();
    const app = (await getApp(h.db, appId))!;
    const row = (await teamRow(h, appId))!;
    expect(adminsOf(app, row)).toBe(app.owner_address);
    expect(adminsOf(app, { ...row, admins_override: "0xa1,0xb2" })).toBe("0xa1,0xb2");
  });
});
```

- [ ] **Step 3: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/team-sync.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL (`plans/team.js` missing).
- [ ] **Step 4: `team.ts` (helpers).** Create `plans/team.ts`:

```ts
import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import type { AppRow } from "../repo.js";
import type { PlanRow } from "./repo.js";

/** The Team plan (spec section 5): slug and name; `team` is reserved for it (checkPlanSlug). */
export const TEAM_SLUG = "team";
export const TEAM_NAME = "Team";
export const TEAM_NOT_ORG = "the App is not an organisation's";
export const TEAM_ADMINS_REFRESH_MS = 15 * 60_000;
export const TEAM_ADMINS_MAX = 50;

export const isTeamPlan = (p: Pick<PlanRow, "team">): boolean => p.team === true;

/** Owned by an organisation whose claim Vetra trusts (not disputed). */
export const isOrgApp = (app: Pick<AppRow, "owner_org_id" | "org_disputed">): boolean =>
  !!app.owner_org_id && app.org_disputed !== true;

export async function teamPlanOf(db: Kysely<VetraAppsDB>, appId: string): Promise<PlanRow | null> {
  return (
    (await db
      .selectFrom("plans")
      .selectAll()
      .where("app_id", "=", appId)
      .where("team", "=", true)
      .executeTakeFirst()) ?? null
  );
}

export async function activeTeamPlan(db: Kysely<VetraAppsDB>, appId: string): Promise<PlanRow | null> {
  const p = await teamPlanOf(db, appId);
  return p?.status === "active" ? p : null;
}
```

- [ ] **Step 5: Sync.** In `plans/sync.ts` import `isOrgApp, isTeamPlan, TEAM_NOT_ORG` from `./team.js`, and in the shared loop replace the `held`/`wanted` lines and the patch's `stop_reason`:

```ts
    // A kind-less plan (Team) is never held: untyped licences have kind null too.
    const held = plan.kind !== null && [...live.values()].some((c) => c.kind === plan.kind);
    const notOrg = isTeamPlan(plan) && !isOrgApp(app);
    const wanted = (plan.status === "active" || held) && !notOrg;
```

  and in `patch(row, { … })`: `stop_reason: wanted ? null : notOrg ? TEAM_NOT_ORG : PLAN_RETIRED,`. Exclude Team from `ownPlanResolver`'s `byKind` (already true after Task 2: NULL kinds are skipped).
- [ ] **Step 6: ADMINS.** In `instances/reconciler.ts`:

```ts
/** ADMINS per kind (spec section 5): an override (Team: the org's admins), the holder of an own instance, else the App owner. */
export function adminsOf(app: AppRow, row: InstanceRow): string {
  if (row.admins_override) return row.admins_override;
  return row.kind === "own" && row.holder_address ? row.holder_address : app.owner_address;
}
```

- [ ] **Step 7: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 8: Commit.** `git add subgraphs/vetra-apps/plans subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/__tests__/team-fixtures.ts subgraphs/vetra-apps/__tests__/team-sync.test.ts && git commit -m "feat(plans): Team plan instance (stopped outside an organisation); ADMINS override" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: `enableTeamPlan`, `disableTeamPlan`, and the plan guards

**Files:**
- Modify: `subgraphs/vetra-apps/plans/team.ts`, `subgraphs/vetra-apps/plans/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/team-plan-api.test.ts`

**Interfaces:**
- Produces: `enableTeamPlan(deps, caller, appId, followBranch?: string | null): Promise<PlanJson>`; `disableTeamPlan(deps, caller, appId): Promise<PlanJson>`. `PlanJson.team: boolean`, `PlanJson.kind: string | null`.
- Rules:
  - both: plans enabled, else BAD_USER_INPUT "Plans are not enabled on this Vetra"; `loadAppForOwner(…, { need: "administer" })`;
  - enable: `isOrgApp(app)`, else BAD_USER_INPUT "The Team plan is for organisation Apps"; branch = `followBranch?.trim() || app.production_branch`, a release branch of the App; under `withKeyLock(appInstancesLock(app.id))`, in one transaction with the plan row locked:
    - no Team plan: insert (target NULL: Task 5 gives it its first release in the next pass), audit `plan.team_enabled { branch }`;
    - retired or another branch: update `status = active`, `policy = follow:<branch>`, audit `plan.team_enabled { branch, from?, revived? }`;
    - already active on that branch: return it, no audit.
    - A unique violation (a concurrent enable) → re-read and return the plan.
  - disable: no Team plan → NOT_FOUND "The App has no Team plan"; retired → return it; else `status = retired`, audit `plan.team_disabled { branch }`.
  - `retirePlan` on a Team plan: BAD_USER_INPUT "Disable the Team plan instead (owner and organisation admins)". `updatePlanFor` with `policy` on a Team plan: BAD_USER_INPUT "The Team plan follows its branch; change it with enableTeamPlan".

- [ ] **Step 1: Write the failing test.** Create `__tests__/team-plan-api.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { member, owner, stranger, type Harness } from "./harness.js";
import type { Caller } from "../auth.js";
import { ORG_ADMIN_A, teamHarness } from "./team-fixtures.js";
import { disableTeamPlan, enableTeamPlan } from "../plans/team.js";
import { retirePlan, updatePlanFor, createPlan } from "../plans/service.js";
import { listAudit } from "../audit/repo.js";
import { setAppRole } from "../roles/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const orgAdmin: Caller = { ...member, address: ORG_ADMIN_A };

describe("enableTeamPlan / disableTeamPlan", () => {
  it("one click makes a kind-less shared plan following the production branch; idempotent; audited", async () => {
    const p = await enableTeamPlan(h.deps, orgAdmin, appId);
    expect(p).toMatchObject({ slug: "team", name: "Team", kind: null, team: true, access: "shared", policy: "follow:main", noticeHours: 0, targetVersion: null, status: "active" });
    expect((await enableTeamPlan(h.deps, owner, appId)).id).toBe(p.id);
    const rows = (await listAudit(h.db, appId, { limit: 10 })).filter((a) => a.action === "plan.team_enabled");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ branch: "main" });
  });

  it("refuses members, release managers, strangers, personal Apps and non-release branches", async () => {
    await expect(enableTeamPlan(h.deps, member, appId)).rejects.toThrow(/Not allowed/);
    await expect(enableTeamPlan(h.deps, stranger, appId)).rejects.toThrow();
    await setAppRole(h.deps, owner, appId, member.address);
    await expect(enableTeamPlan(h.deps, member, appId)).rejects.toThrow(/Not allowed/);
    await expect(enableTeamPlan(h.deps, owner, appId, "feature-x")).rejects.toThrow(/release branch/);
    await h.db.updateTable("apps").set({ owner_org_id: null }).where("id", "=", appId).execute();
    await expect(enableTeamPlan(h.deps, owner, appId)).rejects.toThrow(/organisation Apps/);
  });

  it("disable retires it (audited); enable revives the same row on a new branch; retirePlan and policy edits refuse Team", async () => {
    await h.db.updateTable("apps").set({ release_branches: JSON.stringify(["next"]) }).where("id", "=", appId).execute();
    const p = await enableTeamPlan(h.deps, owner, appId);
    await expect(retirePlan(h.deps, owner, p.id)).rejects.toThrow(/Disable the Team plan/);
    await expect(updatePlanFor(h.deps, owner, { planId: p.id, policy: "manual" })).rejects.toThrow(/follows its branch/);
    expect((await disableTeamPlan(h.deps, orgAdmin, appId)).status).toBe("retired");
    const back = await enableTeamPlan(h.deps, owner, appId, "next");
    expect(back).toMatchObject({ id: p.id, status: "active", policy: "follow:next" });
    const actions = (await listAudit(h.db, appId, { limit: 10 })).map((a) => a.action);
    expect(actions.filter((a) => a === "plan.team_disabled")).toHaveLength(1);
    expect(actions.filter((a) => a === "plan.team_enabled")).toHaveLength(2);
  });

  it("createPlan still refuses the slug team", async () => {
    await expect(createPlan(h.deps, owner, { appId, kind: "team", access: "shared" })).rejects.toThrow(/reserved/);
  });
});
```

  (`release_branches` is stored as `parseReleaseBranches` expects; check `releases/branches.ts` and seed it the way `instances-host.test.ts` or `ci-branch-tokens.test.ts` does.)
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/team-plan-api.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `plans/team.ts` add (imports: `withKeyLock` from `../../../shared/key-lock.js`, `appInstancesLock` from `../rollouts/repo.js`, `appsError` from `../errors.js`, `auditCaller` from `../audit/service.js`, `loadAppForOwner, type AppsDeps` from `../service.js`, `plansConfigOf` from `../config.js`, `isReleaseBranch, parseReleaseBranches` from `../releases/branches.js`, `insertPlan, updatePlan, type PlanRow` from `./repo.js`, `planJson, type PlanJson` from `./service.js`, `type Caller` from `../auth.js`):

```ts
const isUniqueViolation = (err: unknown) => (err as { code?: unknown } | null)?.code === "23505";
const branchOf = (p: PlanRow) => (p.policy.startsWith("follow:") ? p.policy.slice(7) : null);

async function lockTeamPlan(trx: Kysely<VetraAppsDB>, appId: string): Promise<PlanRow | null> {
  return (
    (await trx
      .selectFrom("plans")
      .selectAll()
      .where("app_id", "=", appId)
      .where("team", "=", true)
      .forUpdate()
      .executeTakeFirst()) ?? null
  );
}

function requirePlans(deps: AppsDeps) {
  if (!plansConfigOf(deps.cfg).enabled)
    throw appsError("BAD_USER_INPUT", "Plans are not enabled on this Vetra");
}

/**
 * Turns on the App's Team plan (spec section 5; section 10: owner and org
 * admins). One per App; a disabled one is revived with its instance and data.
 * Its first target arrives with the next reconciler pass (syncTeamPlan).
 */
export async function enableTeamPlan(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  followBranch?: string | null,
): Promise<PlanJson> {
  requirePlans(deps);
  const app = await loadAppForOwner(deps, caller, appId, { need: "administer" });
  if (!isOrgApp(app))
    throw appsError("BAD_USER_INPUT", "The Team plan is for organisation Apps");
  const branch = followBranch?.trim() || app.production_branch;
  if (!isReleaseBranch(branch, app.production_branch, parseReleaseBranches(app.release_branches)))
    throw appsError("BAD_USER_INPUT", `${branch} is not a release branch of the App`);
  const policy = `follow:${branch}`;
  const run = () =>
    deps.db.transaction().execute(async (trx) => {
      const nowIso = deps.now().toISOString();
      const cur = await lockTeamPlan(trx, app.id);
      if (cur && cur.status === "active" && cur.policy === policy) return cur;
      const p = cur
        ? await updatePlan(trx, cur.id, { status: "active", policy }, nowIso)
        : await insertPlan(trx, {
            id: deps.newId(),
            app_id: app.id,
            slug: TEAM_SLUG,
            name: TEAM_NAME,
            kind: null,
            team: true,
            access: "shared",
            size: "VETRA_AGENT_S",
            target_version: null,
            policy,
            notice_hours: 0,
            status: "active",
            created_by: caller.address,
            created_at: nowIso,
            updated_at: nowIso,
          } as PlanRow);
      const from = cur ? branchOf(cur) : null;
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "plan.team_enabled",
        subject: `plan:${p.id}`,
        detail: {
          branch,
          ...(from && from !== branch ? { from } : {}),
          ...(cur?.status === "retired" ? { revived: true } : {}),
        },
      });
      return p;
    });
  try {
    return planJson(await withKeyLock(appInstancesLock(app.id), run));
  } catch (err) {
    // A concurrent enable inserted it first (or took the slug team).
    if (!isUniqueViolation(err)) throw err;
    const p = await teamPlanOf(deps.db, app.id);
    if (!p) throw err;
    return planJson(p);
  }
}

/** Turns the Team plan off: its instance stops (data kept); customer rollouts are no longer gated on it (T8). */
export async function disableTeamPlan(deps: AppsDeps, caller: Caller, appId: string): Promise<PlanJson> {
  requirePlans(deps);
  const app = await loadAppForOwner(deps, caller, appId, { need: "administer" });
  return planJson(
    await withKeyLock(appInstancesLock(app.id), () =>
      deps.db.transaction().execute(async (trx) => {
        const cur = await lockTeamPlan(trx, app.id);
        if (!cur) throw appsError("NOT_FOUND", "The App has no Team plan");
        if (cur.status === "retired") return cur;
        const nowIso = deps.now().toISOString();
        const p = await updatePlan(trx, cur.id, { status: "retired" }, nowIso);
        await auditCaller(trx, caller, {
          appId: app.id,
          at: nowIso,
          action: "plan.team_disabled",
          subject: `plan:${p.id}`,
          detail: { branch: branchOf(cur) },
        });
        return p;
      }),
    ),
  );
}
```

  `plans/service.ts` imports `isTeamPlan` from `./team.js` (and `team.ts` imports `planJson` from `./service.js`: move `planJson`/`PlanJson` into a small `plans/json.ts` if the cycle bothers the linter). Changes in `service.ts`:
  - `planJson`: add `team: p.team === true`; `PlanJson.team: boolean`.
  - `retirePlan`: right after `loadPlan`, `if (isTeamPlan(plan)) throw appsError("BAD_USER_INPUT", "Disable the Team plan instead (owner and organisation admins)");`
  - `updatePlanFor`: right after `loadPlan`, `if (isTeamPlan(plan) && input.policy != null) throw appsError("BAD_USER_INPUT", "The Team plan follows its branch; change it with enableTeamPlan");`
- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/plans-api.test.ts subgraphs/vetra-apps/__tests__/plans-audit.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans subgraphs/vetra-apps/__tests__/team-plan-api.test.ts && git commit -m "feat(plans): enable and disable the Team plan (owner and org admins)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: `syncTeamPlan`: first target, ADMINS from Renown, ran-healthy records

**Files:**
- Create: `subgraphs/vetra-apps/plans/team-runs.ts`
- Modify: `subgraphs/vetra-apps/plans/team.ts`, `subgraphs/vetra-apps/instances/reconciler.ts`
- Test: `subgraphs/vetra-apps/__tests__/team-runs.test.ts`

**Interfaces:**
- Produces (`team-runs.ts`):
  - `TeamRunRow = Selectable<TeamReleaseRunsTable>`;
  - `teamRunOf(db, appId, version): Promise<TeamRunRow | null>`; `teamRunsOf(db, appId): Promise<Map<string, TeamRunRow>>` (by version);
  - `qualifiesAsRun(row: InstanceRow, soakMs: number, now: Date): boolean` (pure: `status === "ready"`, `health === "healthy"`, `running_version` and `running_digest` set, `health_digest === running_digest`, `now - Date.parse(health_since) >= soakMs`; an unparsable `health_since` never qualifies);
  - `recordTeamRun(db, row, nowIso): Promise<boolean>` (insert `ON CONFLICT DO NOTHING` + audit `team.ran_healthy` in one transaction; true when it was new).
- Produces (`team.ts`): `syncTeamPlan(deps, app): Promise<void>`. For the App's **active** Team plan only:
  1. **First target.** `target_version` NULL → the newest release (`kind = release`, by `run`, not withdrawn) whose `branch` is the plan's follow branch → `beginRollout(deps, app, v, [plan], { actor: AUDIT_SYSTEM_ACTOR, source: "policy" }, 0)`. A refusal (`GraphQLError`) is written once to `plans.policy_note` (`"<v>: <message>"`), as slice 3's runner does, and logged.
  2. **ADMINS.** Its shared row exists, `isOrgApp(app)`, `deps.orgs?.orgAdmins` exists, and `admins_checked_at` is null or older than `TEAM_ADMINS_REFRESH_MS` → ask Renown. A non-empty list (cut at `TEAM_ADMINS_MAX`) → `override = list.join(",")`; null/empty → `override = null` (`adminsOf` falls back to the owner). A Renown error → keep the override, set nothing (retried next pass). Patch `admins_checked_at` always on an answer, `admins_override` only when it changed, and audit `instance.admins_set { count, fallback }` on a change.
  3. **Ran healthy.** The row `qualifiesAsRun(row, teamSoakMs(cfg), now)` → `recordTeamRun`.
- Changes: `reconcileApp` calls `syncTeamPlan` right after `syncPlanInstances`, inside the same `try`.

- [ ] **Step 1: Write the failing test.** Create `__tests__/team-runs.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORG, type Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import { ORG_ADMIN_A, ORG_ADMIN_B, seedTeamPlan, teamHarness, teamRow } from "./team-fixtures.js";
import { syncPlanInstances } from "../plans/sync.js";
import { syncTeamPlan } from "../plans/team.js";
import { qualifiesAsRun, teamRunOf } from "../plans/team-runs.js";
import { getPlan } from "../plans/repo.js";
import { updateInstance } from "../instances/repo.js";
import { listAudit } from "../audit/repo.js";
import { getApp } from "../repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await teamHarness());
});
afterEach(async () => {
  await h.close();
});
const pass = async () => {
  const app = (await getApp(h.db, appId))!;
  await syncPlanInstances(h.deps, app);
  await syncTeamPlan(h.deps, app);
};
const MIN = 60_000;

describe("syncTeamPlan", () => {
  it("gives a new Team plan the newest release of its branch, as Vetra", async () => {
    await seedTeamPlan(h, appId, { target_version: null });
    await pass();
    expect((await getPlan(h.db, "p-team"))?.target_version).toBe("1.1.0");
    const started = (await listAudit(h.db, appId, { limit: 20 })).find((a) => a.action === "rollout.started");
    expect(started).toMatchObject({ actor: "vetra", source: "policy" });
  });

  it("sets ADMINS to the org's public admins, at most every 15 minutes, only on change; falls back to the owner", async () => {
    await seedTeamPlan(h, appId);
    h.orgs.admins.set(ORG, [ORG_ADMIN_B, ORG_ADMIN_A].sort());
    await pass();
    expect((await teamRow(h, appId))?.admins_override).toBe([ORG_ADMIN_A, ORG_ADMIN_B].sort().join(","));
    h.orgs.admins.set(ORG, [ORG_ADMIN_A]);
    await pass(); // within 15 minutes: not asked
    expect((await teamRow(h, appId))?.admins_override).toContain(ORG_ADMIN_B);
    h.advance(16 * MIN);
    await pass();
    expect((await teamRow(h, appId))?.admins_override).toBe(ORG_ADMIN_A);
    h.orgs.down = true;
    h.advance(16 * MIN);
    await pass(); // Renown down: kept
    expect((await teamRow(h, appId))?.admins_override).toBe(ORG_ADMIN_A);
    h.orgs.down = false;
    h.orgs.admins.set(ORG, null); // members private
    h.advance(16 * MIN);
    await pass();
    expect((await teamRow(h, appId))?.admins_override ?? null).toBeNull();
    const set = (await listAudit(h.db, appId, { limit: 50 })).filter((a) => a.action === "instance.admins_set");
    expect(set).toHaveLength(3);
  });

  it("records a release as ran healthy after the soak, once, audited", async () => {
    await seedTeamPlan(h, appId);
    await pass();
    const row = (await teamRow(h, appId))!;
    const nowIso = h.deps.now().toISOString();
    await updateInstance(h.db, row.id, {
      status: "ready",
      running_version: "1.0.0",
      running_digest: digest("a"),
      health: "healthy",
      health_digest: digest("a"),
      health_since: nowIso,
    }, nowIso);
    h.advance(29 * MIN);
    await pass();
    expect(await teamRunOf(h.db, appId, "1.0.0")).toBeNull();
    h.advance(2 * MIN);
    await pass();
    await pass();
    expect(await teamRunOf(h.db, appId, "1.0.0")).toMatchObject({ digest: digest("a"), instance_id: row.id });
    const ran = (await listAudit(h.db, appId, { limit: 50 })).filter((a) => a.action === "team.ran_healthy");
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ subject: "release:1.0.0", actor: "vetra", source: "system" });
  });

  it("qualifiesAsRun: healthy on the running digest for the soak; never on a bad date", () => {
    const now = new Date("2026-11-12T12:00:00.000Z");
    const base = {
      status: "ready", health: "healthy", running_version: "1.0.0", running_digest: "d",
      health_digest: "d", health_since: "2026-11-12T11:00:00.000Z",
    } as never;
    expect(qualifiesAsRun(base, 30 * MIN, now)).toBe(true);
    expect(qualifiesAsRun({ ...(base as object), health_digest: "e" } as never, 30 * MIN, now)).toBe(false);
    expect(qualifiesAsRun({ ...(base as object), health: "unknown" } as never, 30 * MIN, now)).toBe(false);
    expect(qualifiesAsRun({ ...(base as object), health_since: "soon" } as never, 0, now)).toBe(false);
    expect(qualifiesAsRun(base, 90 * MIN, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/team-runs.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: `team-runs.ts`.**

```ts
import type { Kysely, Selectable } from "kysely";
import type { TeamReleaseRunsTable, VetraAppsDB } from "../db/schema.js";
import type { InstanceRow } from "../instances/repo.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";

export type TeamRunRow = Selectable<TeamReleaseRunsTable>;

export async function teamRunOf(db: Kysely<VetraAppsDB>, appId: string, version: string): Promise<TeamRunRow | null> {
  return (
    (await db
      .selectFrom("team_release_runs")
      .selectAll()
      .where("app_id", "=", appId)
      .where("version", "=", version)
      .executeTakeFirst()) ?? null
  );
}

export async function teamRunsOf(db: Kysely<VetraAppsDB>, appId: string): Promise<Map<string, TeamRunRow>> {
  const rows = await db.selectFrom("team_release_runs").selectAll().where("app_id", "=", appId).execute();
  return new Map(rows.map((r) => [r.version, r]));
}

/** Ready and healthy on what it runs, continuously for the soak (decision T6). */
export function qualifiesAsRun(row: InstanceRow, soakMs: number, now: Date): boolean {
  if (row.status !== "ready" || row.health !== "healthy") return false;
  if (!row.running_version || !row.running_digest || row.health_digest !== row.running_digest) return false;
  const since = Date.parse(row.health_since ?? "");
  return Number.isFinite(since) && now.getTime() - since >= soakMs;
}

/** Records the run once (a repeat is a no-op); true when it was new. */
export async function recordTeamRun(
  db: Kysely<VetraAppsDB>,
  row: InstanceRow,
  soakMinutes: number,
  nowIso: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const res = await trx
      .insertInto("team_release_runs")
      .values({
        app_id: row.app_id,
        version: row.running_version!,
        digest: row.running_digest!,
        instance_id: row.id,
        healthy_since: row.health_since!,
        recorded_at: nowIso,
      })
      .onConflict((oc) => oc.columns(["app_id", "version"]).doNothing())
      .executeTakeFirst();
    if (Number(res.numInsertedOrUpdatedRows ?? 0) === 0) return false;
    await recordAudit(trx, {
      appId: row.app_id,
      at: nowIso,
      actor: AUDIT_SYSTEM_ACTOR,
      source: "system",
      action: "team.ran_healthy",
      subject: `release:${row.running_version}`,
      detail: { digest: row.running_digest, instanceId: row.id, soakMinutes },
    });
    return true;
  });
}
```

  (`recordTeamRun` takes `soakMinutes` for the detail; the Interfaces line above omits it for brevity.)
- [ ] **Step 4: `syncTeamPlan`.** In `plans/team.ts` add (imports: `GraphQLError` from `graphql`, `listReleases` from `../releases/repo.js`, `listInstances, updateInstance` from `../instances/repo.js`, `recordAudit, AUDIT_SYSTEM_ACTOR` from `../audit/repo.js`, `beginRollout` from `../rollouts/service.js`, `teamSoakMs` from `../config.js`, `qualifiesAsRun, recordTeamRun` from `./team-runs.js`):

```ts
const SYSTEM = { actor: AUDIT_SYSTEM_ACTOR, source: "policy" as const };

/**
 * Per reconciler pass, under the App's lock (reconcileApp): the active Team
 * plan's first target, its instance's ADMINS, and its ran-healthy records.
 */
export async function syncTeamPlan(deps: AppsDeps, app: AppRow): Promise<void> {
  const plan = await activeTeamPlan(deps.db, app.id);
  if (!plan) return;
  await firstTarget(deps, app, plan);
  const row = (await listInstances(deps.db, app.id, "shared")).find(
    (r) => r.plan_id === plan.id && !r.removed_at,
  );
  if (!row) return;
  if (isOrgApp(app)) await refreshAdmins(deps, app, row);
  const now = deps.now();
  const soakMs = teamSoakMs(deps.cfg);
  if (qualifiesAsRun(row, soakMs, now))
    await recordTeamRun(deps.db, row, soakMs / 60_000, now.toISOString());
}

async function firstTarget(deps: AppsDeps, app: AppRow, plan: PlanRow): Promise<void> {
  if (plan.target_version) return;
  const branch = plan.policy.startsWith("follow:") ? plan.policy.slice(7) : null;
  if (!branch) return;
  const newest = (await listReleases(deps.db, app.id, { kind: "release", limit: 200 })).find(
    (r) => r.branch === branch && !r.withdrawn_at,
  );
  if (!newest) return;
  try {
    await beginRollout(deps, app, newest.version, [plan], SYSTEM, 0);
  } catch (err) {
    if (!(err instanceof GraphQLError)) throw err;
    const note = `${newest.version}: ${err.message}`.slice(0, 500);
    if (plan.policy_note === note) return;
    deps.logger.warn(`[vetra-apps] Team plan of ${app.slug}: ${note}`);
    await updatePlan(deps.db, plan.id, { policy_note: note }, deps.now().toISOString());
  }
}

async function refreshAdmins(deps: AppsDeps, app: AppRow, row: InstanceRow): Promise<void> {
  const read = deps.orgs?.orgAdmins;
  if (!read || !app.owner_org_id) return;
  const checked = Date.parse(row.admins_checked_at ?? "");
  if (Number.isFinite(checked) && deps.now().getTime() - checked < TEAM_ADMINS_REFRESH_MS) return;
  let list: string[] | null;
  try {
    list = await read.call(deps.orgs, app.owner_org_id);
  } catch {
    return; // Renown down: keep the last list, ask again next pass.
  }
  const nowIso = deps.now().toISOString();
  const override = list && list.length > 0 ? list.slice(0, TEAM_ADMINS_MAX).join(",") : null;
  if ((row.admins_override ?? null) === override) {
    await updateInstance(deps.db, row.id, { admins_checked_at: nowIso }, nowIso);
    return;
  }
  await deps.db.transaction().execute(async (trx) => {
    await updateInstance(trx, row.id, { admins_override: override, admins_checked_at: nowIso }, nowIso);
    await recordAudit(trx, {
      appId: app.id,
      at: nowIso,
      actor: AUDIT_SYSTEM_ACTOR,
      source: "system",
      action: "instance.admins_set",
      subject: `instance:${row.id}`,
      detail: { count: override ? override.split(",").length : 1, fallback: override === null },
    });
  });
}
```

  `withdrawn_at` and `policy_note` are slice 3's optional columns; if either is missing, slice 3 is not merged (Task 0 Step 1).
- [ ] **Step 5: Wire it.** In `instances/reconciler.ts` `reconcileApp`, inside the `try` that calls `syncPlanInstances`, add `await syncTeamPlan(deps, app);` right after it (import from `../plans/team.js`). Slice 3's `advanceRollouts` call stays where slice 3 put it (after plan sync): a first-target rollout with no instance completes at once.
- [ ] **Step 6: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/instances-plans.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS.
- [ ] **Step 7: Commit.** `git add subgraphs/vetra-apps/plans subgraphs/vetra-apps/instances/reconciler.ts subgraphs/vetra-apps/__tests__/team-runs.test.ts && git commit -m "feat(plans): Team plan first target, ADMINS from Renown, ran-healthy records" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Customer rollouts need a healthy run on Team

**Files:**
- Modify: `subgraphs/vetra-apps/rollouts/check.ts`, `subgraphs/vetra-apps/rollouts/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/team-rollout-gate.test.ts`

**Interfaces:**
- Changes: `teamGateProblem(deps, appId, version, plans: Pick<PlanRow, "slug" | "team" | "target_version">[]): Promise<string | null>`; `rolloutProblems` passes its `plans`.
  - Only Team plans in the rollout → null (spec 7 step 1: the Team plan itself is exempt).
  - No **active** Team plan → null (T8).
  - Team and customer plans together → `"roll ${version} out to Team on its own first; customer plans follow once it ran healthy there"` (T7).
  - Customer plans for which `version` is a stable patch of their target (`isPatchOf`) need nothing (T5); if every customer plan is such → null.
  - `teamRunOf(appId, version)` → null; else `"${version} has not run healthy on Team yet (${slugs}); Team runs ${running ?? "nothing"} and needs ${soak} minutes healthy on ${version}"`.
- Produces (`check.ts`): `isPatchOf(version, from: string | null): boolean` (both releases, `from` set, same major and minor, `version` has no prerelease, `version` patch > `from` patch).

- [ ] **Step 1: Write the failing test.** Create `__tests__/team-rollout-gate.test.ts`, using `seedPlan` from slice 3's `rollouts-fixtures.ts` when it fits (else `insertPlan` directly):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { seedTeamPlan, teamHarness } from "./team-fixtures.js";
import { checkRolloutFor } from "../rollouts/service.js";
import { isPatchOf } from "../rollouts/check.js";
import { insertPlan, updatePlan } from "../plans/repo.js";

let h: Harness;
let appId: string;
const customer = (id: string, slug: string, target: string) =>
  insertPlan(h.db, {
    id, app_id: appId, slug, name: slug, kind: slug, access: "own", size: "VETRA_AGENT_S",
    target_version: target, policy: "manual", notice_hours: 72, status: "active",
    created_by: owner.address, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
  } as never);
const problems = async (version: string, planIds: string[]) =>
  (await checkRolloutFor(h.deps, owner, appId, version, planIds)).problems;
const ran = (version: string) =>
  h.db.insertInto("team_release_runs").values({
    app_id: appId, version, digest: "d", instance_id: "i", healthy_since: "t", recorded_at: "t",
  }).execute();

beforeEach(async () => {
  ({ h, appId } = await teamHarness());
  await seedRelease(h, appId, { version: "1.0.1", run: 102, kind: "release", digest: digest("c") });
  await seedRelease(h, appId, { version: "2.0.0", run: 103, kind: "release", digest: digest("e") });
  await customer("p-pro", "pro", "1.0.0");
});
afterEach(async () => {
  await h.close();
});

describe("the Team gate on customer rollouts", () => {
  it("no Team plan, or a disabled one: no gate", async () => {
    expect((await problems("1.1.0", ["p-pro"])).join()).not.toMatch(/Team/);
    await seedTeamPlan(h, appId, { status: "retired" });
    expect((await problems("1.1.0", ["p-pro"])).join()).not.toMatch(/Team/);
  });

  it("refuses a release Team never ran, with the reason; passes once it ran", async () => {
    await seedTeamPlan(h, appId);
    expect((await problems("1.1.0", ["p-pro"])).join()).toMatch(/1\.1\.0 has not run healthy on Team yet/);
    await ran("1.1.0");
    expect((await problems("1.1.0", ["p-pro"])).join()).not.toMatch(/Team/);
  });

  it("Team itself is exempt; Team with customers is refused; stable patches pass (T5)", async () => {
    await seedTeamPlan(h, appId);
    expect((await problems("2.0.0", ["p-team"])).join()).not.toMatch(/Team/);
    expect((await problems("2.0.0", ["p-team", "p-pro"])).join()).toMatch(/Team on its own first/);
    expect((await problems("1.0.1", ["p-pro"])).join()).not.toMatch(/Team/);
    await updatePlan(h.db, "p-pro", { target_version: "1.1.0" }, "2026-10-02T00:00:00.000Z");
    expect((await problems("2.0.0", ["p-pro"])).join()).toMatch(/has not run healthy on Team/);
  });

  it("isPatchOf", () => {
    expect(isPatchOf("1.4.1", "1.4.0")).toBe(true);
    expect(isPatchOf("1.5.0", "1.4.0")).toBe(false);
    expect(isPatchOf("1.4.1-rc.1", "1.4.0")).toBe(false);
    expect(isPatchOf("1.4.0", "1.4.0")).toBe(false);
    expect(isPatchOf("1.4.1", null)).toBe(false);
  });
});
```

  The test only looks at the Team problem; other problems slice 3 reports (health mode, "already run") may appear and are ignored.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/team-rollout-gate.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `rollouts/check.ts` (imports: `parseVersion`, `versionKind` from `../releases/version.js`; `activeTeamPlan` from `../plans/team.js`; `teamRunOf` from `../plans/team-runs.js`; `listInstances` from `../instances/repo.js`; `teamSoakMs` from `../config.js`):

```ts
/** A stable patch on the same major.minor, above `from` (decision T5 of slice 6). */
export function isPatchOf(version: string, from: string | null): boolean {
  if (!from || versionKind(version) !== "release" || versionKind(from) !== "release") return false;
  const v = parseVersion(version)!;
  const f = parseVersion(from)!;
  return v.prerelease.length === 0 && v.major === f.major && v.minor === f.minor && v.patch > f.patch;
}

/**
 * Spec 7 step 1: when the App has a Team plan, a customer rollout needs the
 * release to have run healthy on the Team instance (the Team plan itself is
 * exempt; stable patches of a plan's line too, decision T5).
 */
export async function teamGateProblem(
  deps: AppsDeps,
  appId: string,
  version: string,
  plans: Pick<PlanRow, "slug" | "team" | "target_version">[],
): Promise<string | null> {
  const customers = plans.filter((p) => p.team !== true);
  if (customers.length === 0) return null;
  const team = await activeTeamPlan(deps.db, appId);
  if (!team) return null;
  if (customers.length < plans.length)
    return `roll ${version} out to Team on its own first; customer plans follow once it ran healthy there`;
  const gated = customers.filter((p) => !isPatchOf(version, p.target_version));
  if (gated.length === 0) return null;
  if (await teamRunOf(deps.db, appId, version)) return null;
  const row = (await listInstances(deps.db, appId, "shared")).find((r) => r.plan_id === team.id);
  const soak = teamSoakMs(deps.cfg) / 60_000;
  return `${version} has not run healthy on Team yet (${gated.map((p) => p.slug).join(", ")}); Team runs ${row?.running_version ?? "nothing"} and needs ${soak} minutes healthy on ${version}`;
}
```

  In `rollouts/service.ts` `rolloutProblems`: `const team = await teamGateProblem(deps, app.id, version, plans);`.
- [ ] **Step 4: Run it again.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/rollouts-check.test.ts subgraphs/vetra-apps/__tests__/rollouts-start.test.ts subgraphs/vetra-apps/__tests__/rollouts-policies.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: PASS (slice 3's tests have no Team plan, so nothing changes for them; update a direct `teamGateProblem(deps, appId, version)` call in `rollouts-check.test.ts`, if any, to pass `[]`).
- [ ] **Step 5: A policy rollout waits, then starts.** Append to `team-rollout-gate.test.ts`:

```ts
  it("a patches/minor customer policy is refused (noted once) until Team ran the release, then starts by itself", async () => {
    await seedTeamPlan(h, appId);
    await updatePlan(h.db, "p-pro", { policy: "minor" }, "2026-10-02T00:00:00.000Z");
    const { advanceRollouts } = await import("../rollouts/runner.js");
    const { getApp } = await import("../repo.js");
    const { getPlan } = await import("../plans/repo.js");
    const { listRollouts } = await import("../rollouts/repo.js");
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    expect((await getPlan(h.db, "p-pro"))?.policy_note).toMatch(/has not run healthy on Team/);
    await ran("1.1.0");
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    expect((await listRollouts(h.db, appId, 10)).map((r) => r.version)).toContain("1.1.0");
  });
```

  Run the file again. Expected: PASS (slice 3's runner retries a refused candidate each pass).
- [ ] **Step 6: Commit.** `git add subgraphs/vetra-apps/rollouts subgraphs/vetra-apps/__tests__/team-rollout-gate.test.ts && git commit -m "feat(rollouts): customer rollouts need a healthy run on Team" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: The gate admits the organisation's members on the Team instance (needs slice 5)

**Files:**
- Create: `subgraphs/vetra-apps/plans/team-gate.ts`
- Modify: slice 5's gate decision module (`gateDecision` here)
- Test: `subgraphs/vetra-apps/__tests__/team-gate.test.ts`

**Interfaces:**
- Produces: `teamGateAnswer(deps, app: AppRow, address: string): Promise<{ allowed: boolean; reason: "member" | "none" }>`. `isOrgApp(app)` false → `{ allowed: false, reason: "none" }`. Else `deps.orgs.membership(app.owner_org_id, address)` (Renown's ACTIVE membership; cached by the client): a membership → `member`; null → `none`. A `RenownOrgsUnavailableError` (or no `deps.orgs`) is **thrown**, so the route answers 503 and the host keeps its 24 h grace for known members.
- Changes: in `gateDecision`, after the token resolved to `(instance, plan, app)` and after the `admin` answer, `if (plan.team === true) { const a = await teamGateAnswer(deps, app, address); return { ...a, until: null, ttlSeconds: 60 }; }` before any licence lookup. A retired Team plan answers like a retired shared plan does in slice 5 (its instance is stopped anyway).

- [ ] **Step 1: Write the failing test.** Create `__tests__/team-gate.test.ts`. It calls the route the way slice 5's own route test does (copy its request helper: the token of the instance from `instance_gate_tokens` setup, `POST apps/gate/check`). Cases:
  - `ORG_MEMBER` → `200 { allowed: true, reason: "member", until: null, ttlSeconds: 60 }`;
  - an `ADMINS` address (the override from Task 5, or the owner) → `reason: "admin"` (slice 5's admin branch runs first);
  - a stranger → `200 { allowed: false, reason: "none" }`;
  - a stranger who holds a live licence of some other plan's kind → still `none` (Team answers membership only);
  - `h.orgs.down = true` → 503;
  - the App moved out of the org (`owner_org_id = null`) → `ORG_MEMBER` gets `none`.

  And a unit test of `teamGateAnswer` alone with the same cases (no HTTP), so the behaviour is pinned even if the route test helper moves.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/team-gate.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement** `plans/team-gate.ts`:

```ts
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { RenownOrgsUnavailableError } from "../../../shared/renown-orgs.js";
import { isOrgApp } from "./team.js";

/**
 * The licence gate's answer for the Team instance (decision D8): the owning
 * organisation's ACTIVE members get in (decision T3). Per address, never a
 * member list. Renown failures throw: the gate answers 503 and the host keeps
 * its grace for people it admitted before.
 */
export async function teamGateAnswer(
  deps: AppsDeps,
  app: AppRow,
  address: string,
): Promise<{ allowed: boolean; reason: "member" | "none" }> {
  if (!isOrgApp(app)) return { allowed: false, reason: "none" };
  if (!deps.orgs) throw new RenownOrgsUnavailableError("Renown organisations are not configured");
  const m = await deps.orgs.membership(app.owner_org_id!, address.toLowerCase());
  return m ? { allowed: true, reason: "member" } : { allowed: false, reason: "none" };
}
```

  Then the one-branch change in `gateDecision`. Check that slice 5's route maps any thrown error to 503 (its contract); if it maps only its own errors, add `RenownOrgsUnavailableError` to them.
- [ ] **Step 4: Run it again.** Same command, plus slice 5's gate tests. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/plans/team-gate.ts <slice 5 gate module> subgraphs/vetra-apps/__tests__/team-gate.test.ts && git commit -m "feat(gate): the Team instance admits the organisation's members" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: GraphQL

**Files:**
- Modify: `subgraphs/vetra-apps/schema.ts`, `subgraphs/vetra-apps/resolvers.ts`, `subgraphs/vetra-apps/releases/service.ts`
- Test: `subgraphs/vetra-apps/__tests__/team-graphql.test.ts`, `subgraphs/vetra-apps/__tests__/resolvers.test.ts` ("SDL" covers the new fields)

**Interfaces:**
- SDL:
  - `AppPlan`: `kind: String` (nullable now; description `"The licensing term adopted; null for the Team plan"`), `"The App's Team plan (organisation members; follows a branch)" team: Boolean!`; the `policy` description mentions `follow:<branch>` (slice 3 already does).
  - `AppRelease`: `"When this release ran healthy on the App's Team instance (customer rollouts need it)" teamHealthyAt: String`.
  - Mutations: `"Owner and organisation admins: turn on the Team plan (organisation Apps), following a release branch (default: the production branch)" enableTeamPlan(appId: ID!, followBranch: String): AppPlan!` and `"Owner and organisation admins: turn the Team plan off (its instance stops; data kept)" disableTeamPlan(appId: ID!): AppPlan!`.
- Resolvers: both with `guard(deps, name, () => enableTeamPlan(deps, person(ctx), appId, followBranch))` (audited callers: `person(ctx)`).
- `appReleasesFor`: one `teamRunsOf(db, appId)` per call; `ReleaseJson.teamHealthyAt = runs.get(version)?.recorded_at ?? null`.

- [ ] **Step 1: Write the failing test.** `team-graphql.test.ts`: through `createResolvers(h.deps)`, as `audit-graphql.test.ts` does: `enableTeamPlan` by an org admin returns `{ team: true, kind: null, policy: "follow:main" }`; `appPlans` lists it; `appReleases` shows `teamHealthyAt` for a version with a `team_release_runs` row and null for others; `disableTeamPlan` by a plain member is FORBIDDEN; the audit row's source is `console` when the request's `Origin` is `https://vetra.io`.
- [ ] **Step 2: Run it.** `npx vitest run subgraphs/vetra-apps/__tests__/team-graphql.test.ts subgraphs/vetra-apps/__tests__/resolvers.test.ts 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: FAIL.
- [ ] **Step 3: Implement** the SDL, resolvers and `teamHealthyAt`.
- [ ] **Step 4: Run it again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/schema.ts subgraphs/vetra-apps/resolvers.ts subgraphs/vetra-apps/releases/service.ts subgraphs/vetra-apps/__tests__/team-graphql.test.ts && git commit -m "feat(apps): Team plan in GraphQL (enable, disable, team runs on releases)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 9: Full checks, PR

- [ ] **Step 1: Full checks.**
  - `npm run tsc 2>&1 | tail -20`
  - `npm run lint 2>&1 | grep -E "error|✖" | head -20`
  - `npx vitest run subgraphs/vetra-apps subgraphs/vetra-licensing shared 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`

  Expected: nothing new compared with Task 0's baseline.
- [ ] **Step 2: PR.** `git push -u origin feat/releases-phase-3-team-plan` and `gh pr create --title "feat(apps): Team plan (releases phase 3, slice 6)"`. The body covers what ships, decisions T1-T12 as built, the schema relaxation (`plans.kind` nullable), the new env value `VETRA_APPS_TEAM_SOAK_MINUTES` (default 30), the slice 3 and slice 5 seams touched, and the staging steps below. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. The user merges.

---

### Task 10: Staging verification (needs the user; no code)

- [ ] **Step 1: Pin staging** (`powerhouse-k8s-hosting`, `tenants/staging/…`, two places). Staging already runs `VETRA_APPS_PLANS=on` and health `enforce` (slice 3). Optionally `VETRA_APPS_TEAM_SOAK_MINUTES: "10"` on staging to shorten the test.
- [ ] **Step 2: An org-owned staging App.** The staging canary App (`96e56853-7041-4c32-a8f7-e9cc8afb50d4`) if it is org-owned, else one the user moves into a staging Renown org. Its host image must be built on the Powerhouse version with the gate (slice 5, D9). Three identities: **A** an org ADMIN, **M** a plain MEMBER, **S** a stranger. Make the org's members public in Renown (to see `ADMINS` from the list), then later private (to see the fallback).
- [ ] **Step 3: Turn Team on.** As M: `enableTeamPlan(appId)` → FORBIDDEN. As A: `enableTeamPlan(appId)` → `team: true`, `policy: "follow:main"`. Within a pass or two: `appPlans` shows the target (the newest `main` release), `appInstances` shows `team` READY at `https://<app>-team-<h>-stg.vetra.io`. `tenants/<tenant>/powerhouse-values.yaml` has `ADMINS` = the org's public OWNER/ADMIN addresses.
- [ ] **Step 4: The gate.** In a browser: M signs in to the Team instance and gets in; S gets 403. Remove M from the org in Renown; within about a minute M is refused.
- [ ] **Step 5: The rollout gate.** Make a customer plan (shared or own) on the App on the same release. Publish `x.(y+1).0` from `main`. Before Team has run it for the soak: `checkRollout(appId, version, [customer plan])` lists "has not run healthy on Team yet"; `startRollout` refuses with that reason. Wait for Team to update by itself (follow policy) and the soak: `appReleases` shows `teamHealthyAt`, the audit has `team.ran_healthy`, and the customer rollout starts. Publish a stable patch `x.(y+1).1`: the customer rollout is allowed before Team ran it (T5).
- [ ] **Step 6: Disable and revive.** As A: `disableTeamPlan` → the Team instance is STOPPED; a customer rollout of a version Team never ran is now allowed. `enableTeamPlan` again → the same instance wakes with its data.
- [ ] **Step 7: Record** the results in the PR. Production pin follows the Sektar rollout check (Global Constraints); production enables Team only once slices 3 and 5 are on in production (D10).

---

### Task 11: Console follow-up (vetra.to; separate PR after staging works; no code here)

On a `feat/app-team-plan` branch in vetra.to, after Task 10 passes:
- **Types.** `npm run codegen` (new fields, `AppPlan.kind` nullable: fix every `plan.kind` use in `modules/apps` to handle null).
- **App page, Plans tab.** For org Apps, with `appAccess.administer`: a "Team" card on top of the plans list. Off: one button "Turn on Team" with a branch picker (release branches, default the production branch) and one sentence: "A private instance for your organisation's members. New releases from this branch update it automatically, and customers only get a release after it ran healthy here." On: the instance URL and status, the branch, "Change branch", "Turn off" (confirm: "The Team instance stops; customer rollouts are no longer checked against it."). Personal Apps: the card explains that Team is for organisation Apps.
- **Releases tab.** A "Ran on Team" badge with `teamHealthyAt` per release; the Roll out dialog shows the Team problem from `checkRollout` as the reason the button is disabled.
- **People.** `ADMINS` are shown as Renown names and pictures (`usePersonName`), never raw addresses (memory: names from Renown).
- **Members** reach the Team instance from the App page (they may view it); no "My instances" entry (T12).

---

## Self-review

- **Spec coverage:**
  - Section 5 "Team plan": optional, off by default, one click on the App page (Tasks 4, 8, 11), org apps only (Task 4, T9), no codes or grants (kind-less, T1), admits the org's members (Task 7, D8 instead of `ACCESS=members`, T3), a release must run healthy before a customer rollout (Tasks 5, 6).
  - Section 5 "What every instance runs" `ADMINS` "the org's admins" (Task 5, T4). Instance host `sektar-team` (unchanged `planInstanceLabel`, slug `team`).
  - Section 7 `follow <branch>` for Team (slice 3 runner; Task 5 first target), step 1 "the Team plan itself is exempt" (Task 6).
  - Section 10 "Turn on the Team plan: owner and org admins", audited (Task 4, `need: "administer"`; T2 closes the `retirePlan` bypass).
  - Section 12 rows 3, 4, 6: Team follows `next` and moves with each release (slice 3 policy); row ‖ needs T5; row 6 needs Team to follow `main` by then (T11, Task 11 "Change branch").
  - Overview slice 6: `plans.team`, kind-less, `enableTeamPlan(appId, followBranch)`/`disableTeamPlan`, membership per address cached, `ADMINS` with the owner fallback, rollout check with health history and an audit row, staging steps. Kept: no member lists (risk).
- **Cross-slice seams:** slice 3: `teamGateProblem` (signature extended by one argument, one call site), `beginRollout`, `appInstancesLock`, `policy_note`, `withdrawn_at`. Slice 5: one branch in its decision function plus the 503 mapping. Slice 7: `instances.admins_override` is the place for support access.
- **Hot path:** an App without Team: `activeTeamPlan` (one indexed read) per pass and per rollout check. An App with Team: Renown at most every 15 minutes per App, a `team_release_runs` insert only once per version.
- **Type consistency:** `PlanRow.kind: string | null` everywhere (`PlanJson`, SDL, licensing's reader); `PlanRow.team?: boolean | null` read through `isTeamPlan`; `TeamRunRow` used by `teamRunOf`, `teamRunsOf`, `appReleasesFor`.
