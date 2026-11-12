# Releases phase 2, plan 3: instance health — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every instance gets a measured health (`healthy` / `unhealthy` / `unknown`, with the check and a reason) that does not depend on the environment document's status. With health enforced, `ready` means healthy on the target digest; an update that stays unhealthy past a configurable window is `failed` and goes back to the last healthy digest; a ready instance that stops being healthy without an update is `degraded` (surfaced, never reverted) and returns to `ready` once healthy again.

**Architecture:** A new health monitor pass (`monitorInstancesOnce`, every 15 s, outside the per-app lock, writes only health columns) judges each due instance from two sources: the cluster as the observability subgraph already records it (`environment_status`: Argo sync/health/ComparisonError; `environment_pods`: phase, readiness, restarts, extended here with image, imageID and the waiting reason), then, only when the cluster shows a ready pod on the wanted digest, HTTP probes of the instance host (`/ready`, which the switchboard answers 200 only after migrations and drive seeding, then Connect at `/`). The reconciler reads those columns: in `enforce` mode its status comes from `observeHealth`; in `report` mode (default) it keeps slice 1's interim rule and health is only shown. The running digest is the pod's `imageID` (the host cannot report its version yet, gap 8); the environment document's tag is the fallback, labelled as such.

**Tech Stack:** TypeScript, Kysely (Postgres; PGlite in tests), vitest, Node `fetch` with `AbortSignal.timeout`, the `powerhouse/vetra-cloud-environment` document model (read only in this plan), the observability namespace tables.

**Spec:** `docs/superpowers/specs/2026-11-11-app-releases-and-instances-design.md` (14.7 health; 6 step 3 "ready requires the health check to pass and the running digest to equal the target", failed update stays on the previous digest; 7 rollouts reuse this definition later; 15 host-reported version). Slice scope and gap 8: `docs/superpowers/plans/2026-11-11-releases-phase-2-overview.md` (slice 3). Conventions and the code this builds on: `docs/superpowers/plans/2026-11-11-releases-phase-2-plan-1-branch-instances.md`, `…-plan-2-previews.md`, `subgraphs/vetra-apps/instances/*`.

## What exists today (checked 2026-11-12 on `main` = 0.0.110)

- `instances/status.ts` `observeEnvironment`: `ready` = document `READY` + FUSION version equals `<version>@<digest>`. Staging (2026-11-11) showed it lies twice: a CrashLoopBackOff container read `ready`, and an Argo CD helm render error read `ready`. Root cause in observability's deployment reconciler (`subgraphs/vetra-cloud-observability/index.ts` `startDeploymentReconciler`): it flips `DEPLOYING → READY` as soon as every pod of the tenant is ready once (`readiness.ts` `coreServicesReady`), or on Argo `HEALTHY` — the old pods of a failed render stay healthy, and a crash-looping container is briefly ready between crashes. After that the document never leaves `READY`.
- `reconciler.ts` already reverts on `failed` (`revertImage`: back to `running_digest`, the target last seen ready) and never retries a `failed_digest`. This plan only changes **when** `failed` is decided.
- Observability already has cluster data, without kubectl: an in-cluster watcher (`watchers.ts`) keeps `environment_pods` (per pod: `tenantId`, `phase`, `ready`, `restartCount`, `component`) and `environment_status` (per tenant: `argoSyncStatus`, `argoHealthStatus`, `argoMessage`, `configDriftDetected` = an Argo `ComparisonError` condition, i.e. a render failure). It does **not** record the image, the `imageID` or the waiting reason (`CrashLoopBackOff`, `ImagePullBackOff`). Task 1 adds them.
- vetra-apps already opens the observability namespace (`AppsDeps.orgHandoverDb`) and the processor's read model (`envReadModel`, table `environments` with `tenantId`).
- The old path's deployment watcher (`subgraphs/vetra-apps/watcher.ts`) does **not** probe URLs; it only compares the environment document with the deployment. Nothing to reuse there.
- Powerhouse hosts (`powerhouse` monorepo): `GET /health` → `200 OK` always (registered before auth, `packages/reactor-api/src/server.ts:851`); `GET /ready` → `200` only after `api.readiness.markReady()` (`apps/switchboard/src/server.mts:1788`, after the final router update and the seeded drives), `503 starting` before; `/ready` needs switchboard ≥ 6.2.0-dev.4 (older images: 404). No endpoint reports the running version or digest (spec 15, phase 2, no owner yet).
- The chart probes `/` on port 6540 (liveness delay 60 s, readiness delay 10 s). Instance hosts: `https://<label>.vetra.io` (labels end in `-stg` on staging).

## Health definition (spec 14.7 as built here)

Checks, in order; the first that decides wins. "Judged pods" are the tenant's pods whose image is the environment's FUSION repository at the **wanted digest** (the digest in the document's FUSION version), excluding `SUCCEEDED`/`FAILED` (evicted) pods.

| # | Check | `health` | Reason (example) |
|---|---|---|---|
| 1 | no observability rows for the tenant (or no tenant yet) | unknown, check `data` | no cluster data for the environment yet |
| 2 | Argo `ComparisonError` or sync `UNKNOWN` | unhealthy, `gitops` | Argo CD cannot apply the environment (…) |
| 3 | a judged pod waits with `ErrImagePull`/`ImagePullBackOff`/`InvalidImageName`/`ErrImageNeverPull` | unhealthy, `image` | the image cannot be pulled (ImagePullBackOff) |
| 4 | a judged pod waits with `CrashLoopBackOff`/`CreateContainerConfigError`/`CreateContainerError`/`RunContainerError` | unhealthy, `crash` | the container does not start (CrashLoopBackOff) |
| 5 | judged pods' restarts rose since the last check on the same digest | unhealthy, `restarts` | the container restarted (4 restarts) |
| 6 | no judged pod | unknown, `pod` | no pod runs the target image yet |
| 7 | a judged pod not ready or not `RUNNING` | unknown, `pod` | the pod is starting |
| 8 | `GET https://<host>/ready` (404 → `/health`): 503 | unknown, `switchboard` | the switchboard is starting (migrations) |
| 9 | the same, anything but 200 (or no answer in 5 s) | unhealthy, `switchboard` | /ready answered 502 |
| 10 | `GET https://<host>/`: not 2xx `text/html` | unhealthy, `connect` | Connect answered 500 |
| — | otherwise | healthy | — |

An environment that is `STOPPED` is `unknown`, check `stopped`. HTTP probes run only when checks 1-7 pass (bounded load, and no probe hits a host that is known to be down).

**Running digest:** the `imageID` digest of a ready judged pod (`observed_digest_source = pod`); if the pod reports no `imageID` yet, the digest in the document's FUSION version (`document`). Switches to the host's own report when the Powerhouse host exposes one (gap 8; not in this plan).

**Status rules in `enforce` mode** (`instances/status.ts` `observeHealth`; `since` = when health last flipped between healthy and not healthy, or the judged digest changed):

- `ready` ⇐ healthy for ≥ 2 min (`HEALTH_STABLE_MS`, longer than liveness delay + 3 periods so a crash loop never looks stable) **and** observed digest = target.
- An **update in flight** (target ≠ `running_digest`): `failed: unhealthy (<check>: <reason>)` ⇐ current health `unhealthy` and ≥ window (`VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S`, default 300) since the update started and not healthy for ≥ 30 s (`CONFIRM_MS`, at least two checks). `unknown` (starting, migrations) never fails it before the 20-minute timeout (`not healthy after 20 minutes (…)`). Failed → slice 1's revert to `running_digest`.
- **No update in flight** (it ran the target healthy before): `degraded: <check>: <reason>` ⇐ not healthy for ≥ 60 s (`DEGRADED_AFTER_MS`), check not `data`/`stopped`. No revert, no environment write. Back to `ready` by the `ready` rule.
- Health missing, stale (> 3 min) or about another digest: no change (in flight: `updating` until the timeout).

## Global Constraints

- The monitor reads environment documents and observability rows and probes instance hosts; it **never writes** an environment document. Only rows of the `instances` table are judged; an environment with `managedBy` set or linked to another app is skipped before any read of its tenant or probe (overview rule 1). `license_environments`, `app_warm_pool`, old-path previews and production environments are never read or probed.
- Probe load: at most `VETRA_APPS_INSTANCE_PROBES_PER_PASS` (default 10, 1-100) instances per pass and `VETRA_APPS_INSTANCE_PROBES_PER_APP` (default 3, 1-20) per app per pass; each instance at most every 30 s (`PROBE_EVERY_MS`); at most 4 in parallel; at most 3 GETs per instance (`/ready`, maybe `/health`, `/`), 5 s timeout each, bodies discarded; oldest-checked first.
- `VETRA_APPS_INSTANCE_HEALTH`: `off` (no monitor), `report` (default: monitor runs, status unchanged), `enforce`. Invalid values throw at startup like `VETRA_APPS_INSTANCES`. The kill switch `VETRA_APPS_INSTANCES=off` stops the monitor too.
- Health writes never touch `updated_at`, `status`, `reason` or any target/running column; reconciler writes never touch health columns (except clearing them with `CLEAN` when an environment is recreated).
- Additive schema only: new nullable columns on `instances` (vetra-apps) and `environment_pods` (observability), `ensure…` migrations idempotent and race-tolerant like the existing ones.
- Commits: one per task, conventional (`feat(instances): …`, `feat(observability): …`, `feat(apps): …` in vetra.to), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/releases-phase-2-health` from `main` (vetra.to: `feat/instances-health`).
- Checks after every task: `npx vitest run <the task's test files> 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`; at the end `npm run tsc`, `npm run lint`, `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability processors/vetra-cloud-environment subgraphs/vetra-licensing`.
- No production pin of vetra-cloud-package between 2026-11-13 17:30 UTC and `vetraReleases.rollouts(appId: "43622402-be06-435a-bbfa-bb649b0d6244")` showing the Sektar v1.0.9 rollout COMPLETE.

## File structure

| File | Change |
|---|---|
| `subgraphs/vetra-cloud-observability/db/schema.ts`, `db/migrations.ts`, `pod-sync.ts` | `environment_pods.image`, `imageId`, `waitingReason` |
| `subgraphs/vetra-apps/db/schema.ts`, `db/migrations.ts` | health columns on `instances`; status `degraded` |
| `subgraphs/vetra-apps/config.ts` | `instances.health` (`mode`, `unhealthyWindowMs`, `probesPerPass`, `probesPerApp`), `instanceHealth(cfg)` |
| `subgraphs/vetra-apps/instances/health.ts` (new) | pure verdicts: `digestOf`, `judgeCluster`, `judgeProbes`, `observedDigest` |
| `subgraphs/vetra-apps/instances/cluster.ts` (new) | `readCluster` from the observability tables |
| `subgraphs/vetra-apps/instances/probe.ts` (new) | `HttpProbe`, `fetchProbe` |
| `subgraphs/vetra-apps/instances/monitor.ts` (new) | `monitorInstancesOnce`, `pickDue` |
| `subgraphs/vetra-apps/instances/repo.ts` | `listDueForHealth`, `recordHealth` |
| `subgraphs/vetra-apps/instances/status.ts` | `observeHealth`, `HealthView`, `healthView`, constants |
| `subgraphs/vetra-apps/instances/reconciler.ts` | mode switch, `degraded`, `unchanged`; `CLEAN` clears health; `ours` exported |
| `subgraphs/vetra-apps/instances/service.ts`, `schema.ts` | `appInstances` health fields |
| `subgraphs/vetra-apps/service.ts`, `envs.ts`, `index.ts` | deps `observabilityDb`, `envTenant`, `probe`; `tenantOfIn`; the monitor timer |
| Tests (under `subgraphs/vetra-apps/__tests__/` unless noted) | `harness.ts`, `config.test.ts`, `migrations.test.ts`, `instances-health-verdict.test.ts` (new), `instances-health.test.ts` (new), `instances-status.test.ts`, `instances-api.test.ts`; `subgraphs/vetra-cloud-observability/__tests__/watchers.test.ts` |
| vetra.to `modules/apps/{types.ts,graphql.ts,hooks/use-apps.ts,components/app-instances.tsx,__tests__/app-instances.test.tsx}` | `degraded`, health line |

---

### Task 0: Pre-flight on staging (needs the user for kubectl; no code)

- [ ] **Step 1: Endpoints of a host-mode instance.** On the staging test app's branch instance (`https://<label>-stg.vetra.io`):
  `for p in /ready /health /; do curl -s -o /dev/null -w "$p %{http_code} %{content_type}\n" "https://<label>-stg.vetra.io$p"; done`
  Expected: `/ready 200`, `/health 200`, `/ 200 text/html`. If `/ready` is not served at the apex (404 on every image), probe the `-switchboard` host instead: change `probeHost` in Task 5 to probe that base and record the answer in the plan's PR description. If `/` redirects (3xx), accept 3xx in `judgeProbes` (Task 3) and say so.
- [ ] **Step 2: The switchboard can reach instance hosts** (hairpin through the ingress): `kubectl -n <switchboard-ns> exec deploy/<switchboard> -- node -e "fetch('https://<label>-stg.vetra.io/ready').then(r=>console.log(r.status))"`. Expected `200`. If it fails, stop: the probe base must become the in-cluster service URL (needs the chart's service name; ask the user).
- [ ] **Step 3: Observability sees instance tenants.** `kubectl -n <tenant> get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image,ID:.status.containerStatuses[0].imageID` shows the host pod with image `cr.vetra.io/<ns>/<slug>:<version>@sha256:…` and an `imageID` ending in the same digest (if the digest differs because Harbor serves an index, note it: Task 3's `observedDigest` must then compare against the spec digest, see Task 3 note). `kubectl get applications -n argocd -l tenant=<tenant>` returns the instance's Application (previews ApplicationSet included), so `environment_status` has its row.
- [ ] **Step 4: Timing and branch.** Respect the Sektar window (Global Constraints). `git checkout -b feat/releases-phase-2-health origin/main`.

---

### Task 1: Observability records each pod's image, imageID and waiting reason

**Files:**
- Modify: `subgraphs/vetra-cloud-observability/db/schema.ts` (`EnvironmentPods`)
- Modify: `subgraphs/vetra-cloud-observability/db/migrations.ts` (after the `component`/`agent` loop, ~line 97)
- Modify: `subgraphs/vetra-cloud-observability/pod-sync.ts` (`PodLike`, `podToRow`, `upsertPod`)
- Test: `subgraphs/vetra-cloud-observability/__tests__/watchers.test.ts`

**Interfaces:**
- Produces: `environment_pods.image` (spec image of the pod's first container, e.g. `cr.vetra.io/acme/shop:1.5.0@sha256:…`), `imageId` (`containerStatuses[].imageID` of that container; null while pulling), `waitingReason` (first `state.waiting.reason` of any container). All nullable.

- [ ] **Step 1: Write the failing test** (append to `watchers.test.ts`; add `podToRow` to the imports from `"../pod-sync.js"`):

```ts
describe("podToRow — image and waiting reason", () => {
  const pod = (over: Partial<PodLike["status"]> = {}): PodLike => ({
    metadata: { name: "app-0", namespace: "t1", labels: { "app.kubernetes.io/component": "app" } },
    spec: { containers: [{ name: "app", image: "cr.vetra.io/acme/shop:1.5.0@sha256:aa" }] },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          ready: false,
          restartCount: 3,
          imageID: "cr.vetra.io/acme/shop@sha256:aa",
          state: { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
      ...over,
    },
  });

  it("records the spec image, the running imageID and why the container waits", () => {
    expect(podToRow(pod(), "2026-11-12T00:00:00.000Z")).toMatchObject({
      image: "cr.vetra.io/acme/shop:1.5.0@sha256:aa",
      imageId: "cr.vetra.io/acme/shop@sha256:aa",
      waitingReason: "CrashLoopBackOff",
      restartCount: 3,
      ready: 0,
    });
  });

  it("leaves imageId null while the image is pulled (empty imageID)", () => {
    const row = podToRow(
      pod({ containerStatuses: [{ name: "app", imageID: "", state: { waiting: { reason: "ImagePullBackOff" } } }] }),
    );
    expect(row).toMatchObject({ imageId: null, waitingReason: "ImagePullBackOff" });
  });

  it("stores and updates the new columns", async () => {
    const row = podToRow(pod())!;
    await upsertPod(db, row);
    await upsertPod(db, { ...row, imageId: "cr.vetra.io/acme/shop@sha256:bb", waitingReason: null });
    const stored = await db.selectFrom("environment_pods").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ imageId: "cr.vetra.io/acme/shop@sha256:bb", waitingReason: null, image: row.image });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run subgraphs/vetra-cloud-observability/__tests__/watchers.test.ts 2>&1 | tail -20`. Expected: FAIL (type errors on `spec`, missing properties).

- [ ] **Step 3: Implement.**

`db/schema.ts`, in `EnvironmentPods` after `restartCount`:

```ts
  /** Spec image of the pod's first container (`<repo>:<tag>[@<digest>]`); null on rows written before it was recorded. */
  image?: string | null;
  /** containerStatuses[].imageID of that container (what runs); null while pulling. */
  imageId?: string | null;
  /** First `state.waiting.reason` of any container (CrashLoopBackOff, ImagePullBackOff, …); null when none waits. */
  waitingReason?: string | null;
```

`db/migrations.ts`, after the `component`/`agent` loop:

```ts
  // Instance health (vetra-apps releases phase 2 slice 3) reads what a pod
  // runs and why it waits. Same idempotent ADD COLUMN pattern as above.
  for (const [col, type] of [
    ["image", "varchar(512)"],
    ["imageId", "varchar(512)"],
    ["waitingReason", "varchar(64)"],
  ] as const) {
    try {
      await db.schema.alterTable("environment_pods").addColumn(col, type).execute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists|duplicate column/i.test(msg)) throw err;
    }
  }
```

`pod-sync.ts`: extend `PodLike`:

```ts
export interface PodLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { containers?: Array<{ name?: string; image?: string }> };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      imageID?: string;
      state?: { waiting?: { reason?: string } };
    }>;
  };
}
```

In `podToRow`, before `return`:

```ts
  const main = pod.spec?.containers?.[0];
  const mainStatus =
    containerStatuses.find((cs) => main?.name && cs.name === main.name) ??
    containerStatuses[0];
  const waitingReason =
    containerStatuses.map((cs) => cs.state?.waiting?.reason).find((r) => !!r) ??
    null;
```

and add to the returned object: `image: main?.image ?? null, imageId: mainStatus?.imageID || null, waitingReason,`. In `upsertPod`'s `doUpdateSet` add `image: row.image ?? null, imageId: row.imageId ?? null, waitingReason: row.waitingReason ?? null,`.

- [ ] **Step 4: Run to verify it passes.** Same command, plus `npx vitest run subgraphs/vetra-cloud-observability/__tests__/db-migrations.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add subgraphs/vetra-cloud-observability
git commit -m "feat(observability): record each pod's image, imageID and waiting reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Health columns, the `degraded` status and the health config

**Files:**
- Modify: `subgraphs/vetra-apps/db/schema.ts` (`InstanceStatus`, `InstancesTable`)
- Modify: `subgraphs/vetra-apps/db/migrations.ts` (`ensureInstancesHealthColumns`, called in `up` after `ensureAppsInstancesEnabledColumn`)
- Modify: `subgraphs/vetra-apps/config.ts`
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts` (`CLEAN`)
- Test: `subgraphs/vetra-apps/__tests__/config.test.ts`, `subgraphs/vetra-apps/__tests__/migrations.test.ts`

**Interfaces:**
- Produces: `InstanceHealth = "healthy" | "unhealthy" | "unknown"`; `InstanceStatus` gains `"degraded"`; `InstancesTable` columns `health`, `health_check`, `health_reason`, `health_checked_at`, `health_since`, `health_digest`, `health_restarts`, `observed_digest`, `observed_digest_source` (all nullable); `InstanceHealthMode`, `InstanceHealthConfig`, `DEFAULT_INSTANCE_HEALTH`, `instanceHealth(cfg: VetraAppsConfig): InstanceHealthConfig`; `VetraAppsConfig["instances"].health?: InstanceHealthConfig`.

- [ ] **Step 1: Write the failing tests.**

`config.test.ts`: in the test "takes a label suffix such as -stg" change the expectation to `{ enabled: true, labelSuffix: "-stg", health: DEFAULT_INSTANCE_HEALTH }` (import `DEFAULT_INSTANCE_HEALTH` from `"../config.js"`), and append:

```ts
describe("instance health config", () => {
  it("reports by default", () => {
    expect(loadAppsConfig({}).instances.health).toEqual({
      mode: "report",
      unhealthyWindowMs: 300_000,
      probesPerPass: 10,
      probesPerApp: 3,
    });
  });
  it("takes enforce, a window and probe budgets", () => {
    expect(
      loadAppsConfig({
        VETRA_APPS_INSTANCE_HEALTH: "ENFORCE",
        VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S: "180",
        VETRA_APPS_INSTANCE_PROBES_PER_PASS: "20",
        VETRA_APPS_INSTANCE_PROBES_PER_APP: "5",
      }).instances.health,
    ).toEqual({ mode: "enforce", unhealthyWindowMs: 180_000, probesPerPass: 20, probesPerApp: 5 });
  });
  it.each([
    ["VETRA_APPS_INSTANCE_HEALTH", "strict"],
    ["VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S", "30"],
    ["VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S", "5m"],
    ["VETRA_APPS_INSTANCE_PROBES_PER_PASS", "0"],
    ["VETRA_APPS_INSTANCE_PROBES_PER_APP", "21"],
  ])("throws at startup on %s=%j", (name, value) => {
    expect(() => loadAppsConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});
```

`migrations.test.ts` (append; the file already imports `Kysely`, `PGlite`, `PGliteDialect` and `up`):

```ts
it("adds the instance health columns, idempotently", async () => {
  const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  await up(db);
  await db
    .insertInto("instances")
    .values({
      id: "i1", app_id: "a1", kind: "branch", name: "main", status: "degraded",
      health: "unhealthy", health_check: "crash", health_reason: "x",
      health_checked_at: "2026-11-12T00:00:00.000Z", health_since: "2026-11-12T00:00:00.000Z",
      health_digest: "sha256:aa", health_restarts: 4, observed_digest: "sha256:aa",
      observed_digest_source: "pod",
      created_at: "2026-11-12T00:00:00.000Z", updated_at: "2026-11-12T00:00:00.000Z",
    })
    .execute();
  const row = await db.selectFrom("instances").selectAll().executeTakeFirstOrThrow();
  expect(row).toMatchObject({ health: "unhealthy", health_restarts: 4, observed_digest_source: "pod" });
  await db.destroy();
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts subgraphs/vetra-apps/__tests__/migrations.test.ts 2>&1 | grep -E "FAIL|✗|×" | head`. Expected: FAIL.

- [ ] **Step 3: Implement.**

`db/schema.ts`:

```ts
/** `removed`: a tombstone for a deleted branch (never shown). `degraded`: ran the target healthy, is not healthy now (no update in flight). */
export type InstanceStatus =
  | "pending"
  | "updating"
  | "ready"
  | "degraded"
  | "failed"
  | "stopped"
  | "removed";

/** Spec 14.7 as measured by the health monitor (instances/monitor.ts). */
export type InstanceHealth = "healthy" | "unhealthy" | "unknown";
```

and in `InstancesTable`, after `removed_reason`:

```ts
  /** Last health verdict; null until first checked. Written by the monitor only. */
  health: InstanceHealth | null;
  /** The check that decided it (gitops | image | crash | restarts | pod | switchboard | connect | stopped | data); null when healthy. */
  health_check: string | null;
  health_reason: string | null;
  health_checked_at: string | null;
  /** When health last flipped between healthy and not healthy, or the judged digest changed. */
  health_since: string | null;
  /** The digest that check judged (the environment's FUSION digest then). */
  health_digest: string | null;
  /** Restarts of the judged pods at that check (a rise is a crash). */
  health_restarts: number | null;
  /** What the cluster runs: the pod's imageID digest, else the environment document's. */
  observed_digest: string | null;
  observed_digest_source: "pod" | "document" | null;
```

`db/migrations.ts`:

```ts
/** Instance health (releases phase 2 slice 3, spec 14.7). Nullable, filled by the health monitor. */
export async function ensureInstancesHealthColumns(db: Kysely<any>): Promise<void> {
  for (const [name, type] of [
    ["health", "varchar(16)"],
    ["health_check", "varchar(16)"],
    ["health_reason", "text"],
    ["health_checked_at", "varchar(64)"],
    ["health_since", "varchar(64)"],
    ["health_digest", "varchar(128)"],
    ["health_restarts", "integer"],
    ["observed_digest", "varchar(128)"],
    ["observed_digest_source", "varchar(16)"],
  ] as const) {
    try {
      await db.schema
        .alterTable("instances")
        .addColumn(name, type, (c) => c.ifNotExists())
        .execute();
    } catch (err) {
      if (!isConcurrentIndexError(err) && !isDuplicateColumnError(err)) throw err;
    }
  }
}
```

and in `up`, right after `await ensureAppsInstancesEnabledColumn(db);`: `await ensureInstancesHealthColumns(db);`.

`config.ts` (beside `instancesConfig`):

```ts
export type InstanceHealthMode = "off" | "report" | "enforce";
export interface InstanceHealthConfig {
  /** off: no monitor; report: measured and shown, status unchanged; enforce: status follows health. */
  mode: InstanceHealthMode;
  /** An update unhealthy this long after it started fails (and reverts). */
  unhealthyWindowMs: number;
  probesPerPass: number;
  probesPerApp: number;
}
export const DEFAULT_INSTANCE_HEALTH: InstanceHealthConfig = {
  mode: "report",
  unhealthyWindowMs: 300_000,
  probesPerPass: 10,
  probesPerApp: 3,
};
/** Configs built by hand (tests) may leave health out. */
export const instanceHealth = (cfg: VetraAppsConfig): InstanceHealthConfig =>
  cfg.instances.health ?? DEFAULT_INSTANCE_HEALTH;

function intIn(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = trimmed(env[name]);
  if (raw === null) return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max)
    throw new Error(`${name} "${raw}" is invalid: use a whole number from ${min} to ${max}`);
  return n;
}

function healthConfig(env: Env): InstanceHealthConfig {
  const mode = (trimmed(env.VETRA_APPS_INSTANCE_HEALTH) ?? "report").toLowerCase();
  if (mode !== "off" && mode !== "report" && mode !== "enforce")
    throw new Error(
      `VETRA_APPS_INSTANCE_HEALTH "${env.VETRA_APPS_INSTANCE_HEALTH}" is invalid: use off, report or enforce`,
    );
  return {
    mode,
    unhealthyWindowMs: intIn(env, "VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S", 300, 60, 3600) * 1000,
    probesPerPass: intIn(env, "VETRA_APPS_INSTANCE_PROBES_PER_PASS", 10, 1, 100),
    probesPerApp: intIn(env, "VETRA_APPS_INSTANCE_PROBES_PER_APP", 3, 1, 20),
  };
}
```

Change the `instances` field type to `instances: { enabled: boolean; labelSuffix: string; health?: InstanceHealthConfig };` (document the three env vars in its comment) and make `instancesConfig` return `{ enabled, labelSuffix: suffix, health: healthConfig(env) }` (keep its existing local names).

`instances/reconciler.ts`: extend `CLEAN` (a recreated environment starts unjudged):

```ts
const CLEAN: InstancePatch = {
  running_version: null,
  running_digest: null,
  running_repository: null,
  failed_digest: null,
  health: null,
  health_check: null,
  health_reason: null,
  health_checked_at: null,
  health_since: null,
  health_digest: null,
  health_restarts: null,
  observed_digest: null,
  observed_digest_source: null,
};
```

- [ ] **Step 4: Run to verify.** `npx vitest run subgraphs/vetra-apps/__tests__/config.test.ts subgraphs/vetra-apps/__tests__/migrations.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts 2>&1 | grep -E "FAIL|Tests" | tail`. Expected: PASS. `npm run tsc 2>&1 | tail -20`: fix any exhaustive `Record<InstanceStatus, …>` the new status breaks (none expected in this repo).

- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): health columns, degraded status and health config" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 3: The health verdict (pure)

**Files:**
- Create: `subgraphs/vetra-apps/instances/health.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts`

**Interfaces:**
- Consumes: `InstanceHealth` (Task 2).
- Produces:
  - `type HealthCheck = "gitops" | "image" | "crash" | "restarts" | "pod" | "switchboard" | "connect" | "stopped" | "data"`
  - `interface HealthVerdict { health: InstanceHealth; check: HealthCheck | null; reason: string | null }`
  - `interface PodSnapshot { phase: string; ready: boolean; restartCount: number; image: string | null; imageId: string | null; waitingReason: string | null }`
  - `interface ArgoSnapshot { syncStatus: string; healthStatus: string; drift: boolean; message: string | null }`
  - `interface ProbeResult { status: number | null; contentType: string | null; error: string | null }`
  - `digestOf(ref: string | null | undefined): string | null`
  - `judgedPods(pods: PodSnapshot[], wanted: string | null): PodSnapshot[]`
  - `judgeCluster(argo: ArgoSnapshot | null, judged: PodSnapshot[], previousRestarts: number | null): HealthVerdict | null` (null = nothing against it, probe next)
  - `judgeProbes(ready: ProbeResult, connect: ProbeResult | null): HealthVerdict`
  - `observedDigest(hostPods: PodSnapshot[], wanted: string | null, documentVersion: string | null): { digest: string | null; source: "pod" | "document" | null }`
  - `const NO_DATA: HealthVerdict`, `const STOPPED: HealthVerdict`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from "vitest";
import {
  digestOf,
  judgeCluster,
  judgedPods,
  judgeProbes,
  observedDigest,
  type PodSnapshot,
} from "../instances/health.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const REPO = "cr.vetra.io/acme/shop";
const pod = (over: Partial<PodSnapshot> = {}): PodSnapshot => ({
  phase: "RUNNING",
  ready: true,
  restartCount: 0,
  image: `${REPO}:1.5.0@${A}`,
  imageId: `${REPO}@${A}`,
  waitingReason: null,
  ...over,
});
const argo = { syncStatus: "SYNCED", healthStatus: "HEALTHY", drift: false, message: null };
const ok = { status: 200, contentType: "text/html; charset=utf-8", error: null };

describe("digestOf", () => {
  it("reads the digest after the last @", () => {
    expect(digestOf(`1.5.0@${A}`)).toBe(A);
    expect(digestOf(`docker-pullable://${REPO}@${A}`)).toBe(A);
    expect(digestOf("1.5.0")).toBeNull();
    expect(digestOf(null)).toBeNull();
    expect(digestOf(`x@sha256:short`)).toBeNull();
  });
});

describe("judgeCluster", () => {
  it("fails a render error before anything else, whatever the old pods say", () => {
    expect(judgeCluster({ ...argo, drift: true, message: "helm template failed" }, [pod()], 0)).toEqual({
      health: "unhealthy",
      check: "gitops",
      reason: "Argo CD cannot apply the environment (helm template failed)",
    });
    expect(judgeCluster({ ...argo, syncStatus: "UNKNOWN" }, [], null)?.check).toBe("gitops");
  });
  it("knows nothing without cluster data", () => {
    expect(judgeCluster(null, [], null)).toMatchObject({ health: "unknown", check: "data" });
  });
  it("fails a pull error and a crash loop", () => {
    expect(judgeCluster(argo, [pod({ ready: false, waitingReason: "ImagePullBackOff", imageId: null })], null)).toEqual({
      health: "unhealthy",
      check: "image",
      reason: "the image cannot be pulled (ImagePullBackOff)",
    });
    expect(judgeCluster(argo, [pod({ ready: false, waitingReason: "CrashLoopBackOff", restartCount: 3 })], 3)).toEqual({
      health: "unhealthy",
      check: "crash",
      reason: "the container does not start (CrashLoopBackOff)",
    });
  });
  it("fails restarts that rose since the last check, even when the pod is ready again", () => {
    expect(judgeCluster(argo, [pod({ restartCount: 4 })], 3)).toEqual({
      health: "unhealthy",
      check: "restarts",
      reason: "the container restarted (4 restarts)",
    });
    expect(judgeCluster(argo, [pod({ restartCount: 4 })], 4)).toBeNull();
    expect(judgeCluster(argo, [pod({ restartCount: 4 })], null)).toBeNull();
  });
  it("calls a missing or not-ready pod unknown (starting), not unhealthy", () => {
    expect(judgeCluster(argo, [], null)).toEqual({ health: "unknown", check: "pod", reason: "no pod runs the target image yet" });
    expect(judgeCluster(argo, [pod({ ready: false })], 0)).toEqual({ health: "unknown", check: "pod", reason: "the pod is starting" });
  });
});

describe("judgedPods", () => {
  it("keeps live pods on the wanted digest only", () => {
    const pods = [pod(), pod({ image: `${REPO}:1.6.0@${B}` }), pod({ phase: "FAILED" })];
    expect(judgedPods(pods, A)).toEqual([pods[0]]);
    expect(judgedPods(pods, null)).toEqual([]);
  });
});

describe("judgeProbes", () => {
  it("is healthy when /ready is 200 and Connect serves HTML", () => {
    expect(judgeProbes({ ...ok, contentType: "text/plain" }, ok)).toEqual({ health: "healthy", check: null, reason: null });
  });
  it("treats 503 as starting (migrations), anything else as unhealthy", () => {
    expect(judgeProbes({ status: 503, contentType: null, error: null }, null)).toEqual({
      health: "unknown",
      check: "switchboard",
      reason: "the switchboard is starting (migrations)",
    });
    expect(judgeProbes({ status: 502, contentType: null, error: null }, null)).toEqual({
      health: "unhealthy",
      check: "switchboard",
      reason: "/ready answered 502",
    });
    expect(judgeProbes({ status: null, contentType: null, error: "timeout" }, null).reason).toBe("/ready did not answer (timeout)");
  });
  it("fails Connect that does not serve its page", () => {
    expect(judgeProbes(ok, { status: 500, contentType: "text/html", error: null })).toEqual({
      health: "unhealthy",
      check: "connect",
      reason: "Connect answered 500",
    });
    expect(judgeProbes(ok, { status: 200, contentType: "application/json", error: null }).check).toBe("connect");
  });
});

describe("observedDigest", () => {
  it("prefers a ready pod on the wanted digest, then any ready pod, by imageID", () => {
    expect(observedDigest([pod()], A, `1.5.0@${A}`)).toEqual({ digest: A, source: "pod" });
    const old = pod({ image: `${REPO}:1.4.0@${B}`, imageId: `${REPO}@${B}` });
    expect(observedDigest([old, pod({ ready: false })], A, `1.5.0@${A}`)).toEqual({ digest: B, source: "pod" });
  });
  it("falls back to the document when the ready pod reports no imageID", () => {
    expect(observedDigest([pod({ imageId: null })], A, `1.5.0@${A}`)).toEqual({ digest: A, source: "document" });
  });
  it("is null when nothing is ready", () => {
    expect(observedDigest([pod({ ready: false })], A, `1.5.0@${A}`)).toEqual({ digest: null, source: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts 2>&1 | tail -5`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `subgraphs/vetra-apps/instances/health.ts`:

```ts
import type { InstanceHealth } from "../db/schema.js";

/** Spec 14.7, as measured from the cluster and the host (see plan 3's table). Pure. */
export type HealthCheck =
  | "gitops"
  | "image"
  | "crash"
  | "restarts"
  | "pod"
  | "switchboard"
  | "connect"
  | "stopped"
  | "data";

export interface HealthVerdict {
  health: InstanceHealth;
  check: HealthCheck | null;
  reason: string | null;
}

export interface PodSnapshot {
  /** Upper case, as observability stores it (RUNNING, PENDING, FAILED, …). */
  phase: string;
  ready: boolean;
  restartCount: number;
  image: string | null;
  imageId: string | null;
  waitingReason: string | null;
}

export interface ArgoSnapshot {
  syncStatus: string;
  healthStatus: string;
  /** An Argo ComparisonError condition: the manifests do not render. */
  drift: boolean;
  message: string | null;
}

export interface ProbeResult {
  status: number | null;
  contentType: string | null;
  error: string | null;
}

export const NO_DATA: HealthVerdict = {
  health: "unknown",
  check: "data",
  reason: "no cluster data for the environment yet",
};
export const STOPPED: HealthVerdict = {
  health: "unknown",
  check: "stopped",
  reason: "the environment is stopped",
};
const HEALTHY: HealthVerdict = { health: "healthy", check: null, reason: null };

const PULL_FAILURES = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull"]);
const CRASH_FAILURES = new Set([
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);
const DEAD_PHASES = new Set(["SUCCEEDED", "FAILED"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The digest after the last `@` of an image reference or tag (`<version>@<digest>`), if well formed. */
export function digestOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const d = ref.slice(ref.lastIndexOf("@") + 1);
  return ref.includes("@") && DIGEST.test(d) ? d : null;
}

/** Live pods whose spec pulls the wanted digest. */
export function judgedPods(pods: PodSnapshot[], wanted: string | null): PodSnapshot[] {
  if (!wanted) return [];
  return pods.filter((p) => !DEAD_PHASES.has(p.phase) && digestOf(p.image) === wanted);
}

/** Checks 1-7. Null: the cluster has nothing against the instance; probe it. */
export function judgeCluster(
  argo: ArgoSnapshot | null,
  judged: PodSnapshot[],
  previousRestarts: number | null,
): HealthVerdict | null {
  if (argo && (argo.drift || argo.syncStatus === "UNKNOWN"))
    return {
      health: "unhealthy",
      check: "gitops",
      reason: `Argo CD cannot apply the environment${argo.message ? ` (${argo.message.slice(0, 200)})` : ""}`,
    };
  if (!argo && judged.length === 0) return NO_DATA;
  const waiting = judged.map((p) => p.waitingReason).filter((r): r is string => !!r);
  const pull = waiting.find((r) => PULL_FAILURES.has(r));
  if (pull) return { health: "unhealthy", check: "image", reason: `the image cannot be pulled (${pull})` };
  const crash = waiting.find((r) => CRASH_FAILURES.has(r));
  if (crash) return { health: "unhealthy", check: "crash", reason: `the container does not start (${crash})` };
  const restarts = judged.reduce((n, p) => n + p.restartCount, 0);
  if (previousRestarts !== null && restarts > previousRestarts)
    return { health: "unhealthy", check: "restarts", reason: `the container restarted (${restarts} restarts)` };
  if (judged.length === 0) return { health: "unknown", check: "pod", reason: "no pod runs the target image yet" };
  if (!judged.every((p) => p.ready && p.phase === "RUNNING"))
    return { health: "unknown", check: "pod", reason: "the pod is starting" };
  return null;
}

const answer = (p: ProbeResult) => (p.status !== null ? `answered ${p.status}` : `did not answer (${p.error ?? "no response"})`);

/** Checks 8-10: the switchboard's readiness (migrations done), then Connect's page. */
export function judgeProbes(ready: ProbeResult, connect: ProbeResult | null): HealthVerdict {
  if (ready.status === 503)
    return { health: "unknown", check: "switchboard", reason: "the switchboard is starting (migrations)" };
  if (ready.status !== 200) return { health: "unhealthy", check: "switchboard", reason: `/ready ${answer(ready)}` };
  const servesPage =
    !!connect &&
    connect.status !== null &&
    connect.status >= 200 &&
    connect.status < 300 &&
    (connect.contentType ?? "").includes("text/html");
  if (!servesPage)
    return {
      health: "unhealthy",
      check: "connect",
      reason: connect && connect.status !== null && connect.status >= 200 && connect.status < 300
        ? `Connect answered ${connect.status} without a page`
        : `Connect ${connect ? answer(connect) : "was not asked"}`,
    };
  return HEALTHY;
}

/**
 * What the cluster runs (spec 6 "running digest"): a ready pod's imageID,
 * the wanted digest first. Until the host reports its own version (spec 15,
 * gap 8) this is the best evidence; the document's tag only stands in when
 * the ready pod has no imageID yet.
 */
export function observedDigest(
  hostPods: PodSnapshot[],
  wanted: string | null,
  documentVersion: string | null,
): { digest: string | null; source: "pod" | "document" | null } {
  const ready = hostPods.filter((p) => p.ready && p.phase === "RUNNING");
  if (ready.length === 0) return { digest: null, source: null };
  const ids = ready.map((p) => digestOf(p.imageId)).filter((d): d is string => !!d);
  if (ids.length > 0) return { digest: wanted && ids.includes(wanted) ? wanted : ids[0], source: "pod" };
  return { digest: digestOf(documentVersion), source: "document" };
}
```

Note (Task 0 Step 3): if Harbor serves an index and `imageID` carries a different digest than the spec, change `observedDigest` to read `digestOf(p.image)` for pods whose `imageId` is set (the spec digest, proven running by the presence of an `imageID`), and its test accordingly.

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps/instances/health.ts subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts && git commit -m "feat(instances): health verdict from cluster signals and host probes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 4: Cluster reads, the HTTP probe and their wiring

**Files:**
- Create: `subgraphs/vetra-apps/instances/cluster.ts`, `subgraphs/vetra-apps/instances/probe.ts`
- Modify: `subgraphs/vetra-apps/service.ts` (`AppsDeps`), `subgraphs/vetra-apps/envs.ts` (`tenantOfIn`), `subgraphs/vetra-apps/index.ts` (deps), `subgraphs/vetra-apps/__tests__/harness.ts`
- Test: `subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts` (append `readCluster` cases)

**Interfaces:**
- Consumes: `PodSnapshot`, `ArgoSnapshot`, `ProbeResult` (Task 3); observability columns (Task 1).
- Produces:
  - `readCluster(db: Kysely<ObservabilityDB>, tenantId: string, repository: string | null): Promise<{ argo: ArgoSnapshot | null; hostPods: PodSnapshot[] } | null>` (null: no rows at all)
  - `type HttpProbe = (url: string) => Promise<ProbeResult>`, `fetchProbe: HttpProbe`, `PROBE_TIMEOUT_MS = 5000`
  - `tenantOfIn(db: Kysely<EnvironmentsDB>): (environmentId: string) => Promise<string | null>`
  - `AppsDeps.observabilityDb?`, `AppsDeps.envTenant?`, `AppsDeps.probe?`
  - Harness: `h.tenants: Map<string, string>`, `h.probes: Map<string, ProbeResult>`, `h.probed: string[]`

- [ ] **Step 1: Write the failing test** (append to `instances-health-verdict.test.ts`):

```ts
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up as upObservability } from "../../vetra-cloud-observability/db/migrations.js";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import { readCluster } from "../instances/cluster.js";

describe("readCluster", () => {
  it("returns Argo's view and the tenant's host pods only", async () => {
    const db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
    await upObservability(db as Kysely<any>);
    const at = "2026-11-12T00:00:00.000Z";
    expect(await readCluster(db, "t1", REPO)).toBeNull();
    await db.insertInto("environment_status").values({
      tenantId: "t1", argoSyncStatus: "SYNCED", argoHealthStatus: "HEALTHY", argoLastSyncedAt: at,
      argoMessage: null, configDriftDetected: 1, tlsCertValid: null, tlsCertExpiresAt: null,
      domainResolves: null, updatedAt: at,
    }).execute();
    const base = { tenantId: "t1", service: "OTHER", component: null, agent: null, phase: "RUNNING", ready: 1, restartCount: 2, imageId: null, waitingReason: null, updatedAt: at };
    await db.insertInto("environment_pods").values([
      { ...base, id: "t1/app", name: "app", image: `${REPO}:1.5.0@${A}` },
      { ...base, id: "t1/db-1", name: "db-1", image: "ghcr.io/cloudnative-pg/postgresql:16" },
      { ...base, id: "t2/app", tenantId: "t2", name: "app", image: `${REPO}:1.5.0@${A}` },
    ]).execute();
    const view = await readCluster(db, "t1", REPO);
    expect(view!.argo).toEqual({ syncStatus: "SYNCED", healthStatus: "HEALTHY", drift: true, message: null });
    expect(view!.hostPods).toEqual([
      { phase: "RUNNING", ready: true, restartCount: 2, image: `${REPO}:1.5.0@${A}`, imageId: null, waitingReason: null },
    ]);
    await db.destroy();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts 2>&1 | tail -5`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

`instances/cluster.ts`:

```ts
import type { Kysely } from "kysely";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import type { ArgoSnapshot, PodSnapshot } from "./health.js";

/**
 * The cluster as the observability subgraph records it (its watchers keep
 * these tables; nothing here talks to Kubernetes). Host pods are the tenant's
 * pods whose image is the environment's FUSION repository; database and
 * helper pods are left out. Null: no row at all for the tenant.
 */
export async function readCluster(
  db: Kysely<ObservabilityDB>,
  tenantId: string,
  repository: string | null,
): Promise<{ argo: ArgoSnapshot | null; hostPods: PodSnapshot[] } | null> {
  const argo = await db
    .selectFrom("environment_status")
    .select(["argoSyncStatus", "argoHealthStatus", "argoMessage", "configDriftDetected"])
    .where("tenantId", "=", tenantId)
    .executeTakeFirst();
  const pods = await db
    .selectFrom("environment_pods")
    .select(["phase", "ready", "restartCount", "image", "imageId", "waitingReason"])
    .where("tenantId", "=", tenantId)
    .orderBy("id")
    .execute();
  if (!argo && pods.length === 0) return null;
  const isHost = (image: string | null | undefined) =>
    !!repository && !!image && (image.startsWith(`${repository}:`) || image.startsWith(`${repository}@`));
  return {
    argo: argo
      ? {
          syncStatus: argo.argoSyncStatus,
          healthStatus: argo.argoHealthStatus,
          drift: Number(argo.configDriftDetected) === 1,
          message: argo.argoMessage,
        }
      : null,
    hostPods: pods
      .filter((p) => isHost(p.image))
      .map((p) => ({
        phase: p.phase,
        ready: Number(p.ready) === 1,
        restartCount: Number(p.restartCount),
        image: p.image ?? null,
        imageId: p.imageId ?? null,
        waitingReason: p.waitingReason ?? null,
      })),
  };
}
```

`instances/probe.ts`:

```ts
import type { ProbeResult } from "./health.js";

export type HttpProbe = (url: string) => Promise<ProbeResult>;

export const PROBE_TIMEOUT_MS = 5_000;

/** One GET, no redirects followed, body discarded, 5 s at most. Never throws. */
export const fetchProbe: HttpProbe = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "vetra-instance-health/1" },
    });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, contentType: res.headers.get("content-type"), error: null };
  } catch (err) {
    const e = err as Error;
    const error = e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? err);
    return { status: null, contentType: null, error: error.slice(0, 200) };
  }
};
```

`service.ts`, in `AppsDeps` after `orgHandoverDb` (import `type HttpProbe` from `"./instances/probe.js"`):

```ts
  /** Observability tables instance health reads (environment_status, environment_pods). Absent: health is "unknown (data)". */
  observabilityDb?: Kysely<ObservabilityDB> | null;
  /** An environment's tenant id (its namespace) from the processor's read model. Absent: health is "unknown (data)". */
  envTenant?: ((environmentId: string) => Promise<string | null>) | null;
  /** The GET instance health probes use. Absent: no probes; a host the cluster calls ready stays "unknown (data)". */
  probe?: HttpProbe | null;
```

`envs.ts`, beside `subdomainUsedIn`:

```ts
/** The processor's tenant id for an environment (null: not rendered yet). */
export function tenantOfIn(
  db: Kysely<EnvironmentsDB>,
): (environmentId: string) => Promise<string | null> {
  return async (id) =>
    (
      await db
        .selectFrom("environments")
        .select("tenantId")
        .where("id", "=", id)
        .executeTakeFirst()
    )?.tenantId ?? null;
}
```

`index.ts`: import `tenantOfIn` with `subdomainUsedIn`, `fetchProbe` from `"./instances/probe.js"`; in the `deps` literal next to `orgHandoverDb,` add:

```ts
      observabilityDb: orgHandoverDb,
      envTenant: tenantOfIn(envReadModel),
      probe: fetchProbe,
```

`__tests__/harness.ts`: in `makeHarness` before `deps`:

```ts
  const tenants = new Map<string, string>();
  const probes = new Map<string, ProbeResult>();
  const probed: string[] = [];
```

add to `deps`:

```ts
    observabilityDb: obsDb,
    envTenant: async (id) => tenants.get(id) ?? null,
    probe: async (url) => {
      probed.push(url);
      return (
        probes.get(url) ?? {
          status: 200,
          contentType: url.endsWith("/") ? "text/html; charset=utf-8" : "text/plain",
          error: null,
        }
      );
    },
```

add `tenants: Map<string, string>; probes: Map<string, ProbeResult>; probed: string[];` to `Harness` and `tenants, probes, probed,` to the returned object; import `type ProbeResult` from `"../instances/health.js"`.

- [ ] **Step 4: Run to verify.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health-verdict.test.ts 2>&1 | tail -5` → PASS; `npm run tsc 2>&1 | tail -10` → no errors.

- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): read cluster health from observability; host probe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 5: The health monitor pass

**Files:**
- Create: `subgraphs/vetra-apps/instances/monitor.ts`
- Modify: `subgraphs/vetra-apps/instances/repo.ts` (`listDueForHealth`, `recordHealth`, `HealthRecord`)
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts` (export `ours`)
- Modify: `subgraphs/vetra-apps/index.ts` (timer)
- Test: `subgraphs/vetra-apps/__tests__/instances-health.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2-4; `ours(state, row)` and `INSTANCE_BASE_DOMAIN` from `reconciler.ts`.
- Produces: `monitorInstancesOnce(deps: AppsDeps): Promise<number>` (instances checked), `PROBE_EVERY_MS = 30_000`, `pickDue<T extends { app_id: string }>(rows: T[], perPass: number, perApp: number): T[]`; repo `listDueForHealth(db, dueBeforeIso: string, limit: number): Promise<InstanceRow[]>`, `recordHealth(db, id: string, r: HealthRecord): Promise<void>`.

- [ ] **Step 1: Write the failing test** `subgraphs/vetra-apps/__tests__/instances-health.test.ts`. The helpers at the top are reused by Task 6's tests in the same file.

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, seedActiveApp, testConfig, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import type { InstanceHealthConfig } from "../config.js";
import { listInstances } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { monitorInstancesOnce, pickDue, PROBE_EVERY_MS } from "../instances/monitor.js";

let h: Harness;
let appId: string;
let slug: string;

async function setup(health: Partial<InstanceHealthConfig> = {}) {
  h = await makeHarness(
    testConfig({
      instances: {
        enabled: true,
        labelSuffix: "",
        health: { mode: "report", unhealthyWindowMs: 300_000, probesPerPass: 10, probesPerApp: 3, ...health },
      },
    }),
  );
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
}
afterEach(async () => {
  // pickDue's tests make no harness.
  await h?.close();
  h = undefined as unknown as Harness;
});

const one = async () => (await listInstances(h.db, appId))[0];
const repo = () => `cr.vetra.io/acme/${slug}`;
const url = async (path: string) => `https://${(await one()).host}.vetra.io${path}`;

type Pod = { digest: string; ready?: boolean; restarts?: number; waiting?: string | null; imageId?: boolean };
/** What observability would hold for the instance's tenant. */
async function setCluster(envId: string, pods: Pod[], argo: { drift?: boolean; message?: string } = {}) {
  const tenantId = `t-${envId}`;
  h.tenants.set(envId, tenantId);
  await h.obsDb.deleteFrom("environment_pods").where("tenantId", "=", tenantId).execute();
  await h.obsDb.deleteFrom("environment_status").where("tenantId", "=", tenantId).execute();
  const at = h.clock.now.toISOString();
  await h.obsDb.insertInto("environment_status").values({
    tenantId, argoSyncStatus: argo.drift ? "UNKNOWN" : "SYNCED", argoHealthStatus: "HEALTHY",
    argoLastSyncedAt: at, argoMessage: argo.message ?? null, configDriftDetected: argo.drift ? 1 : 0,
    tlsCertValid: null, tlsCertExpiresAt: null, domainResolves: null, updatedAt: at,
  }).execute();
  for (const [i, p] of pods.entries())
    await h.obsDb.insertInto("environment_pods").values({
      id: `${tenantId}/app-${i}`, tenantId, name: `app-${i}`, service: "OTHER", component: "app", agent: null,
      phase: "RUNNING", ready: p.ready === false ? 0 : 1, restartCount: p.restarts ?? 0,
      image: `${repo()}:v@${p.digest}`, imageId: p.imageId === false ? null : `${repo()}@${p.digest}`,
      waitingReason: p.waiting ?? null, updatedAt: at,
    }).execute();
}

/** One instance on build a, its environment READY (the document's word only). */
async function created() {
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
  await reconcileInstancesOnce(h.deps);
  const envId = (await one()).environment_id!;
  h.envs.setStatus(envId, "READY");
  return envId;
}

const monitor = async (ms = PROBE_EVERY_MS + 1) => {
  h.advance(ms);
  return monitorInstancesOnce(h.deps);
};

describe("monitorInstancesOnce", () => {
  beforeEach(() => setup());

  it("records a healthy verdict, the observed digest from the pod, and leaves status and updated_at alone", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    const before = await one();
    expect(await monitor()).toBe(1);
    const row = await one();
    expect(row).toMatchObject({
      health: "healthy", health_check: null, health_reason: null, health_digest: digest("a"),
      health_restarts: 0, observed_digest: digest("a"), observed_digest_source: "pod",
      status: before.status, updated_at: before.updated_at,
    });
    expect(row.health_since).toBe(row.health_checked_at);
    expect(h.probed).toEqual([await url("/ready"), await url("/")]);
  });

  it("calls a crash loop unhealthy without probing the host", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a"), ready: false, restarts: 3, waiting: "CrashLoopBackOff" }]);
    await monitor();
    expect(await one()).toMatchObject({ health: "unhealthy", health_check: "crash", health_restarts: 3 });
    expect(h.probed).toEqual([]);
  });

  it("catches a restart between two checks", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a"), restarts: 1 }]);
    await monitor();
    await setCluster(envId, [{ digest: digest("a"), restarts: 2 }]);
    await monitor();
    expect(await one()).toMatchObject({ health: "unhealthy", health_check: "restarts" });
  });

  it("calls a render error unhealthy even while the old pods serve", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("0") }], { drift: true, message: "helm template failed" });
    await monitor();
    expect(await one()).toMatchObject({ health: "unhealthy", health_check: "gitops" });
  });

  it("falls back to /health on images without /ready, and fails Connect errors", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    h.probes.set(await url("/ready"), { status: 404, contentType: null, error: null });
    h.probes.set(await url("/"), { status: 500, contentType: "text/html", error: null });
    await monitor();
    expect(h.probed).toEqual([await url("/ready"), await url("/health"), await url("/")]);
    expect(await one()).toMatchObject({ health: "unhealthy", health_check: "connect", health_reason: "Connect answered 500" });
  });

  it("knows nothing without a tenant, and says so", async () => {
    await created();
    await monitor();
    expect(await one()).toMatchObject({ health: "unknown", health_check: "data" });
  });

  it("does not check an instance again within 30 s", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    await monitor();
    expect(await monitor(1000)).toBe(0);
  });

  it("never reads or probes an environment a licence manages", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    await h.envs.manage(envId);
    await monitor();
    expect(h.probed).toEqual([]);
    expect((await one()).health).toBeNull();
  });

  it("does nothing when health is off", async () => {
    await h.close();
    await setup({ mode: "off" });
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a") }]);
    expect(await monitor()).toBe(0);
  });
});

describe("pickDue", () => {
  it("caps per pass and per app, oldest first", () => {
    const rows = ["a", "a", "a", "a", "b", "c"].map((app_id, i) => ({ app_id, i }));
    expect(pickDue(rows, 4, 3).map((r) => r.i)).toEqual([0, 1, 2, 4]);
    expect(pickDue(rows, 10, 1).map((r) => r.i)).toEqual([0, 4, 5]);
  });
});
```

(Check `seedRelease`'s `digest` default: `digest("a")`, so build 1 is on `digest("a")`.)

- [ ] **Step 2: Run to verify it fails.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health.test.ts 2>&1 | tail -5`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

`reconciler.ts`: change `function ours(` to `export function ours(` (no other change).

`repo.ts`:

```ts
export interface HealthRecord {
  health: InstanceHealth;
  health_check: string | null;
  health_reason: string | null;
  health_checked_at: string;
  health_since: string;
  health_digest: string | null;
  health_restarts: number | null;
  observed_digest: string | null;
  observed_digest_source: "pod" | "document" | null;
}

/** Live instances with an environment and a host, not checked since dueBeforeIso, never-checked first. */
export async function listDueForHealth(
  db: Kysely<VetraAppsDB>,
  dueBeforeIso: string,
  limit: number,
): Promise<InstanceRow[]> {
  const rows = await db
    .selectFrom("instances")
    .selectAll()
    .where("environment_id", "is not", null)
    .where("host", "is not", null)
    .where("removed_at", "is", null)
    .where("status", "!=", "removed")
    .where((eb) => eb.or([eb("health_checked_at", "is", null), eb("health_checked_at", "<", dueBeforeIso)]))
    .orderBy("health_checked_at", (ob) => ob.asc().nullsFirst())
    .orderBy("id")
    .limit(limit)
    .execute();
  return rows.map(normalize);
}

/** Health columns only: never status, reason, targets or updated_at; a row removed meanwhile is left alone. */
export async function recordHealth(db: Kysely<VetraAppsDB>, id: string, r: HealthRecord): Promise<void> {
  await db.updateTable("instances").set(r).where("id", "=", id).where("removed_at", "is", null).execute();
}
```

(import `InstanceHealth` from `"../db/schema.js"`.)

`instances/monitor.ts`:

```ts
import { instanceHealth } from "../config.js";
import type { AppsDeps } from "../service.js";
import { readCluster } from "./cluster.js";
import {
  digestOf,
  judgeCluster,
  judgedPods,
  judgeProbes,
  NO_DATA,
  observedDigest,
  STOPPED,
  type HealthVerdict,
  type ProbeResult,
} from "./health.js";
import type { HttpProbe } from "./probe.js";
import { INSTANCE_BASE_DOMAIN, ours } from "./reconciler.js";
import { listDueForHealth, recordHealth, type InstanceRow } from "./repo.js";

/** An instance is checked at most this often. */
export const PROBE_EVERY_MS = 30_000;
const PARALLEL = 4;

/** At most perPass rows, at most perApp of one app, in the given (oldest-checked-first) order. */
export function pickDue<T extends { app_id: string }>(rows: T[], perPass: number, perApp: number): T[] {
  const taken = new Map<string, number>();
  const out: T[] = [];
  for (const r of rows) {
    if (out.length >= perPass) break;
    const n = taken.get(r.app_id) ?? 0;
    if (n >= perApp) continue;
    taken.set(r.app_id, n + 1);
    out.push(r);
  }
  return out;
}

async function inParallel<T>(items: T[], n: number, run: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

async function probeHost(probe: HttpProbe, base: string): Promise<{ ready: ProbeResult; connect: ProbeResult | null }> {
  let ready = await probe(`${base}/ready`);
  // Switchboards before 6.2.0-dev.4 have no /ready; /health only says the process is up.
  if (ready.status === 404) ready = await probe(`${base}/health`);
  if (ready.status !== 200) return { ready, connect: null };
  return { ready, connect: await probe(`${base}/`) };
}

/**
 * One health pass (spec 14.7): judges due instances from the cluster
 * (observability's tables) and, when the cluster shows a ready pod on the
 * wanted digest, from the host itself. Writes health columns only; never an
 * environment, never status (the reconciler decides that). Runs outside the
 * per-app lock. Returns how many instances were checked.
 */
export async function monitorInstancesOnce(deps: AppsDeps): Promise<number> {
  const cfg = instanceHealth(deps.cfg);
  if (!deps.cfg.instances.enabled || cfg.mode === "off") return 0;
  const now = deps.now();
  const due = await listDueForHealth(
    deps.db,
    new Date(now.getTime() - PROBE_EVERY_MS).toISOString(),
    cfg.probesPerPass * 5,
  );
  const picked = pickDue(due, cfg.probesPerPass, cfg.probesPerApp);
  let checked = 0;
  await inParallel(picked, PARALLEL, async (row) => {
    try {
      if (await checkInstance(deps, row)) checked++;
    } catch (err) {
      deps.logger.warn(`[vetra-apps] health of instance ${row.id}: ${String(err).slice(0, 300)}`);
    }
  });
  return checked;
}

async function checkInstance(deps: AppsDeps, row: InstanceRow): Promise<boolean> {
  const state = await deps.envs.getState(row.environment_id!);
  // Gone (the reconciler recreates it), or not this App's instance: never read, never probed.
  if (!state || !ours(state, row)) return false;
  const version = state.services.find((s) => s.type === "FUSION")?.version ?? null;
  const wanted = digestOf(version);
  let verdict: HealthVerdict = NO_DATA;
  let restarts: number | null = null;
  let observed: { digest: string | null; source: "pod" | "document" | null } = { digest: null, source: null };

  if (state.status === "STOPPED") verdict = STOPPED;
  else {
    const tenant = deps.envTenant ? await deps.envTenant(row.environment_id!) : null;
    const cluster =
      tenant && deps.observabilityDb
        ? await readCluster(deps.observabilityDb, tenant, state.fusion?.image ?? null)
        : null;
    if (cluster) {
      const judged = judgedPods(cluster.hostPods, wanted);
      restarts = judged.reduce((n, p) => n + p.restartCount, 0);
      observed = observedDigest(cluster.hostPods, wanted, version);
      const previous = row.health_digest === wanted ? row.health_restarts : null;
      const fromCluster = judgeCluster(cluster.argo, judged, previous);
      if (fromCluster) verdict = fromCluster;
      else if (deps.probe) {
        const p = await probeHost(deps.probe, `https://${row.host}.${INSTANCE_BASE_DOMAIN}`);
        verdict = judgeProbes(p.ready, p.connect);
      } else verdict = { ...NO_DATA, reason: "host probes are not configured" };
    }
  }

  const at = deps.now().toISOString();
  const flipped =
    row.health === null ||
    row.health_digest !== wanted ||
    (row.health === "healthy") !== (verdict.health === "healthy");
  await recordHealth(deps.db, row.id, {
    health: verdict.health,
    health_check: verdict.check,
    health_reason: verdict.reason,
    health_checked_at: at,
    health_since: flipped || !row.health_since ? at : row.health_since,
    health_digest: wanted,
    health_restarts: restarts,
    observed_digest: observed.digest,
    observed_digest_source: observed.source,
  });
  return true;
}
```

Note: `judgeCluster` returns `null` only when the cluster has nothing against the instance (a ready pod on the wanted digest); only then is the host probed. Its own `NO_DATA` (no Argo row, no judged pod) is kept and never probed.

`index.ts`, inside `if (cfg.instances.enabled) {` after the instance reconciler timer (import `monitorInstancesOnce` from `"./instances/monitor.js"`):

```ts
      every(WATCH_INTERVAL_MS, "instance health", () =>
        monitorInstancesOnce(deps),
      );
```

- [ ] **Step 4: Run to verify it passes.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-health.test.ts 2>&1 | grep -E "FAIL|Tests" | tail`. Expected: PASS.

- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): health monitor pass with bounded probes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 6: Status from health (enforce), degraded, revert on unhealthy updates

**Files:**
- Modify: `subgraphs/vetra-apps/instances/status.ts`
- Modify: `subgraphs/vetra-apps/instances/reconciler.ts` (`reconcileEnvironment`, the block after `const seen = observeEnvironment(…)`)
- Test: `subgraphs/vetra-apps/__tests__/instances-status.test.ts`, `subgraphs/vetra-apps/__tests__/instances-health.test.ts`

**Interfaces:**
- Consumes: health columns (Task 2) written by the monitor (Task 5); `instanceHealth` (Task 2).
- Produces: `Observation` gains `{ kind: "degraded"; reason: string }` and `{ kind: "unchanged" }`; `HealthView`, `healthView(row: InstanceRow): HealthView`; `observeHealth(state, target: { tag: string; digest: string }, row: { update_started_at: string | null; running_digest: string | null }, h: HealthView, now: Date, unhealthyWindowMs: number): Observation`; constants `HEALTH_STABLE_MS = 120_000`, `DEGRADED_AFTER_MS = 60_000`, `CONFIRM_MS = 30_000`, `HEALTH_STALE_MS = 180_000`.

- [ ] **Step 1: Write the failing tests.**

`instances-status.test.ts` (append; reuse the file's `state`, `TAG`, `now`, `started`):

```ts
import { CONFIRM_MS, DEGRADED_AFTER_MS, HEALTH_STABLE_MS, observeHealth, type HealthView } from "../instances/status.js";

describe("observeHealth", () => {
  const D = `sha256:${"a".repeat(64)}`;
  const OLD = `sha256:${"0".repeat(64)}`;
  const W = 300_000;
  const view = (over: Partial<HealthView>): HealthView => ({
    health: "healthy", check: null, reason: null, checkedAt: started(1000), since: started(HEALTH_STABLE_MS + 1000),
    digest: D, observedDigest: D, ...over,
  });
  const inFlight = { update_started_at: started(W + 60_000), running_digest: OLD };
  const steady = { update_started_at: started(3_600_000), running_digest: D };
  const target = { tag: TAG, digest: D };

  it("is ready only when healthy for 2 minutes on the target digest", () => {
    expect(observeHealth(state("READY"), target, inFlight, view({}), now, W)).toEqual({ kind: "ready" });
    expect(observeHealth(state("READY"), target, inFlight, view({ since: started(10_000) }), now, W)).toEqual({ kind: "updating" });
    expect(observeHealth(state("READY"), target, inFlight, view({ observedDigest: OLD }), now, W)).toEqual({ kind: "updating" });
  });
  it("ignores the document: DEPLOYMENt_FAILED but healthy is ready, READY but crashing is not", () => {
    expect(observeHealth(state("DEPLOYMENt_FAILED"), target, inFlight, view({}), now, W)).toEqual({ kind: "ready" });
    const crash = view({ health: "unhealthy", check: "crash", reason: "the container does not start (CrashLoopBackOff)", since: started(CONFIRM_MS + 1) });
    expect(observeHealth(state("READY"), target, inFlight, crash, now, W)).toEqual({
      kind: "failed",
      reason: "unhealthy (crash: the container does not start (CrashLoopBackOff))",
    });
  });
  it("gives an update the window, and a single bad check never fails it", () => {
    const bad = view({ health: "unhealthy", check: "connect", reason: "Connect answered 500", since: started(CONFIRM_MS + 1) });
    expect(observeHealth(state("READY"), target, { ...inFlight, update_started_at: started(W - 1000) }, bad, now, W)).toEqual({ kind: "updating" });
    expect(observeHealth(state("READY"), target, inFlight, { ...bad, since: started(1000) }, now, W)).toEqual({ kind: "updating" });
  });
  it("never fails a starting host before the 20-minute timeout", () => {
    const starting = view({ health: "unknown", check: "switchboard", reason: "the switchboard is starting (migrations)", since: started(W * 2) });
    expect(observeHealth(state("READY"), target, inFlight, starting, now, W)).toEqual({ kind: "updating" });
    expect(observeHealth(state("READY"), target, { ...inFlight, update_started_at: started(UPDATE_TIMEOUT_MS + 1) }, starting, now, W)).toEqual({
      kind: "failed",
      reason: "not healthy after 20 minutes (switchboard: the switchboard is starting (migrations))",
    });
  });
  it("does not trust a check from before the update or about another digest", () => {
    const old = view({ checkedAt: started(W + 120_000) });
    expect(observeHealth(state("READY"), target, inFlight, old, now, W)).toEqual({ kind: "updating" });
    expect(observeHealth(state("READY"), target, inFlight, view({ digest: OLD }), now, W)).toEqual({ kind: "updating" });
  });
  it("degrades a steady instance that is not healthy for a minute, never fails it", () => {
    const down = view({ health: "unknown", check: "pod", reason: "the pod is starting", since: started(DEGRADED_AFTER_MS + 1) });
    expect(observeHealth(state("READY"), target, steady, down, now, W)).toEqual({ kind: "degraded", reason: "pod: the pod is starting" });
    expect(observeHealth(state("READY"), target, steady, { ...down, since: started(1000) }, now, W)).toEqual({ kind: "unchanged" });
    expect(observeHealth(state("READY"), target, steady, { ...down, check: "data" }, now, W)).toEqual({ kind: "unchanged" });
    expect(observeHealth(state("READY"), target, steady, view({ checkedAt: started(600_000) }), now, W)).toEqual({ kind: "unchanged" });
  });
  it("keeps stopped and gone environments as before", () => {
    expect(observeHealth(state("STOPPED"), target, steady, view({}), now, W)).toEqual({ kind: "stopped" });
    expect(observeHealth(state("DESTROYED"), target, steady, view({}), now, W).kind).toBe("failed");
  });
});
```

`instances-health.test.ts` (append):

```ts
import { DEGRADED_AFTER_MS, HEALTH_STABLE_MS } from "../instances/status.js";

const WINDOW = 300_000;
/** One health check then one reconciler pass, ms later. */
const pass = async (ms = PROBE_EVERY_MS + 1) => {
  await monitor(ms);
  await reconcileInstancesOnce(h.deps);
};
const fusionVersion = async (envId: string) =>
  (await h.envs.getState(envId))!.services.find((s) => s.type === "FUSION")!.version;

/** Instance ready on build a by health (enforce). */
async function readyHealthy() {
  const envId = await created();
  await setCluster(envId, [{ digest: digest("a") }]);
  await pass();
  expect((await one()).status).toBe("updating");
  await pass(HEALTH_STABLE_MS);
  expect(await one()).toMatchObject({ status: "ready", running_digest: digest("a") });
  return envId;
}
async function updateToB() {
  await seedRelease(h, appId, { version: "1.5.0-main.2", run: 200, digest: digest("b") });
  await reconcileInstancesOnce(h.deps);
  expect((await one()).status).toBe("updating");
}

describe("enforce: status follows health", () => {
  beforeEach(() => setup({ mode: "enforce", unhealthyWindowMs: WINDOW }));

  it("never calls a crash-looping first deploy ready, and fails it after the window", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a"), ready: false, restarts: 3, waiting: "CrashLoopBackOff" }]);
    await pass();
    expect((await one()).status).toBe("updating");
    await pass(WINDOW);
    expect(await one()).toMatchObject({ status: "failed", reason: "unhealthy (crash: the container does not start (CrashLoopBackOff))" });
  });

  it("fails a crashing update and goes back to the last healthy digest", async () => {
    const envId = await readyHealthy();
    await updateToB();
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.2@${digest("b")}`);
    await setCluster(envId, [{ digest: digest("a") }, { digest: digest("b"), ready: false, restarts: 2, waiting: "CrashLoopBackOff" }]);
    await pass();
    await pass(WINDOW);
    expect(await one()).toMatchObject({ status: "failed", failed_digest: digest("b"), running_digest: digest("a") });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("fails an update Argo cannot render and goes back", async () => {
    const envId = await readyHealthy();
    await updateToB();
    await setCluster(envId, [{ digest: digest("a") }], { drift: true, message: "helm template failed" });
    await pass();
    await pass(WINDOW);
    expect(await one()).toMatchObject({ status: "failed", reason: "unhealthy (gitops: Argo CD cannot apply the environment (helm template failed))" });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("degrades a ready instance that stops serving, without touching it, then recovers", async () => {
    const envId = await readyHealthy();
    const writes = h.envs.executed.length;
    await setCluster(envId, [{ digest: digest("a"), ready: false }]);
    await pass();
    expect((await one()).status).toBe("ready");
    await pass(DEGRADED_AFTER_MS);
    expect(await one()).toMatchObject({ status: "degraded", reason: "pod: the pod is starting", health: "unknown" });
    await setCluster(envId, [{ digest: digest("a") }]);
    await pass();
    expect((await one()).status).toBe("degraded");
    await pass(HEALTH_STABLE_MS);
    expect(await one()).toMatchObject({ status: "ready", reason: null });
    expect(h.envs.executed.length).toBe(writes);
  });

  it("shows an owner stop as stopped, and the start as degraded until healthy", async () => {
    const envId = await readyHealthy();
    h.envs.setStatus(envId, "STOPPED");
    await pass();
    expect((await one()).status).toBe("stopped");
    h.envs.setStatus(envId, "DEPLOYING");
    await setCluster(envId, [{ digest: digest("a"), ready: false }]);
    await pass();
    await pass(DEGRADED_AFTER_MS);
    expect((await one()).status).toBe("degraded");
    await setCluster(envId, [{ digest: digest("a") }]);
    await pass();
    await pass(HEALTH_STABLE_MS);
    expect((await one()).status).toBe("ready");
  });
});

describe("report: health is shown, status keeps the document's rule", () => {
  beforeEach(() => setup({ mode: "report" }));

  it("calls a crash loop ready (as before) but records it unhealthy", async () => {
    const envId = await created();
    await setCluster(envId, [{ digest: digest("a"), ready: false, restarts: 3, waiting: "CrashLoopBackOff" }]);
    await pass();
    expect(await one()).toMatchObject({ status: "ready", health: "unhealthy", health_check: "crash" });
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-status.test.ts subgraphs/vetra-apps/__tests__/instances-health.test.ts 2>&1 | grep -E "FAIL|✗|×|Tests" | tail`. Expected: FAIL (`observeHealth` missing; enforce tests stay `ready`/`updating`).

- [ ] **Step 3: Implement.**

`status.ts` — widen `Observation` and add below `observeEnvironment`:

```ts
export type Observation =
  | { kind: "ready" }
  | { kind: "updating" }
  | { kind: "stopped" }
  | { kind: "degraded"; reason: string }
  | { kind: "failed"; reason: string }
  /** Nothing new to say (health stale, unknown, or not settled): keep the status. */
  | { kind: "unchanged" };

/** Healthy this long before ready: longer than the chart's liveness delay (60 s) plus three periods, so a crash loop never looks stable. */
export const HEALTH_STABLE_MS = 120_000;
/** A steady instance not healthy this long is degraded. */
export const DEGRADED_AFTER_MS = 60_000;
/** An update is failed only after at least two checks agree (checks run every 30 s). */
export const CONFIRM_MS = 30_000;
/** Older checks are not evidence (the monitor stopped, or the budget skipped this instance). */
export const HEALTH_STALE_MS = 180_000;

export interface HealthView {
  health: "healthy" | "unhealthy" | "unknown" | null;
  check: string | null;
  reason: string | null;
  checkedAt: string | null;
  since: string | null;
  digest: string | null;
  observedDigest: string | null;
}

export const healthView = (r: {
  health: HealthView["health"];
  health_check: string | null;
  health_reason: string | null;
  health_checked_at: string | null;
  health_since: string | null;
  health_digest: string | null;
  observed_digest: string | null;
}): HealthView => ({
  health: r.health,
  check: r.health_check,
  reason: r.health_reason,
  checkedAt: r.health_checked_at,
  since: r.health_since,
  digest: r.health_digest,
  observedDigest: r.observed_digest,
});

const msOf = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * Spec 6 step 3 with 14.7's health: ready = healthy (stable) on the target
 * digest; an update unhealthy past the window fails (the reconciler reverts);
 * an instance that ran the target healthy and is not healthy now is degraded
 * (never reverted). The document's status only decides stopped and gone.
 */
export function observeHealth(
  state: VetraCloudEnvironmentState,
  target: { tag: string; digest: string },
  row: { update_started_at: string | null; running_digest: string | null },
  h: HealthView,
  now: Date,
  unhealthyWindowMs: number,
): Observation {
  if (state.status === "STOPPED") return { kind: "stopped" };
  if (GONE.has(state.status))
    return { kind: "failed", reason: `the environment is ${state.status}` };
  const t = now.getTime();
  const inFlight = row.running_digest !== target.digest;
  const started = msOf(row.update_started_at);
  const checked = msOf(h.checkedAt);
  const onTarget =
    (state.services.find((s) => s.type === "FUSION")?.version ?? null) === target.tag;
  const fresh =
    h.health !== null &&
    onTarget &&
    h.digest === target.digest &&
    t - checked <= HEALTH_STALE_MS &&
    (!inFlight || !Number.isFinite(started) || checked > started);
  const label = h.check ? `${h.check}: ${h.reason ?? h.health}` : String(h.health);

  if (fresh) {
    const since = Number.isFinite(msOf(h.since)) ? msOf(h.since) : checked;
    const forMs = t - since;
    if (h.health === "healthy" && h.observedDigest === target.digest && forMs >= HEALTH_STABLE_MS)
      return { kind: "ready" };
    if (
      inFlight &&
      h.health === "unhealthy" &&
      Number.isFinite(started) &&
      t - started >= unhealthyWindowMs &&
      forMs >= CONFIRM_MS
    )
      return { kind: "failed", reason: `unhealthy (${label})` };
    if (
      !inFlight &&
      h.health !== "healthy" &&
      h.check !== "data" &&
      h.check !== "stopped" &&
      forMs >= DEGRADED_AFTER_MS
    )
      return { kind: "degraded", reason: label };
  }
  if (!inFlight) return { kind: "unchanged" };
  // The reconciler always records a start time; without one an update never times out (as observeEnvironment).
  if (Number.isFinite(started) && t - started > UPDATE_TIMEOUT_MS)
    return {
      kind: "failed",
      reason: fresh && h.health !== "healthy" ? `not healthy after 20 minutes (${label})` : "not healthy after 20 minutes",
    };
  return { kind: "updating" };
}
```

`reconciler.ts` — import `instanceHealth` from `"../config.js"` and `healthView, observeHealth` from `"./status.js"`; replace the `const seen = observeEnvironment(…)` statement with:

```ts
  const health = instanceHealth(deps.cfg);
  // enforce: spec 14.7 health decides; report/off: slice 1's interim rule (health is only shown).
  const seen =
    health.mode === "enforce"
      ? observeHealth(
          state,
          { tag: image.tag, digest: row.target_digest },
          row,
          healthView(row),
          deps.now(),
          health.unhealthyWindowMs,
        )
      : observeEnvironment(
          state,
          image.tag,
          row.update_started_at,
          deps.now(),
          !!row.running_digest && row.running_digest === row.target_digest,
        );
  if (seen.kind === "unchanged") return;
```

(`row.target_digest` is non-null here: `reconcileInstance` returns early without it; add `!` if tsc needs it.) Then, after the `stopped`/`updating` block and before the `// Failed:` comment, add:

```ts
  if (seen.kind === "degraded") {
    // Surfaced, never reverted: nothing was updated, the target already ran healthy.
    if (row.status !== "degraded" || row.reason !== seen.reason)
      await patch(deps, row, { status: "degraded", reason: seen.reason });
    return;
  }
```

The existing `ready` patch already sets `reason: null`, which clears a degraded reason; the existing failed branch (patch `failed_digest`, `revertImage`) is reused unchanged.

- [ ] **Step 4: Run to verify.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-status.test.ts subgraphs/vetra-apps/__tests__/instances-health.test.ts subgraphs/vetra-apps/__tests__/instances-reconciler.test.ts subgraphs/vetra-apps/__tests__/instances-previews.test.ts 2>&1 | grep -E "FAIL|Tests" | tail`. Expected: PASS (slice 1/2 tests run in the harness default, `report`, so their document-based expectations hold).

- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): ready, failed and degraded from health when enforced" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 7: `appInstances` shows health

**Files:**
- Modify: `subgraphs/vetra-apps/instances/service.ts` (`InstanceJson`, `instanceJson`)
- Modify: `subgraphs/vetra-apps/schema.ts` (`type AppInstance`)
- Test: `subgraphs/vetra-apps/__tests__/instances-api.test.ts`

**Interfaces:**
- Produces GraphQL `AppInstance.health`, `healthCheck`, `healthReason`, `healthCheckedAt`, `observedDigest`, `observedDigestSource` (all nullable `String`); `status` doc lists `degraded`.

- [ ] **Step 1: Write the failing test** (append to `instances-api.test.ts`, using the file's existing setup that creates an instance and a caller; if it builds rows by hand, patch one with `updateInstance`/`recordHealth`):

```ts
it("shows the instance's health and what the cluster runs", async () => {
  await updateApp(h.deps, owner, appId, { instancesEnabled: true });
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
  await reconcileInstancesOnce(h.deps);
  const [row] = await listInstances(h.db, appId);
  await recordHealth(h.db, row.id, {
    health: "unhealthy", health_check: "crash", health_reason: "the container does not start (CrashLoopBackOff)",
    health_checked_at: "2026-11-12T00:00:00.000Z", health_since: "2026-11-12T00:00:00.000Z",
    health_digest: digest("a"), health_restarts: 3, observed_digest: digest("a"), observed_digest_source: "pod",
  });
  const [json] = await appInstancesFor(h.deps, owner, appId);
  expect(json).toMatchObject({
    health: "unhealthy",
    healthCheck: "crash",
    healthReason: "the container does not start (CrashLoopBackOff)",
    healthCheckedAt: "2026-11-12T00:00:00.000Z",
    observedDigest: digest("a"),
    observedDigestSource: "pod",
  });
});
```

Add `import { listInstances, recordHealth } from "../instances/repo.js";`. The file's existing tests use `toMatchObject`, so they need no change.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run subgraphs/vetra-apps/__tests__/instances-api.test.ts 2>&1 | tail -5`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `InstanceJson` add `health: string | null; healthCheck: string | null; healthReason: string | null; healthCheckedAt: string | null; observedDigest: string | null; observedDigestSource: string | null;` and in `instanceJson` `health: r.health, healthCheck: r.health_check, healthReason: r.health_reason, healthCheckedAt: r.health_checked_at, observedDigest: r.observed_digest, observedDigestSource: r.observed_digest_source,`. In `schema.ts` `type AppInstance`: change the status doc to `"pending | updating | ready | degraded | failed | stopped"` and add after `runningDigest: String`:

```graphql
    "healthy | unhealthy | unknown; null until first checked (spec 14.7)"
    health: String
    "The check behind it: gitops | image | crash | restarts | pod | switchboard | connect | stopped | data"
    healthCheck: String
    healthReason: String
    healthCheckedAt: String
    "The digest the cluster runs (the pod's imageID; see observedDigestSource)"
    observedDigest: String
    "pod | document (the environment's tag, while the pod reports no imageID)"
    observedDigestSource: String
```

- [ ] **Step 4: Run to verify.** Same command, plus `npx vitest run subgraphs/vetra-apps/__tests__/schema*.test.ts 2>&1 | tail -3` if a schema snapshot test exists. Expected: PASS.

- [ ] **Step 5: Commit.** `git add subgraphs/vetra-apps && git commit -m "feat(instances): appInstances shows health and the observed digest" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 8: Whole-suite check

- [ ] **Step 1:** `npm run tsc 2>&1 | tail -20`. Expected: no errors.
- [ ] **Step 2:** `npm run lint 2>&1 | tail -20`. Expected: no errors (fix, never disable a rule).
- [ ] **Step 3:** `npx vitest run subgraphs/vetra-apps subgraphs/vetra-cloud-observability processors/vetra-cloud-environment subgraphs/vetra-licensing 2>&1 | grep -E "FAIL|Tests|failed" | tail -20`. Expected: no FAIL.
- [ ] **Step 4:** If anything was fixed: `git commit -am "fix(instances): <what>"` with the trailer.

---

### Task 9: Console shows degraded and health (vetra.to; merge only after Task 10 Step 5)

The console queries the new fields; a backend without them answers the whole `appInstances` query with an error, so this PR merges only once production runs this plan's package.

**Files (repo `/home/froid/projects/vetra.to`, branch `feat/instances-health` from `main`):**
- Modify: `modules/apps/types.ts`, `modules/apps/graphql.ts` (`fetchAppInstances`), `modules/apps/hooks/use-apps.ts` (poll predicate, line ~160), `modules/apps/components/app-instances.tsx`
- Test: `modules/apps/__tests__/app-instances.test.tsx`

- [ ] **Step 1: Write the failing test** (append; `instance()` is the file's factory — add the six new fields with `null` defaults to it):

```tsx
it('shows degraded with its reason, and an unhealthy check while still ready (report mode)', () => {
  state = {
    data: [
      instance({ id: 'd', status: 'degraded', reason: 'pod: the pod is starting', health: 'unknown', healthCheck: 'pod' }),
      instance({ id: 'r', status: 'ready', health: 'unhealthy', healthCheck: 'crash', healthReason: 'the container does not start (CrashLoopBackOff)' }),
    ],
    isPending: false,
    error: null,
  }
  render(<AppInstances appId="app-1" />)
  expect(screen.getByTestId('instance-d')).toHaveTextContent('degraded')
  expect(screen.getByTestId('instance-d')).toHaveTextContent('pod: the pod is starting')
  expect(screen.getByTestId('instance-r')).toHaveTextContent('unhealthy: crash: the container does not start (CrashLoopBackOff)')
})
```

(Match the file's existing `render`/`state` pattern; its poll test copies the predicate, so add `'degraded'` there too.)

- [ ] **Step 2: Run to verify it fails.** `npx vitest run modules/apps/__tests__/app-instances.test.tsx 2>&1 | tail -5`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `types.ts`: `export type AppInstanceStatus = 'pending' | 'updating' | 'ready' | 'degraded' | 'failed' | 'stopped'`; in `AppInstance` add `health: 'healthy' | 'unhealthy' | 'unknown' | null`, `healthCheck: string | null`, `healthReason: string | null`, `healthCheckedAt: string | null`, `observedDigest: string | null`, `observedDigestSource: 'pod' | 'document' | null`.
  - `graphql.ts`: append `health healthCheck healthReason healthCheckedAt observedDigest observedDigestSource` to the `appInstances` selection.
  - `use-apps.ts`: poll while `pending`, `updating` or `degraded` (`['pending', 'updating', 'degraded'].includes(i.status)`), and update its doc comment.
  - `app-instances.tsx`: `STATUS_CLASS.degraded = 'bg-warning/15 text-warning'`; after the reason span:

```tsx
      {instance.health === 'unhealthy' &&
        instance.status !== 'degraded' &&
        instance.status !== 'failed' && (
          <span
            className="text-warning text-xs"
            title={instance.healthCheckedAt ? formatTimestamp(instance.healthCheckedAt) : undefined}
          >
            unhealthy: {instance.healthCheck}: {instance.healthReason}
          </span>
        )}
```

- [ ] **Step 4: Run to verify.** `npx vitest run modules/apps 2>&1 | grep -E "FAIL|Tests" | tail`; `npm run tsc 2>&1 | tail -5`; `npm run lint 2>&1 | tail -5`. Expected: PASS / no errors.
- [ ] **Step 5: Commit.** `git add modules/apps && git commit -m "feat(apps): show degraded instances and failing health checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`

---

### Task 10: Staging, then production (needs the user for every push and pin)

- [ ] **Step 1: PR and merge** (vetra-cloud-package; description: this plan's health definition table and status rules). The user merges; `main` publishes `0.0.<n>`.
- [ ] **Step 2: Staging pin, report mode** (user PR in `powerhouse-k8s-hosting`: `tenants/staging/powerhouse-values.yaml`, `PH_REGISTRY_PACKAGES` in both places). No new env var yet (default `report`). Wait for the roll (1-1.5 min). Check: `appInstances` of the staging test app shows `health: "healthy"`, `observedDigest` = `targetDigest`, `observedDigestSource: "pod"` within a minute; switchboard logs show no `[vetra-apps] health of instance` warnings. Leave it a few hours: every serving instance stays `healthy` (a report-mode false alarm here means a check is too strict: stop and fix before enforcing).
- [ ] **Step 3: Enforce on staging** (user PR: `VETRA_APPS_INSTANCE_HEALTH: "enforce"`, `VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S: "180"` in the staging switchboard env).
- [ ] **Step 4: Verify on the staging test app.**
  - **Crash build → revert.** On a branch of the test repo make the host exit at start (e.g. `CMD` → `node -e "process.exit(1)"`, or a required env var read at boot), push to `main`. The new build's digest becomes the target: `updating`, health `unhealthy (crash …)` or `(restarts …)` within a minute; about 3-4 min later `failed: unhealthy (crash: …)`; the environment's FUSION version is back on the previous digest; `kubectl -n <tenant> get pod -o jsonpath='{..imageID}'` ends in the previous digest; `observedDigest` equals it; `runningDigest` unchanged. Revert the commit: the next build goes `updating → ready` (about 2 min after the pod is ready).
  - **Render error → revert.** Not reproducible from the app repo; skip unless a staging values change can break the chart render for one tenant (ask the user before touching `previews/`).
  - **Stop/start → degraded → ready.** Console stop on the instance's environment: `stopped`. Start: `degraded (pod: the pod is starting)` after about a minute, then `ready` about 2 min after the pod is ready. Out-of-band outage: `kubectl -n <tenant> scale deploy/<app> --replicas=0` → `degraded (pod: no pod runs the target image yet)` within ~1.5 min, no environment write (document operation count unchanged); `--replicas=1` → `ready`.
  - **Load.** Switchboard logs/ingress logs: each instance host gets at most 2-3 requests per 30 s; nothing probes non-instance hosts.
  - **Nothing else moved.** Licensed environments, Sektar's, previews of apps not on instances: no health rows, no requests (ingress logs), no status change.
- [ ] **Step 5: Production pin** (not inside the Sektar window): `tenants/vetra/powerhouse-values.yaml`, `PH_REGISTRY_PACKAGES` (two places). Production has `VETRA_APPS_INSTANCES=off`: no monitor runs there until instances are switched on; health stays `report` until the user enables `enforce` on production.
- [ ] **Step 6: Console.** Merge the vetra.to PR (Task 9) after Step 5.

---

## Decisions and spec gaps (rulings)

| Topic | Ruling | Why |
|---|---|---|
| Gap 8: host-reported version | Running digest = pod `imageID` (`source: pod`), document tag only when the pod has none (`source: document`). Switching to the host's own report is a follow-up once the Powerhouse host exposes it (spec 15). | The host reports nothing today (`/health` = "OK", `/ready` = "OK"); the pod's imageID is what the kubelet pulled and runs. |
| "reactor has finished its migrations" | `/ready` = 200 (the switchboard marks ready after migrations, the final router update and seeded drives). `/health` fallback for images without `/ready`, which cannot prove migrations. | The only migration signal the host gives. |
| "Connect serves its page" | `GET /` 2xx with `text/html` on the instance host. | Host mode serves Connect at the apex (Task 0 confirms). |
| Overview "kubectl from the switchboard" | Not used: observability's in-cluster watchers already record pods and Argo; this plan adds three pod columns. | No new cluster permissions; one source of cluster truth. |
| Report mode first | Default `report`; staging switches to `enforce` after a report-mode soak (overview slice 3 risk). | A stricter probe than today's must not fail working instances unseen. |
| Unknown vs unhealthy | Starting pods and `/ready` 503 are `unknown`: they never fail an update before the 20-minute timeout (slow migrations), but they do degrade a steady instance after 60 s. | Spec 6 "allow minutes" for migrations; an outage of a running instance is still visible. |
| Degraded | New status, no revert, no environment write; ready again by the same stability rule. | Nothing was updated, so there is nothing to revert to. |
| Rollouts (spec 7) | Not in this plan; they will read `health`/`health_since`/`observed_digest` and `observeHealth`'s rules for "healthy after each update". | Slice 3 only provides the definition. |

## Self-review

**Spec coverage:** 14.7 checks (switchboard health → `/ready`, Connect page → `/`, migrations → `/ready`, version = target → observed digest, gap 8): Tasks 3-5. Section 6 step 3 (`ready` needs health and running digest = target; failed update stays on the previous digest): Task 6 (`observeHealth`, slice 1 revert reused). Health independent of document status: Task 6 test "ignores the document". Degraded without revert: Task 6. Exposure: Task 7 (+ console Task 9). Probe bounds: Task 5 (`pickDue`, `PROBE_EVERY_MS`, parallel 4, Task 4 timeout). Licensed/old-path untouched: Task 5 (`ours` before any read or probe; only `instances` rows), Task 10 Step 4. Staging steps (crash → revert, stop/start → degraded → ready): Task 10.

**Placeholder scan:** code steps carry their code. Task 0 may change the probe base (`probeHost` in Task 5) or accept 3xx (`judgeProbes` in Task 3); the plan names the function and the test to adjust.

**Type consistency:** `InstanceHealth` (Task 2) used by `HealthVerdict` (Task 3), `HealthRecord` (Task 5), `HealthView` (Task 6). `instanceHealth(cfg)`/`InstanceHealthConfig` (Task 2) used in Tasks 5, 6 and the tests' `setup`. `PodSnapshot`/`ArgoSnapshot`/`ProbeResult` (Task 3) used by `readCluster`, `HttpProbe`, harness (Task 4). `judgedPods`, `judgeCluster`, `judgeProbes`, `observedDigest`, `digestOf`, `NO_DATA`, `STOPPED` (Task 3) used in Task 5. `listDueForHealth`, `recordHealth` (Task 5) used in Tasks 5, 7. `PROBE_EVERY_MS` (Task 5), `HEALTH_STABLE_MS`, `DEGRADED_AFTER_MS`, `CONFIRM_MS` (Task 6) used in tests. `ours` exported in Task 5, used by the monitor.

## Not in this plan

The host reporting its own version (Powerhouse monorepo, spec 15), rollouts and rehearsals using health (phase 3), error-rate regression checks (spec 7 step 4), health of shared/own instances (phase 3; the monitor already covers any `instances` row), GitHub check with the instance status (slice 5), sleeping instances (slice 6: a slept instance is `stopped`, never judged).
