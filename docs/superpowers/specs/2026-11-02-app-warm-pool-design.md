# App warm pool: publisher-paid, pre-started environments for licensed apps

- **Status:** Draft for approval
- **Date:** 2026-11-02
- **Author:** Frank Pfeift (with Claude)
- **Repos:** `vetra-cloud-package` (backend), `vetra.io` (publisher console)
- **Related:** `2026-10-06-license-driven-provisioning-design.md`, `2026-10-08-app-document-licensing-redesign-design.md`, `2026-10-08-licensing-api-contract.md`, the Studio pool (`subgraphs/vetra-studio-pool`), `docs/superpowers/plans/2026-06-16-warm-pool-phase2.md`

## 1. Intent

A customer who redeems an invite code (or is granted a licence) for an app on Vetra should be inside their own running environment in well under a minute, not after a cold build. Today every dedicated licence environment is built from scratch: the licence is issued, the licensing handler picks it up on its next 60-second tick, creates the environment, gitops renders it, the image is pulled and the app boots. Measured on Sektar on 2 Nov: about 3 minutes, of which roughly 2 are image pull and first boot.

Vetra Studio solves this with a warm pool, but that pool is hard-wired to Studio. This design makes warm pools a feature every app can use. **The publisher decides how many warm environments to keep, because the publisher pays for them.** Vetra provides the mechanism, keeps the pool filled and current, and shows the publisher what it costs.

### Why now

Sektar launched on Vetra cloud through invite codes. The first-run experience (a multi-minute wait, then a bare `no available server` page) was the most visible problem in the 2 Nov evaluation. Other publishers will hit the same wait.

## 2. Goals, non-goals, anti-goals

**Goals**
- A publisher can set, per template, how many warm environments Vetra keeps ready. Default 0, which changes nothing.
- Redeeming or granting a licence claims a warm environment when one is available, and falls back to today's cold build when none is.
- Warm environments always run the template's current resolved release; a new release replaces unclaimed warm environments.
- The publisher sees what the pool costs: the estimated monthly cost of the configured pool and the warm hours actually run this month.
- Works for any app whose template is DEDICATED and has a FUSION service, Sektar first.
- Nobody can reach a warm environment until it is claimed.
- An app licence that carries an LLM budget gets its included OpenRouter key, whether its environment was claimed warm or built cold.

**Non-goals (this version)**
- Billing or invoicing. Vetra has no billing system. Warm hours are recorded so a later billing feature can charge them; nothing is charged or blocked now.
- Moving Vetra Studio onto this mechanism. Studio keeps its own pool. Merging them is a possible follow-up once this has run.
- Instant owner hand-over without a restart. The app learns its owner from `ADMINS` at start; per-request owner resolution (`warm-pool-phase2.md`) stays out of scope.
- Pools for SHARED templates (every licence uses one environment there; nothing to pre-start).
- Autoscaling the pool from demand.

**Anti-goals (failure even if it "works")**
- A claimed environment that carries anything from before the claim that belongs to a person: data, sign-ins, keys tied to someone else.
- Pool costs that grow without the publisher knowing or past what they set.
- Any change in behaviour for apps and templates with pool size 0.
- Two licences ending up in one environment, or a licence left with no environment because a claim half-failed.

## 3. Decisions

### 3.1 The pool is per template

A template fixes everything a warm environment consists of: mode, size, services, packages, artifact channel and the resolved `templateHash`. Several plans (terms) can point at one template; a pool per plan would split identical environments. So:

- New template field **`warmPoolSize: Int!`** (default `0`) on the `vetra-app` document model's `Template`, set through **`SET_TEMPLATE_DETAILS`** (`SetTemplateDetailsInput.warmPoolSize: Int`).
- Allowed only when the template is `DEDICATED`. Setting it on a SHARED template is an error (`WarmPoolNotDedicatedError`).
- Bounded by a maximum of **10**, a constant in the document model: the reducer rejects more with `WarmPoolTooLargeError` (a pure reducer cannot read env vars, and app documents are writable directly, so the bound must live in the model). The keeper additionally caps every pool at **`APP_WARM_POOL_MAX_PER_TEMPLATE`** (default 10, may only lower it), so the platform can tighten the limit without a model change. *(Builder's call, settled in review.)*
- A claim draws from the pool of the template the licence's kind resolves to (`resolveKind`, `subgraphs/vetra-licensing/app-reads.ts:207-229`).

### 3.2 Warm environments are tracked in their own table

New table **`app_warm_pool`** in the licensing database (alongside `license_environments`), not the shared `environments` read model the Studio pool uses:

| column | |
|---|---|
| `environment_id` | PK, the environment document id |
| `app_id`, `template_id` | the pool it belongs to |
| `template_hash` | the resolved hash it was built from |
| `state` | `WARMING` → `AVAILABLE` → `CLAIMED` |
| `created_at`, `ready_at`, `claimed_at`, `deleted_at` | lifecycle, also the source of warm hours |
| `root_license_id` | set on claim |

Rows are never hard-deleted while they still count toward warm hours of the current and previous month; `deleted_at` marks the end.

### 3.3 The keeper keeps every pool filled and current

A new **`AppWarmPoolKeeper`** in `vetra-licensing`, reusing the Studio pool's shape (`computePoolPlan` in `vetra-studio-pool/reconcile.ts`, `PoolKeeper` in `keeper.ts`), generalised to many pools keyed by `(app_id, template_id)`:

- Runs every **`APP_WARM_POOL_SCAN_INTERVAL_MS`** (default 30 s).
- For each template with `warmPoolSize > 0` on an app that is not suspended, and a term on that template that is not DRAFT or RETIRED:
  - **Promote**: `WARMING` rows whose environment is READY (status READY and Argo healthy) become `AVAILABLE`, `ready_at` set.
  - **Recycle**: `WARMING`/`AVAILABLE` rows whose `template_hash` differs from the template's current hash are deleted (environment deleted, `deleted_at` set).
  - **Shrink**: if `AVAILABLE + WARMING > warmPoolSize`, delete the surplus, oldest `WARMING` first, then oldest `AVAILABLE`.
  - **Heal**: rows whose environment failed or vanished are deleted, as the Studio reconcile does (`reconcile.ts:218-276`).
  - **Fill**: create `warmPoolSize − (AVAILABLE + WARMING)` new warm environments.
- Templates with `warmPoolSize = 0`, or whose app is suspended or all of whose terms are retired, are drained to zero.
- Creation is rate-limited per tick (**`APP_WARM_POOL_CREATES_PER_TICK`**, default 3) so a publisher raising the size to 10 does not burst the cluster.

### 3.4 Creating a warm environment

Same rendering as a cold licence environment, minus the owner:

- `renderCreateActions` (`template.ts`) gains an ownerless variant: no `SET_OWNER`, `ADMINS` empty for host FUSION services (`hostEnv()`, `template.ts:141-146`), label `<app name> (warm)`.
- The environment is protected for the Vetra service identity at creation, as Studio warm environments are (`vetra-studio-pool/create-env.ts`), so nobody else can claim or edit it.
- It gets everything a cold environment gets: subdomain, database (CNPG), the `/data` PVC, image, size, and its TLS certificate.
- **It is not reachable until claimed** *(decided by the owner)*. Gitops renders a warm environment's ingress in a closed mode: the certificate is issued and the host name resolves, but the ingress answers every request with 503 "This environment is being prepared" instead of routing to the app (an ingress annotation or a dedicated backend; the builder picks the mechanism the ingress controller supports). The claim re-renders it open. This keeps the first anti-goal in Vetra's hands rather than each app's: no visitor can create anything a later claimant would inherit. The health checks the keeper uses to promote WARMING to AVAILABLE read the pod and Argo status in-cluster, not through the ingress.

### 3.5 Claiming in `provisionChain`

`provisionChain` (`subgraphs/vetra-licensing/environments.ts:177`) is the only place a licence environment is created. Before `envs.create()` (line 210), for a DEDICATED template:

1. In one transaction: `SELECT … FROM app_warm_pool WHERE app_id=$1 AND template_id=$2 AND template_hash=$3 AND state='AVAILABLE' ORDER BY ready_at LIMIT 1 FOR UPDATE SKIP LOCKED`; mark it `CLAIMED` with `claimed_at` and `root_license_id`; insert the `license_environments` row for the chain (its UNIQUE `root_license_id` stays the claim lock) with `template_hash = UNAPPLIED_TEMPLATE_HASH`, exactly as the cold path does. **The claim rolls forward:** if the process dies after this transaction, the next tick sees an unapplied row and finishes steps 2–3 (they are idempotent: `SET_OWNER` to the same holder, `ADMINS` to the same value), then records the real hash. *(Builder's call, settled in review.)*
2. Re-read the environment document; if it has an owner already or is not READY, mark the row deleted, delete the environment and fall back to step 4.
3. Apply the claim actions to the environment document: `SET_OWNER` to the licence holder, the host env update that sets `ADMINS` (`renderFloorUpdateActions`, `withHostEnv`, `template.ts:460`), the included AI key when the licence carries one (§3.11), opening the ingress (§3.4), then hand protection over to the owner. These land as one batch so gitops re-renders once and Argo rolls the app pod once; the image is already on the node and the database already initialised.
4. If no warm environment is available, or any claim step fails: release the claim (row back to deleted, `license_environments` row removed, environment deleted if it was touched) and continue with today's cold path unchanged.

Concurrency: `SKIP LOCKED` makes two simultaneous claims take different rows; the per-chain lock (`environments.ts:319-345`) and the UNIQUE `root_license_id` still prevent one licence getting two environments.

### 3.6 Caps and accounting

- The per-app environment cap (`app_environment_limits`, `LICENSING_DEFAULT_MAX_ENVIRONMENTS`) counts `license_environments` rows, i.e. claimed environments only. Unclaimed warm environments do not count; they are bounded by `warmPoolSize` and `APP_WARM_POOL_MAX_PER_TEMPLATE`.
- A claim that would exceed the app cap is refused exactly as a cold build is today (`environments.ts:194-204`); the warm environment stays in the pool.

### 3.7 Warm environments never sleep

Like Studio's (`vetra-housekeeping/policy.ts:195`), unclaimed warm environments are excluded from housekeeping sleep: a sleeping warm environment would not be warm. After the claim, the environment is an ordinary licence environment and housekeeping treats it as one.

### 3.8 What the publisher sees and pays

- **Console** (`vetra.io`): on the template form, next to Size (`modules/publisher/components/templates/template-details-form.tsx:113-131`), a field **"Warm environments"** (0 to the platform maximum), disabled for SHARED templates, with the hint "Kept running and ready to hand out. You pay for them while they wait."
- Beside it, the **estimated monthly cost**: `warmPoolSize × units(size) × €40`, at the customer price the landing page uses (`modules/landing/lib/pricing.ts`: €40 per unit of 2 vCPU / 4 GB / 80 GB). `units(size)` = `ceil(max(vCPU ÷ 2, RAM GB ÷ 4))` of the resources the template's size actually requests in gitops (the `VETRA_AGENT_*` size table; "Default" = the FUSION fallback size), plus 1 unit for the environment's database and volume. One function, `estimateWarmCostEur(size)`, shared by console and API so they cannot disagree. Labelled "estimate". *(Builder's call, settled in review.)*
- On the template card (`template-card.tsx`), next to the environment count: "N warm, M ready" and "X warm hours this month".
- New publisher query **`warmPool(appId, templateId)`** in the `vetraPublisher` namespace: `{ size, warming, available, claimedThisMonth, warmHoursThisMonth, warmHoursLastMonth }`. Warm hours = sum over rows of (`claimed_at` or `deleted_at` or now) − `created_at`, clipped to the month.
- Nothing is charged. Warm hours are kept so the future billing feature can charge the publisher for them.

### 3.9 What an app must do to be poolable (the app contract)

A warm environment runs before anyone owns it, and the claimant inherits its database and `/data` volume. An app is safe to pool when:

1. It starts and stays healthy with **no `ADMINS`** (and no owner).
2. Before the first restart with `ADMINS`, it creates **nothing that belongs to a person**: no user data, no sign-ins, no per-user keys. Instance-level state it generates for itself (a server key, a secrets master key, an empty database schema) is fine and becomes the claimant's. (Visitors cannot reach it before the claim, §3.4, so this is only about what the app does on its own.)
3. It reads its owner/admins **at start** (one restart on claim is expected).

The console shows this contract next to the "Warm environments" field. Vetra cannot verify it; the publisher opts in by setting the size above 0.

Sektar meets it: the host starts with empty `ADMINS`, generates `PH_WORKFLOWS_SECRETS_MASTER_KEY` and its server keypair into `/data` on first start (instance-level), and creates integrations, workflows and documents only after an admin signs in.

### 3.10 What the customer sees

- Redeeming claims on the licensing handler's next pass. (Triggering provisioning immediately on redeem is a separate change, see §6.)
- The environment appears in `mySubscriptions` with its `openUrl` as soon as the claim's `license_environments` row exists, typically READY again within the one rollout (~30–60 s).
- The environment's event log includes its warm history. The setup progress UI (separate change, §6) shows only events after `claimed_at`.

### 3.11 The included AI key reaches app environments *(decided by the owner)*

Today Vetra's LLM broker mints an OpenRouter key only for Studio environments. This change extends it to app licence environments:

- When a licence's plan or invite code carries `llmBudgetUsd`, the environment that licence gets, **warm-claimed or cold-built**, receives a broker-minted OpenRouter key capped at that budget, as the secret **`OPENROUTER_API_KEY`**, declared in the FUSION service's env so the chart mounts it (`gitops.ts:1256-1260, 1277-1286`), with the secrets controller enabled for it.
- On a claim it is written in the same batch as `ADMINS` (one restart). On a cold build it is part of the create. Warm environments never hold a key.
- Keys are released with the environment (deletion, licence end), as Studio's are; a failed claim releases the key it minted.
- What the app does with it is the app's business. Sektar offers it to the admin as "Use the key included with your Sektar" (Sektar #12).

## 4. Failure and edge cases

| Case | Behaviour |
|---|---|
| Pool empty | Cold build, exactly as today |
| Warm env found owned or not READY at claim | Deleted, cold build |
| Claim actions fail midway | Claim released, env deleted, cold build; the keeper refills |
| New release while a claim is in flight | The claim completes on the old hash; the next floor update moves it to the new release, as for any licence environment (`environments.ts:277-279`) |
| Publisher lowers `warmPoolSize` | Surplus deleted on the next tick (WARMING first) |
| Template switched to SHARED | Not allowed while `warmPoolSize > 0`; set it to 0 first |
| App suspended / all terms retired | Pool drained to 0 |
| Cluster can't schedule warm envs | They stay WARMING; the keeper's heal step deletes envs that fail; nothing is claimed from WARMING |
| Licensing subgraph has >1 replica | Out of scope. The subgraph is single-replica by design (`environments.ts:319-345`; pgbouncer in transaction mode rules out session advisory locks), so the keeper uses an in-process guard like the chain lock. Going multi-replica later needs a lease row for the keeper and a database-level claim guarantee. |

## 5. Testing

- Unit: keeper plan (fill, promote, recycle on hash change, shrink, heal, drain), per pool, with a fake clock and fake environment states, in the style of `vetra-studio-pool/reconcile.test.ts` and `keeper.test.ts`.
- Unit: `provisionChain` claim path: warm available → claimed and owner/ADMINS set; none → cold; owned/not-ready → cold and deleted; failure midway → released and cold; two concurrent claims → two different rows.
- Unit: document model: `warmPoolSize` default 0, SHARED rejected, above the maximum rejected (each error code tested).
- Unit: warm-hour accounting across month boundaries.
- Unit: gitops renders a warm environment's ingress closed (503, certificate requested) and a claimed one open.
- Unit: the included key: minted on claim and on cold create when the licence has `llmBudgetUsd`, never for a warm environment, released on a failed claim and on deletion; written in the same batch as `ADMINS`.
- Unit: a claim interrupted after its transaction is finished by the next tick (roll-forward).
- Integration: one end-to-end run on a dev cluster with Sektar's template at size 1: warm env reaches AVAILABLE and answers 503 from outside; redeem claims it; Sektar is reachable with the redeemer as admin and offers the included key; the keeper creates a replacement.

## 6. Related changes, delivered separately (same initiative)

1. **Auth on environment observability.** `environmentStatus`, `environmentPods` and `environmentEvents` take a `tenantId` and check nothing (`vetra-cloud-observability/resolvers.ts:173-217`). Restrict to the environment's owner, its licence holder, a covering org publisher, or an admin. Ship first: it is a live information leak, and the progress UI depends on it.
2. **Provision on redeem.** Have `redeemInviteCode` (and publisher grants) trigger `provisionChain` for the new licence immediately instead of waiting up to 60 s for the handler's tick.
3. **Setup progress checklist** on the app's onboarding page (Sektar's site first): invite accepted → environment reserved → database ready → downloading the app → starting → opening, each ticked from status, pods and events, with elapsed times; for a claimed warm environment most steps are already done.

## 7. Left to the builder

- The exact GraphQL shapes and names beyond those given, migrations, and where the keeper is wired in the subgraph's lifecycle.
- Whether the ownerless create variant is a flag on `renderCreateActions` or a separate function.
- How much of `vetra-studio-pool` is extracted into shared code versus copied; Studio's behaviour must not change.
- Logging and metrics names (at least: pool size, available, claims, cold fallbacks, claim duration).
- The console's exact layout within the template form and card, following the existing publisher components.
