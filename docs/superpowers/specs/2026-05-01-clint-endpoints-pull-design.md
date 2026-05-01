# CLINT Endpoints — Pull Design

**Status:** Draft
**Date:** 2026-05-01
**Owner:** Frank (vetra-cloud-package)
**Cross-repo dependency:** `ph-clint` will publish a version that exposes a static `/clint/endpoints` JSON path via an in-process nginx proxy (Prometheus). `powerhouse-k8s-hosting` chart already has the per-agent Service + Ingress that exposes `<agent.name>.<subdomain>.<basedomain>` → pod port 8080; no chart change needed for routing.
**Supersedes:** [`2026-04-30-clint-announce-signed-tokens-design.md`](./2026-04-30-clint-announce-signed-tokens-design.md) (push/HMAC, never reached the resolver — Renown auth wall). The announce path is replaced by this pull design.

## 1. Summary

Replace the broken push-announce path (agent → switchboard mutation) with a pull-based one (switchboard → agent HTTP GET). The agent exposes a single static endpoint — `GET /clint/endpoints` — listing its runtime endpoints as JSON. A background worker in `vetra-cloud-observability` polls every active CLINT service every 15 seconds, fetches the JSON, and upserts into the existing `clint_runtime_endpoints` table. Vetra.to's `clintRuntimeEndpointsByEnv` query keeps the same shape and cadence; the change is invisible to the UI.

The push path (mutation, processor token mint, chart announce env vars) is deleted in this same spec. Doubles as a health check — a non-200 response, timeout, or empty endpoints list is the only signal we need to know an agent is unreachable.

## 2. Goals

- `clintRuntimeEndpointsByEnv` populates correctly for every active CLINT service in every env.
- Agents no longer need any auth credential, token, or shared secret to surface their runtime endpoints.
- Vetra.to UI keeps working with zero changes.
- One spec covers the consumer-side change cleanly. Producer side (ph-clint nginx) is owned by Prometheus and proceeds on its own track; this spec defines the response-shape contract we expect.

## 3. Non-goals (deferred)

- Auth on the pulled endpoint. Agents serve `/clint/endpoints` open. The data is metadata only (endpoint id/type/port/status); behind public ingress, no worse than what's visible in the AgentCard UI.
- In-cluster pull (kube-proxy DNS instead of public ingress). Lower latency, but requires cross-namespace access for the staging-side worker. v2.
- Per-env pull cadence. v1 is fixed 15s.
- Health-check semantics beyond "did the GET succeed". A reachable agent that's failing health internally is out of scope; if we want richer health, that's a follow-up.
- Push fallback for agents pinned to old ph-clint that still send the announce. Once Prometheus's nginx version is the only published one and existing agents have cycled, no agent will be calling announce. Keep zero compat code.

## 4. Architectural decisions

### 4.1 Polling location: worker inside the observability subgraph

The new worker lives at `subgraphs/vetra-cloud-observability/clint-pull-worker.ts`, started during subgraph init alongside existing watchers. Single instance — runs only in the staging switchboard pod that hosts the central observability subgraph (other tenants don't run this subgraph). Same lifecycle as `EnvironmentStatusWatcher`.

### 4.2 Pull cadence: 15 seconds

Matches `useClintRuntimeEndpoints`'s 15s polling interval in vetra.to. UI lag is bounded by `2 × 15s` (one window for worker → DB, one for UI → switchboard). 15s × N CLINT services across all envs → cluster ingress load is bounded by current CLINT count (≤ 10 today).

### 4.3 URL discovery: derived from env state

For each `state.services[type === "CLINT" && enabled]`:

```
url = `https://${agent.prefix}.${state.genericSubdomain}.${state.genericBaseDomain}/clint/endpoints`
```

This matches the chart's existing ingress emit (`{{ $agent.name }}.{{ $subdomain }}.{{ $baseDomain }}`). No doc-model change. The worker reads each env doc's state via `envDb.environments` rows (the same way `myEnvironments` resolver does today).

### 4.4 Auth: open

`/clint/endpoints` requires no auth header. Reasoning:
- Data is metadata only — endpoint ids, types, ports, status. Already visible in AgentCard UI.
- Pull side has no Renown identity to present (same problem we just hit on push).
- Adding auth re-introduces the secret-distribution problem this design eliminates.

If/when we want to restrict who can pull, options are: cluster network policy + in-cluster URL (§3 deferred), or a Cloudflare-style edge auth. Out of scope for v1.

### 4.5 Response shape: matches existing `clint_runtime_endpoints` schema

```json
{
  "endpoints": [
    { "id": "agent-graphql",  "type": "api-graphql", "port": "8080", "status": "enabled" },
    { "id": "agent-mcp",      "type": "api-mcp",     "port": "8080", "status": "enabled" },
    { "id": "agent-website",  "type": "website",     "port": "8080", "status": "enabled" }
  ]
}
```

Field-by-field identity-map into the existing `clint_runtime_endpoints` columns, so the upsert is one Kysely call without translation. `port` is kept for schema continuity even though the proxy abstracts it (the URL already routes to the right backend). Frees the consumer from caring whether the producer's nginx maps ports 1:1 or rewrites — both work.

Path: **`/clint/endpoints`** (short, low collision risk with the agent's app at `/`). To be confirmed with Prometheus during ph-clint nginx implementation.

### 4.6 Feature-flag the worker

Worker is gated behind `CLINT_PULL_WORKER_ENABLED=true` env var on the staging switchboard. Defaults `false` so this spec can land and roll out before Prometheus's ph-clint nginx version is published. After their version lands, flip the flag on, validate, then remove the flag in a follow-up cleanup.

## 5. Code changes

### 5.1 New file: `subgraphs/vetra-cloud-observability/clint-pull-worker.ts`

Skeleton:

```ts
import type { Kysely } from "kysely";
import type { ILogger } from "@powerhousedao/reactor-api";

export type ClintPullWorkerConfig = {
  envDb: Kysely<any>;     // processor's namespace, has the `environments` table
  obsDb: Kysely<any>;     // observability namespace, has clint_runtime_endpoints
  logger: ILogger;
  intervalMs?: number;    // defaults to 15000
};

export class ClintPullWorker {
  #config: ClintPullWorkerConfig;
  #timer: NodeJS.Timeout | null = null;

  constructor(config: ClintPullWorkerConfig) {
    this.#config = config;
  }

  start(): void {
    if (this.#timer) return;
    const interval = this.#config.intervalMs ?? 15_000;
    const tick = () => {
      this.tickOnce().catch((err) => {
        this.#config.logger.warn(`clint-pull-worker tick failed: ${err}`);
      });
    };
    tick();
    this.#timer = setInterval(tick, interval);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tickOnce(): Promise<void> {
    // 1. List active CLINT (documentId, prefix, ingressUrl) tuples by joining
    //    `environments` (subdomain, baseDomain) with the per-env services.
    //    For now, services are stored in environments.services as JSON; parse
    //    and filter type=CLINT enabled=true.
    // 2. For each, fetch `${ingressUrl}/clint/endpoints` with 5s timeout.
    // 3. On 200: upsert into clint_runtime_endpoints (replace semantics —
    //    delete entries for that documentId/prefix not in the new set; upsert
    //    the rest with lastSeen=now).
    // 4. On non-200/timeout: leave existing entries alone (no clobber on
    //    transient failure). Future improvement: mark stale after N misses.
  }
}
```

The worker exposes `start()` / `stop()` / `tickOnce()`. Tests cover `tickOnce()` against a local HTTP mock.

### 5.2 Wire the worker into the subgraph factory

In `subgraphs/vetra-cloud-observability/index.ts`'s `onSetup()`, after the existing watcher setup:

```ts
if (process.env.CLINT_PULL_WORKER_ENABLED === "true") {
  this.#clintPullWorker = new ClintPullWorker({
    envDb,
    obsDb: db,
    logger: this.logger,
  });
  this.#clintPullWorker.start();
}
```

Stop in the subgraph's teardown if it exists; otherwise relies on process exit.

### 5.3 Drop the announce path

**Schema** (`subgraphs/vetra-cloud-observability/schema.ts`):
- Delete `announceClintEndpoints` mutation field (and the `ClintAnnouncementInput`, `ClintAnnouncementResult` types it used). The `clintRuntimeEndpointsByEnv` query stays.

**Resolver** (`subgraphs/vetra-cloud-observability/resolvers.ts`):
- Delete the `announceClintEndpoints` resolver function entirely.

**Processor** (`processors/vetra-cloud-environment/gitops.ts`):
- Delete `ensureClintAnnounceTokens` (DB-backed) — no token to mint.
- In `generateClintBlock`, drop the entire `announce:` block emission.

**Migrations** (`processors/vetra-cloud-environment/migrations.ts`):
- Replace the `createTable("clint_announce_tokens")` block with a try/catch `dropTable` (same pattern attempted in the prior spec, this time it sticks because no code references the table after this lands).

### 5.4 Drop the chart's announce env vars

In `powerhouse-k8s-hosting/powerhouse-chart/templates/clint-deployment.yaml`, remove the `{{- if and $agent.announce $agent.announce.enabled }}` ... `{{- end }}` block (the four env vars `<CLI_NAME>_SERVICE_ANNOUNCE_URL/TOKEN`, the inline comment, etc.). The deployment template still emits `CLINT_PACKAGE`, `CLINT_VERSION`, `CLINT_REGISTRY`, `SERVICE_COMMAND`, and the resource-bound `NODE_OPTIONS`. The pinned hostname stays (it's still useful for log readability).

### 5.5 Co-design point with Prometheus (ph-clint)

The agent's `/clint/endpoints` response shape is the contract from §4.5. To coordinate:

1. Open a GitHub issue on the ph-clint repo titled "Agent endpoint discovery contract" referencing this spec.
2. The issue proposes the exact JSON shape and path, asks for feedback / counter-proposals.
3. If Prometheus picks a different path (e.g., `/.well-known/clint-endpoints`) or response shape, this spec gets amended before the worker lands — easier to update spec than rewrite worker.

The user (Frank) handles the cross-team outreach; Claude does not file the GitHub issue.

## 6. Cutover sequence

1. **Land this spec's code in vetra-cloud-package on `dev`.** The worker is feature-flagged off (`CLINT_PULL_WORKER_ENABLED` defaults false). Schema/resolver/processor cleanup is unconditional. Chart change in k8s-hosting drops the announce env vars unconditionally.
2. **Publish vetra-cloud-package** dev prerelease.
3. **Bump staging** to the new vetra-cloud-package version. Switchboard rolls. CLINT pods regenerate (no announce env vars now). Agents log no warning (announce-helper sees no URL → silently skips).
4. **Wait for Prometheus's ph-clint version** to publish a `/clint/endpoints`-serving build. Confirm response shape matches §4.5.
5. **ph-pirate-cli (and any other agent) republish** with the new ph-clint dep.
6. **Touch each CLINT-having env doc model** to trigger reconcile → tenant YAML refresh → CLINT pods cycle → agents now serve `/clint/endpoints`.
7. **Flip `CLINT_PULL_WORKER_ENABLED=true`** on staging switchboard via a `tenants/staging/powerhouse-values.yaml` env change. Worker starts polling.
8. **Validate**: `clintRuntimeEndpointsByEnv(documentId)` returns populated entries for every active CLINT in the cluster. AgentCard UI shows the runtime endpoints.
9. **Cleanup follow-up**: remove the feature flag, simplify the worker init (always-on).

## 7. Failure modes

- **Agent unreachable / not yet on the new ph-clint version.** Worker GETs return 4xx/5xx/timeout. Worker logs warn, keeps existing `clint_runtime_endpoints` rows for that prefix unchanged. UI shows the last-known endpoints (or empty for new agents). Acceptable: stale data is better than blanking the UI on a transient failure.
- **Agent returns malformed JSON.** Worker logs warn, leaves existing rows. Same recovery as above.
- **Cluster-wide ingress outage.** Every poll fails simultaneously. Worker doesn't blow up; just keeps logging. When ingress recovers, next tick succeeds.
- **15s × N services > pull-budget at scale.** Today N ≤ 10; not a concern. If N grows, parallelize per-poll batch (`Promise.all` per tick, already implied by the implementation outline — each fetch is its own promise).
- **Race vs. agent boot.** A freshly-cycled CLINT pod takes ~60-90s to finish pnpm install + start serving. During that window, the worker's GET fails. Same recovery pattern (keep last-known); next ticks succeed once the agent is up. UI shows "waiting for first announce" only during true cold-starts.

## 8. Open questions

- **Path: `/clint/endpoints` vs `/.well-known/clint-endpoints`.** Defer to Prometheus's preference during ph-clint nginx implementation.
- **`port` field necessity.** Kept for schema continuity; can be dropped later if it's never useful in the pull world.
- **Stale-marking after N consecutive failures.** v1 keeps last-known indefinitely. If an env is destroyed, the env doc itself disappears from `environments`, so the worker stops polling — but the table still has stale rows. v1 accepts this; clean up via a periodic GC or an env-deletion-time hook in a follow-up.
- **Health-check elevation.** Frank noted in chat "in the end it's also a health check." A follow-up could expose `clintAgentHealth(documentId, prefix)` returning the worker's last-success / last-failure timestamps — independent of endpoint data.

## 9. Implementation order

This becomes the writing-plans input. Sketched here to validate scope.

1. **vetra-cloud-package — worker** (`subgraphs/vetra-cloud-observability/clint-pull-worker.ts` + tests). Tests use a local HTTP server fixture; no real cluster needed.
2. **vetra-cloud-package — wire feature-flag** in subgraph factory.
3. **vetra-cloud-package — drop announce** (schema, resolver, processor's `ensureClintAnnounceTokens`, migration drops `clint_announce_tokens`).
4. **vetra-cloud-package — publish** new dev prerelease.
5. **k8s-hosting chart — drop announce env vars** in `clint-deployment.yaml`.
6. **k8s-hosting tenants/staging** — bump `vetra-cloud-package` version. Worker still off (feature flag).
7. **ph-clint** — Prometheus's nginx work lands (out of our hands).
8. **ph-pirate-cli + any other agent** — republish with new ph-clint dep.
9. **Touch env docs** to trigger reconcile + CLINT pod cycle.
10. **k8s-hosting tenants/staging** — set `CLINT_PULL_WORKER_ENABLED=true` on switchboard env. Worker starts polling.
11. **Validate**: query `clintRuntimeEndpointsByEnv` for ph-pirate-wouter; confirm populated.
12. **Cleanup** — drop the feature flag, mark spec Shipped.
