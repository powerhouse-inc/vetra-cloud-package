# App Warm Pool (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publishers can keep N warm environments per DEDICATED template; a licence claims one instead of a cold build; plus observability auth, provisioning on redeem, and the included AI key for app environments.

**Architecture:** A new `app_warm_pool` table and an `AppWarmPoolKeeper` in `subgraphs/vetra-licensing` (shaped like the Studio pool) create ownerless, service-protected, ingress-closed environments from the template; `provisionChain` claims one in a `FOR UPDATE SKIP LOCKED` transaction and rolls the claim forward through the existing floor update. Gitops learns which documents are warm through a `WarmPoolLookup` resolver.

**Tech Stack:** TypeScript (Node 24), pnpm 10, vitest, Kysely on Postgres (PGlite in tests), Powerhouse document models (`ph-cli generate`), oxlint.

**Spec:** `docs/superpowers/specs/2026-11-02-app-warm-pool-design.md` (read it before any task).

## Global Constraints

- Default pool size is 0 / null; with every template at 0 or null, behaviour is byte-for-byte today's (no rows, no keeper work, cold path unchanged).
- `warmPoolSize` is nullable `Int` in state, never written by `ADD_TEMPLATE`, never part of `TemplateShape` / `templateHash`.
- Maximum 10 per template in the model (`WarmPoolTooLargeError`); keeper also caps at `APP_WARM_POOL_MAX_PER_TEMPLATE` (default 10, may only lower).
- Keeper interval `APP_WARM_POOL_SCAN_INTERVAL_MS` default 30000; creations per tick `APP_WARM_POOL_CREATES_PER_TICK` default 3.
- Warm environment label: `<app name> (warm)`.
- Closed-ingress annotation, exactly: `traefik.ingress.kubernetes.io/router.middlewares: vetra-system-warm-closed@kubernetescrd`.
- App AI key name: `app:<environmentId>`; secret name `OPENROUTER_API_KEY`; budget = the redeemed invite code's `llm_budget_usd`.
- Pricing: €40 per unit; unit = 2 vCPU / 4 GB; `units(size) = ceil(max(vCPU/2, GB/4)) + 1`.
- Never edit `gen/`. Reducer error tests read `operation.error`, never `.toThrow()`. Reducer coverage stays ≥ 95% (`pnpm test:coverage`).
- Commands: one file `pnpm vitest run <path>`; all `pnpm test`; `pnpm tsc`; `pnpm lint`; `pnpm format:check`.

## Review Focus

1. A claim racing a keeper recycle of the same row (new release lands mid-claim): the claim must win or cleanly fall back to cold, never leave a licence with a deleted environment. → test in Task 8.
2. A process crash between the claim transaction and the owner/ADMINS write: the next tick must finish the claim, not treat the row as done. → test in Task 8.
3. Publisher lowers the pool size while some warm environments are WARMING: surplus is removed WARMING-first and nothing CLAIMED is ever touched. → test in Task 7.
4. Observability called for an environment by its licence holder right after a warm claim but before `SET_OWNER` lands: returns FORBIDDEN (not a crash), and the same call after the claim succeeds. → test in Task 1.
5. Redeem succeeds but immediate provisioning throws: the redeem result is unaffected and the handler's next tick still provisions. → test in Task 2.

---

### Task 1: Observability queries require access

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/resolvers.ts:172-217` (`environmentStatus`, `environmentPods`, `environmentEvents`)
- Test: `subgraphs/vetra-cloud-observability/__tests__/resolvers.test.ts`

**Interfaces:**
- Consumes: `access.canView(caller, envRow)` (`env-access.ts:17`), `callerIsAdmin(ctx, address)` (`shared/admins.ts:10`), `envDb` `environments` table looked up **by `tenantId`**.
- Produces: the three queries throw `UNAUTHENTICATED` (no caller), `ENV_NOT_FOUND` (no row for the tenant), `FORBIDDEN` (not `canView`), exactly as `updateEnvironmentToLatest` (`resolvers.ts:974-1004`) does.

- [ ] **Step 1: Write the failing tests** in `resolvers.test.ts`, one `describe("observability access")`:
  - `it("refuses an anonymous caller")`: each of the three with no `ctx.user` rejects with `"UNAUTHENTICATED"`.
  - `it("refuses a signed-in stranger")`: caller `0xabc`, env owner `0xdef` → `"FORBIDDEN"`.
  - `it("serves the owner")`: caller = owner → resolves the stubbed status/pods/events.
  - `it("serves an admin")`: `callerIsAdmin` true → resolves.
  - `it("refuses an unowned environment to its future holder")` (Review Focus 4): env row with `owner: null` → `"FORBIDDEN"` for any non-admin.
- [ ] **Step 2: Run** `pnpm vitest run subgraphs/vetra-cloud-observability/__tests__/resolvers.test.ts`. Expected: the new tests FAIL (queries currently resolve for anyone).
- [ ] **Step 3: Implement** a local `async function assertCanView(ctx: AuthAwareContext, tenantId: string): Promise<void>` in `resolvers.ts` (select `owner`, `ownerOrgId`, `appId` by `tenantId`) and call it first in each of the three resolvers (add the `ctx` parameter).
- [ ] **Step 4: Run** the test file. Expected: PASS. Then `pnpm tsc` and `pnpm lint`: clean.
- [ ] **Step 5: Commit** `fix(observability): environment status, pods and events need the caller to see the environment`.

### Task 2: Provision immediately on redeem and grant

**Files:**
- Modify: `subgraphs/vetra-licensing/subscriptions-resolvers.ts:32-46,271-293`, `subgraphs/vetra-licensing/publisher-resolvers.ts:42,584-596`, `subgraphs/vetra-licensing/index.ts:295,514-540`
- Test: `subgraphs/vetra-licensing/__tests__/subscriptions-api.test.ts`, `__tests__/publisher-api.test.ts`

**Interfaces:**
- Produces: optional dep `onLicenceIssued?: (licenseId: string) => void` on `SubscriptionDeps` and `PublisherDeps`. In `index.ts` it is a late-bound function that calls `void handler.reconcileOnce()` once the handler exists (no-op before), swallowing and logging errors.

- [ ] **Step 1: Write the failing tests:**
  - `it("kicks provisioning after a successful redeem")`: `onLicenceIssued` spy called once with the returned `licenseId`.
  - `it("does not kick on a refused code")`: spy not called.
  - `it("returns the redeem result even if the kick throws")` (Review Focus 5): `onLicenceIssued` throws → resolver still resolves normally.
  - Same three for `grantLicense` in `publisher-api.test.ts`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement**: after a successful `redeemInviteCode(...)` / `grantLicense(...)`, `try { deps.onLicenceIssued?.(result.licenseId) } catch (e) { logger.warn(...) }`. Wire in `index.ts`: `let kick = (_: string) => {}` passed into both deps; after `new AppLicenseHandler(...)` set `kick = () => { void handler.reconcileOnce().catch(log) }`. `reconcileOnce`'s existing `running` guard prevents overlap.
- [ ] **Step 4: Run** both files, then `pnpm vitest run subgraphs/vetra-licensing`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(licensing): a new licence is provisioned at once, not on the next tick`.

### Task 3: `warmPoolSize` on the template (document model + publisher API)

**Files:**
- Modify: `document-models/vetra-app/vetra-app.json:162-190` (op `op-set-template-details`: schema, reducer string, errors), `document-models/vetra-app/v1/schema.graphql:92-102,213-221`, `document-models/vetra-app/v1/src/reducers/licensing.ts:48-65`
- Regenerate: `pnpm generate` (updates `v1/gen/**`; commit them)
- Modify: `subgraphs/vetra-licensing/app-reads.ts:15-24,111-146` (`AppTemplateView.warmPoolSize: number`, null → 0; **not** in `TemplateShape`), `publisher-schema.ts:66-81,183-192`, `publisher-resolvers.ts:406-445`
- Test: `document-models/vetra-app/v1/tests/licensing.test.ts`, `v1/tests/spec-sync.test.ts` (must stay green), `subgraphs/vetra-licensing/__tests__/app-reads.test.ts`, `__tests__/licensing-ledger.test.ts`, `__tests__/publisher-api.test.ts`

**Interfaces:**
- Produces: state `VetraAppEnvironmentTemplate.warmPoolSize: Int` (nullable); input `SetTemplateDetailsInput.warmPoolSize: Int`; errors `WarmPoolNotDedicatedError` (code `WARM_POOL_NOT_DEDICATED`), `WarmPoolTooLargeError` (`WARM_POOL_TOO_LARGE`), `WarmPoolInvalidSizeError` (`WARM_POOL_INVALID_SIZE`); `AppTemplateView.warmPoolSize: number`; publisher `PublisherTemplate.warmPoolSize: Int!`.

- [ ] **Step 1: Write the failing reducer tests** (`licensing.test.ts`):
  - sets `warmPoolSize: 3` on a DEDICATED template → state `3`.
  - `warmPoolSize: 11` → `operations.global[n].error` matches `WarmPoolTooLargeError` message; state unchanged.
  - `warmPoolSize: -1` → `WarmPoolInvalidSizeError`.
  - `warmPoolSize: 1` on a SHARED template → `WarmPoolNotDedicatedError`.
  - template at size 2, then `mode: "SHARED"` in the same op → `WarmPoolNotDedicatedError`.
  - `ADD_TEMPLATE` leaves `warmPoolSize` undefined (absent key).
- [ ] **Step 2: Write the failing ledger test** (`licensing-ledger.test.ts`): an app document whose templates were added before this change hashes the same after re-reduce (no `warmPoolSize` key appears).
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement**: schema + JSON spec + reducer (same reducer string in JSON and `src`), then `pnpm generate`. Reducer order: validate range first (`< 0` → invalid, `> 10` → too large), then mode (resulting mode SHARED with resulting size > 0 → not dedicated). `parseTemplateView` maps null/undefined → 0. Publisher schema/resolver expose it and accept it in `setTemplateDetails`.
- [ ] **Step 5: Run** `pnpm vitest run document-models/vetra-app subgraphs/vetra-licensing`, `pnpm test:coverage` (≥ 95%), `pnpm tsc`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(vetra-app): a template keeps a warm pool size`.

### Task 4: `app_warm_pool` table and its store

**Files:**
- Modify: `subgraphs/vetra-licensing/db/migrations.ts` (in `up()`, after the `license_environments` block `:154-174`), `db/schema.ts` (`VetraLicensingDB`)
- Create: `subgraphs/vetra-licensing/warm-pool-db.ts`
- Test: `__tests__/migrations.test.ts`, create `__tests__/warm-pool-db.test.ts` (PGlite)

**Interfaces:**
- Produces, in `warm-pool-db.ts`:
  - `type WarmState = "WARMING" | "AVAILABLE" | "CLAIMED"`
  - `interface WarmRow { environment_id: string; app_id: string; template_id: string; template_hash: string; state: WarmState; created_at: string; ready_at: string | null; claimed_at: string | null; deleted_at: string | null; root_license_id: string | null }`
  - `createWarmPoolStore(db: Kysely<VetraLicensingDB>): WarmPoolStore` with
    - `insertWarming(row: { environmentId; appId; templateId; templateHash; nowIso }): Promise<void>`
    - `live(appId: string, templateId: string): Promise<WarmRow[]>` (not deleted)
    - `allLive(): Promise<WarmRow[]>`
    - `markAvailable(environmentId: string, nowIso: string): Promise<void>`
    - `markDeleted(environmentId: string, nowIso: string): Promise<void>`
    - `claimOneAvailable(q: { appId; templateId; templateHash; rootLicenseId; nowIso }): Promise<WarmRow | null>` (one transaction, `FOR UPDATE SKIP LOCKED`, ordered by `ready_at`, sets `CLAIMED`, `claimed_at`, `root_license_id`)
    - `releaseClaim(environmentId: string): Promise<void>` (back to `AVAILABLE`, clears claim fields)
    - `isWarm(environmentId: string): Promise<{ appId: string } | null>` (live and not `CLAIMED`)
    - `warmHours(appId; templateId; fromIso; toIso): Promise<number>` (sum over rows of overlap of `[created_at, coalesce(claimed_at, deleted_at, now))` with the window, in hours)
- [ ] **Step 1: Write the failing tests** (`warm-pool-db.test.ts`): insert → `live` returns WARMING; `markAvailable` → AVAILABLE; `claimOneAvailable` returns the oldest-ready AVAILABLE row matching all three keys and marks it CLAIMED; a second concurrent claim (two `claimOneAvailable` in `Promise.all` with two AVAILABLE rows) returns two different rows; a wrong `templateHash` returns null; `releaseClaim` makes it claimable again; `isWarm` is null for CLAIMED and deleted rows; `warmHours` across a month boundary (row from 31 Oct 22:00 to 1 Nov 02:00 → 2 h in October's window, 2 h in November's).
- [ ] **Step 2: Run** it. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the migration (`createTable("app_warm_pool").ifNotExists()`, PK `environment_id`, index on `(app_id, template_id, state)`), the schema types, and the store.
- [ ] **Step 4: Run** `pnpm vitest run subgraphs/vetra-licensing/__tests__/warm-pool-db.test.ts subgraphs/vetra-licensing/__tests__/migrations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(licensing): the warm pool table`.

### Task 5: Gitops renders warm environments closed, with the app image

**Files:**
- Modify: `processors/vetra-cloud-environment/gitops.ts:1179-1306` (`generateFusionBlock`, ingress at `:1297-1306`), `:1359` (`generateValuesYaml` gains `isWarm?: WarmPoolLookup`), `processors/vetra-cloud-environment/app-image-project.ts:20,53-80`, `processors/vetra-cloud-environment/factory.ts` (wire the lookup from the licensing DB like the app image resolver)
- Test: `processors/vetra-cloud-environment/__tests__/fusion.test.ts`, `__tests__/gitops.test.ts`, golden files in `__golden__/` (add one for a warm env)
- External: `powerhouse-k8s-hosting` — one `Middleware` in namespace `vetra-system` named `warm-closed`: `spec.ipAllowList.sourceRange: ["127.0.0.1/32"]` (separate PR in that repo; Task 11 merges it before production)

**Interfaces:**
- Consumes: `WarmPoolStore.isWarm` (Task 4).
- Produces: `type WarmPoolLookup = (documentId: string) => Promise<{ appId: string } | null>`; for a warm document the FUSION ingress gets the annotation from Global Constraints and `licensedImageProject` allows the app's Harbor project.

- [ ] **Step 1: Write the failing tests**: warm document → ingress annotations include the exact middleware annotation, TLS/cert-manager unchanged; non-warm → no such annotation (golden unchanged); warm document with no `license_environments` row → `app.enabled: true` with the app's image project.
- [ ] **Step 2: Run** `pnpm vitest run processors/vetra-cloud-environment`. Expected: FAIL.
- [ ] **Step 3: Implement** the optional lookup through `generateValuesYaml` → `generateFusionBlock`, and in `createAppImageProjectResolver` (treat warm as licensed for its app).
- [ ] **Step 4: Run** the folder's tests; update only the new golden. Expected: PASS, existing goldens unchanged.
- [ ] **Step 5: Commit** `feat(gitops): a warm environment is closed and runs its app's image`.

### Task 6: Create a warm environment

**Files:**
- Modify: `subgraphs/vetra-licensing/template.ts:241-304` (`CreateRenderInput.owner: string | null`; with null: no `setOwner`, `ADMINS` value empty via `hostEnv(host, "")`)
- Create: `subgraphs/vetra-licensing/warm-env.ts`
- Test: `__tests__/template.test.ts`, create `__tests__/warm-env.test.ts`

**Interfaces:**
- Consumes: `EnvGateway` (`vetra-apps/envs.ts:15-27`), `protectUnownedForService(perm, documentId, service)` and `vetraServiceAddress()` (`vetra-cloud-observability/env-protection.ts:103,337`), `WarmPoolStore.insertWarming`.
- Produces: `createWarmEnvironment(deps: { envs: EnvGateway; protect(documentId: string): Promise<void>; generateSubdomain(id: string): string; store: WarmPoolStore }, input: { appId: string; appName: string; template: TemplateShape & { id: string }; templateHash: string; nowIso: string }): Promise<string>` — creates, protects **before** applying actions (as `createStudioEnvironmentDoc` does), applies `renderCreateActions({ owner: null, label: \`${appName} (warm)\`, ... })`, inserts the WARMING row; on any failure deletes the document and rethrows.

- [ ] **Step 1: Write the failing tests**: `renderCreateActions({owner: null})` has no `SET_OWNER` and an `ADMINS` entry with empty value; with an owner, output is unchanged from today (existing tests green). `createWarmEnvironment` calls `protect` before `execute`, labels `"Sektar (warm)"`, inserts a WARMING row with the given hash; a failing `execute` deletes the document and inserts nothing.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files and `pnpm vitest run subgraphs/vetra-licensing`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(licensing): create an ownerless warm environment from a template`.

### Task 7: The keeper

**Files:**
- Create: `subgraphs/vetra-licensing/warm-pool-plan.ts`, `subgraphs/vetra-licensing/warm-pool-keeper.ts`
- Modify: `subgraphs/vetra-licensing/config.ts` (three settings from Global Constraints, via its `int`/`nonNegative` helpers), `index.ts` (construct, `.start()` next to the handler `:540`, stop in `onDisconnect` `:563`)
- Test: create `__tests__/warm-pool-plan.test.ts`, `__tests__/warm-pool-keeper.test.ts`; `__tests__/config.test.ts`; `subgraphs/vetra-housekeeping/policy.test.ts`

**Interfaces:**
- Consumes: `WarmPoolStore` (Task 4), `createWarmEnvironment` (Task 6), `AppReads` for apps/templates/terms, `EnvGateway.getState`/`delete`, `templateHash`.
- Produces:
  - `interface PoolTarget { appId: string; appName: string; templateId: string; templateHash: string; size: number; template: TemplateShape }`
  - `interface PoolPlanItem { create: number; promote: string[]; remove: string[] }`
  - `computeAppPoolPlan(rows: WarmRow[], target: PoolTarget | null, envStatus: Record<string, string | null>, maxPerTemplate: number): PoolPlanItem` — pure. `target = null` (size 0, app suspended, no active term) → remove all live unclaimed rows. Promote WARMING whose status is `READY`. Remove: hash ≠ target hash; status in the Studio `DEAD_STATUSES` set or document missing (null); surplus over `min(size, maxPerTemplate)` (WARMING newest first, then AVAILABLE oldest first). Never includes CLAIMED rows. `create = max(0, min(size, max) − (remaining WARMING + AVAILABLE))`.
  - `class AppWarmPoolKeeper { constructor(deps, cfg); start(): void; stop(): void; reconcileOnce(): Promise<void> }` — applies plans for every target (templates with `warmPoolSize > 0` of non-suspended apps with a non-DRAFT/RETIRED term, plus every `(app, template)` that still has live rows), capping total creations at `createsPerTick`; in-process `running` guard; one failing pool does not stop the others.
- [ ] **Step 1: Write the failing plan tests**: fill from 0 to 3; promote READY; recycle on hash change; heal dead and missing; shrink 3→1 removes WARMING first (Review Focus 3) and never a CLAIMED row; null target drains; `maxPerTemplate` 2 caps a size of 5.
- [ ] **Step 2: Write the failing keeper tests**: with fakes, one tick creates up to `createsPerTick` across two pools; a throwing `createWarmEnvironment` for pool A still lets pool B fill; `reconcileOnce` while running is a no-op; removed rows are `markDeleted` and their documents deleted.
- [ ] **Step 3: Write the housekeeping pin**: `isEligibleForSleep` is false for an unowned FUSION-only environment.
- [ ] **Step 4: Run** the four files. Expected: FAIL (plan/keeper missing; housekeeping pin passes already — keep it).
- [ ] **Step 5: Implement** plan, keeper, config, wiring.
- [ ] **Step 6: Run** `pnpm vitest run subgraphs/vetra-licensing subgraphs/vetra-housekeeping`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(licensing): keep every warm pool filled and current`.

### Task 8: Claim in `provisionChain`

**Files:**
- Modify: `subgraphs/vetra-licensing/environments.ts:128-138` (`ChainEnvDeps.warmPool?: WarmClaimDeps`), `:177-286`; `index.ts:326,347` (wire)
- Test: `subgraphs/vetra-licensing/__tests__/environments.test.ts`, `__tests__/handler-reactor.integration.test.ts`

**Interfaces:**
- Consumes: `WarmPoolStore.claimOneAvailable` / `releaseClaim` / `markDeleted` (Task 4), `protectForOwner(perm, documentId, ownerAddress, db?)` (`env-protection.ts:360`), `renderFloorUpdateActions` (`template.ts:478`).
- Produces: `interface WarmClaimDeps { store: WarmPoolStore; handOver(documentId: string, owner: string): Promise<void>; appKey?: (input: { environmentId: string; tenantId: string; rootLicenseId: string; ownerDid: string }) => Promise<void> }`.
- Flow (spec §3.5), inserted before `envs.create()` at `:209`, DEDICATED only, after the cap check `:194-204`:
  1. `claimOneAvailable({ appId, templateId, templateHash, rootLicenseId, nowIso })`; none → cold path.
  2. `rows.claim({ ..., environment_id: warm.environment_id, template_hash: UNAPPLIED_TEMPLATE_HASH })`.
  3. Re-read the document: owned by someone else or not READY → `markDeleted`, `envs.delete`, remove the chain row, cold path.
  4. Execute `SET_OWNER` + `renderFloorUpdateActions` (ADMINS follows the owner) as one batch; `appKey?.(...)` (Task 9); `handOver(documentId, owner)`; record the real template hash.
  5. Failure in 2–4 → `releaseClaim` is **not** used once the chain row exists: delete the environment, `markDeleted`, remove the chain row, release any key, cold path.
- Roll-forward: an existing chain row with `UNAPPLIED_TEMPLATE_HASH` whose environment is a CLAIMED warm row → run step 4 (idempotent) and record the hash.
- [ ] **Step 1: Write the failing tests**:
  - warm AVAILABLE → claimed: no `envs.create`, document gets `SET_OWNER` to the holder and `ADMINS=<holder>`, `handOver` called, chain row has the real hash.
  - none available → cold path exactly as before (same calls as the existing cold test).
  - warm document already owned → deleted, `markDeleted`, cold path.
  - `execute` throws during step 4 → environment deleted, row deleted, chain row removed, cold path taken.
  - crash simulation (Review Focus 2): chain row with `UNAPPLIED_TEMPLATE_HASH` pointing at a CLAIMED warm env, no owner yet → next `provisionChain` sets owner/ADMINS and records the hash, does not create.
  - recycle race (Review Focus 1): keeper `markDeleted` lands between `claimOneAvailable` and step 3 → step 3 sees the document missing → cold path; the licence ends with exactly one environment.
  - app cap reached → refused as today, the warm row stays AVAILABLE.
- [ ] **Step 2: Run** `pnpm vitest run subgraphs/vetra-licensing/__tests__/environments.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** (no `warmPool` dep → code path identical to today).
- [ ] **Step 4: Run** the licensing folder incl. `handler-reactor.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(licensing): a licence claims a warm environment before building one`.

### Task 9: The included AI key for app environments

**Files:**
- Modify: `subgraphs/vetra-llm/broker.ts` (key naming parameter), `subgraphs/vetra-llm/factory.ts:38,59` (app budget source), `subgraphs/vetra-llm/sweeper.ts:74-86` (app keys checked against their licence, not Studio), `subgraphs/vetra-licensing/invite-codes.ts:383` (`redeemedCodeOf` reuse), `subgraphs/vetra-licensing/environments.ts` (cold create + `appKey` for warm claim), `subgraphs/vetra-licensing/template.ts:293-304` (`fusionActions`: when a key is due, add env entry `{ name: "OPENROUTER_API_KEY", value: null, isSecret: true }`)
- Test: `subgraphs/vetra-llm/__tests__/broker.test.ts`, `__tests__/sweeper.test.ts`, `subgraphs/vetra-licensing/__tests__/environments.test.ts`, `processors/vetra-cloud-environment/__tests__/fusion.test.ts`

**Interfaces:**
- Consumes: `LlmBroker.provisionVetraKey({environmentId, tenantId, ownerDid})` (`broker.ts:366-423`, mints then writes secret, undoes on failure), `releaseVetraKey(environmentId)`, `redeemedCodeOf(db, licenseId, userDid)`.
- Produces: `appBudgetForLicence(rootLicenseId: string, userDid: string): Promise<number | null>` (the redeemed code's `llm_budget_usd`, else null); broker keys for app environments named `app:<environmentId>`; `WarmClaimDeps.appKey` implementation calling `provisionVetraKey` only when the budget is non-null.
- [ ] **Step 1: Write the failing tests**: claim with a code budget of 20 → key `app:<id>` minted with limit 20, `OPENROUTER_API_KEY` declared secret in `fusion.env`, written in the same batch as ADMINS; claim without budget → no key, no env entry; cold create with budget → key minted; failing secret write → key released (broker undo) and claim falls back to cold; sweeper leaves an `app:` key alone when its licence is active and has a budget, releases it when the environment is gone; a warm (unclaimed) environment never gets a key.
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run subgraphs/vetra-llm subgraphs/vetra-licensing processors/vetra-cloud-environment`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(llm): an app licence's environment gets its included OpenRouter key`.

### Task 10: Publisher `warmPool` query and the cost estimate

**Files:**
- Create: `subgraphs/vetra-licensing/warm-cost.ts`
- Modify: `publisher-schema.ts:266-275` (`VetraPublisherQueries.warmPool`), `publisher-resolvers.ts` (resolver using `readable(appId, ctx)` `:170`, wrapped in `withCodes`)
- Test: create `__tests__/warm-cost.test.ts`; `__tests__/publisher-api.test.ts`, `__tests__/publisher-isolation.test.ts`

**Interfaces:**
- Consumes: the size → resources table gitops uses for FUSION (`VETRA_AGENT_*`, fallback size for `null`), `WarmPoolStore.live` / `warmHours`.
- Produces:
  - `estimateEnvironmentEurPerMonth(size: string | null): number` = `40 × (ceil(max(vCPU/2, memGB/4)) + 1)`.
  - GraphQL `type WarmPool { size: Int! warming: Int! available: Int! claimedThisMonth: Int! warmHoursThisMonth: Float! warmHoursLastMonth: Float! estimatePerEnvironmentEur: Float! }`, `warmPool(appId: String!, templateId: String!): WarmPool!`.
- [ ] **Step 1: Write the failing tests**: `estimateEnvironmentEurPerMonth` for each `VETRA_AGENT_*` size and `null`, values computed from the gitops table (assert the formula on two sizes with literal numbers taken from the table); `warmPool` for the app's publisher returns counts from fixture rows; a different publisher gets the same refusal as `templates` (`publisher-isolation.test.ts`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the licensing folder. Expected: PASS.
- [ ] **Step 5: Commit** `feat(publisher): warm pool status and cost estimate`.

### Task 11: Verify, merge, deploy to staging, then production

- [ ] **Step 1:** `pnpm tsc && pnpm lint && pnpm format:check && pnpm test && pnpm test:coverage` on the branch. Expected: all green, coverage ≥ 95%.
- [ ] **Step 2:** Whole-branch review (fresh reviewer), fix Critical/Important findings.
- [ ] **Step 3:** Open the PR to `main` (squash-merge convention). Open the `powerhouse-k8s-hosting` PR adding the `warm-closed` Middleware; merge it first (it is inert until referenced).
- [ ] **Step 4: Staging.** Merge the branch into `staging` (push → `sync-and-publish.yml` publishes the `staging` channel). Expected: workflow green; the staging cloud switchboard runs the new version (check its reported package version).
- [ ] **Step 5: Staging check.** On a staging app with a DEDICATED template: set `warmPoolSize: 1`; within ~3 min one warm env is AVAILABLE and its host answers 403 from outside; redeem a staging invite → it is claimed (no new env), owner/ADMINS set, host answers 200 within ~60 s; the keeper creates a replacement; observability queries refuse an anonymous caller; `warmPool` shows the counts. Set the size back to 0 → the replacement is removed.
- [ ] **Step 6: Production.** Squash-merge the PR into `main` (publishes `latest`). Expected: workflow green, production switchboard on the new version. With all pools at 0 nothing changes; smoke: observability refuses anonymous, a redeem provisions immediately.
- [ ] **Step 7:** Set Sektar's DEDICATED template to `warmPoolSize: 1` in production only after the console (vetra.io plan) is live, and verify one claim end to end.
