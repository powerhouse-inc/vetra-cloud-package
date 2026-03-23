# Vetra Cloud Observability Subgraph

## Problem

The vetra-cloud-environment processor provisions and manages tenant environments via GitOps, but users have no visibility into what's actually happening in the cluster. There's no way to see whether an environment is healthy, if pods are running, what resources they're consuming, or if something is wrong. Users are blind after clicking "Start."

## Decision: Single Subgraph with Embedded K8s Watchers

A new `VetraCloudObservabilitySubgraph` in the vetra-cloud-package that:

1. **Watches K8s state** (ArgoCD apps, Pods, Events) via the K8s Watch API and writes structured state into the relational DB
2. **Proxies pre-built queries** to Prometheus and Loki for metrics and logs on demand
3. **Exposes everything via GraphQL** for the editor and other consumers

This approach was chosen over a separate processor (processors are designed for reacting to document operations, not continuous watching) and over an external sidecar (unnecessary operational complexity for this use case). The subgraph has the right lifecycle hooks (`onSetup`/`onDisconnect`) and already owns a DB namespace.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  VetraCloudObservabilitySubgraph                    │
│                                                     │
│  ┌─────────────┐   ┌──────────────┐                │
│  │ K8s Watchers │   │ Reconcile    │                │
│  │ (ArgoCD,    │   │ Loop (60s)   │                │
│  │  Pods,      │   │              │                │
│  │  Events)    │   │              │                │
│  └──────┬──────┘   └──────┬───────┘                │
│         │                  │                        │
│         ▼                  ▼                        │
│  ┌─────────────────────────────┐                   │
│  │     Relational DB           │                   │
│  │  environment_status         │                   │
│  │  environment_pods           │                   │
│  │  environment_events         │                   │
│  └──────────────┬──────────────┘                   │
│                 │                                   │
│  ┌──────────────▼──────────────┐                   │
│  │     GraphQL Resolvers       │                   │
│  │  - status/pods/events (DB)  │                   │
│  │  - metrics (Prometheus)     │                   │
│  │  - logs (Loki)              │                   │
│  └─────────────────────────────┘                   │
│                                                     │
│  ┌─────────────┐   ┌──────────────┐                │
│  │ OpenBao     │   │ Prometheus/  │                │
│  │ (K8s token) │   │ Loki client  │                │
│  └─────────────┘   └──────────────┘                │
└─────────────────────────────────────────────────────┘

External data sources:
  - K8s API (cluster-internal, cross-namespace via RBAC)
  - ArgoCD Application CRDs (argoproj.io/v1alpha1)
  - Prometheus (http://prometheus-server.monitoring.svc)
  - Loki (http://loki.monitoring.svc:3100)
  - OpenBao (https://openbao.vetra.io) for credential management
```

## Data Model

Three new tables in the relational DB, alongside the existing `environments` table.

### `environment_status`

One row per environment, upserted by watchers and reconciliation loop.

| Column | Type | Description |
|--------|------|-------------|
| `tenantId` | PK, varchar | Links to environment |
| `argoSyncStatus` | varchar | `Synced`, `OutOfSync`, `Unknown` |
| `argoHealthStatus` | varchar | `Healthy`, `Degraded`, `Progressing`, `Missing`, `Unknown` |
| `argoLastSyncedAt` | timestamp | Last successful ArgoCD sync |
| `argoMessage` | text | ArgoCD status message |
| `configDriftDetected` | boolean | Document state vs committed GitOps values file mismatch (distinct from ArgoCD sync status) |
| `tlsCertValid` | boolean | TLS cert health |
| `tlsCertExpiresAt` | timestamp | Cert expiry |
| `domainResolves` | boolean | DNS resolution check |
| `updatedAt` | timestamp | Last watcher update |

### `environment_pods`

One row per pod, upserted by pod watcher.

| Column | Type | Description |
|--------|------|-------------|
| `id` | PK, varchar | `{tenantId}/{podName}` |
| `tenantId` | FK, varchar | |
| `name` | varchar | Pod name |
| `service` | varchar | `CONNECT`, `SWITCHBOARD`, or `OTHER` |
| `phase` | varchar | `Running`, `Pending`, `Failed`, etc. |
| `ready` | boolean | All containers ready |
| `restartCount` | int | Total restarts |
| `updatedAt` | timestamp | |

### `environment_events`

Recent K8s events, ring-buffer style (keep last 50 per tenant).

| Column | Type | Description |
|--------|------|-------------|
| `id` | PK, varchar | K8s event `.metadata.uid` — provides natural idempotency on watcher reconnects |
| `tenantId` | FK, varchar | |
| `type` | varchar | `Normal`, `Warning` |
| `reason` | varchar | K8s event reason |
| `message` | text | |
| `involvedObject` | varchar | e.g., `Pod/connect-xyz` |
| `timestamp` | timestamp | |

Pruning: on each insert, delete rows where `tenantId` matches and `timestamp` is older than the 50th most recent event for that tenant (ordered by `timestamp DESC`).

## K8s Watchers & Reconciliation

### Watchers

Three watchers started on `onSetup()` using `@kubernetes/client-node`:

1. **ArgoCD Application watcher** — watches `Application` CRDs (`argoproj.io/v1alpha1`) cluster-wide, filtered by label selector. On change → upsert `environment_status`.

2. **Pod watcher** — watches Pods across tenant namespaces using label selector. On change → upsert `environment_pods`.

3. **Event watcher** — watches Events across tenant namespaces. On change → insert into `environment_events` (using K8s event UID as PK for idempotency), prune entries beyond 50 per tenant.

**Label selector prerequisite:** The exact label selectors must be confirmed against the tenant Helm chart templates before implementation. The Helm chart is the source of truth for which labels are applied to ArgoCD Applications, Pods, and other resources. If the chart does not apply suitable labels, adding them to the chart is a prerequisite task.

### Scoping

Cluster-wide watch with label filtering. The tenant Helm chart already labels resources, and this avoids the complexity of dynamically managing per-namespace watches as environments are created/deleted. Requires cluster-wide read RBAC.

### Reconciliation Loop

A 60-second interval that:

1. Lists all known tenantIds from the `environments` table
2. For each tenant, queries ArgoCD Application status + pod list via K8s API
3. Upserts into `environment_status` and `environment_pods`
4. Detects config drift by comparing the document state (from `environments` table) against the committed `powerhouse-values.yaml` in the GitOps repo. If the generated values from current document state differ from what's committed, `configDriftDetected = true`. This is distinct from ArgoCD's `OutOfSync` status (which means cluster state differs from repo state) — both are tracked separately

The reconciliation loop is the source of truth. Watchers are an optimization for faster updates.

### Watcher Resilience

The `@kubernetes/client-node` `Watch` class calls a `done` callback when a watch ends — it does **not** auto-reconnect. The subgraph's `watchers.ts` must implement the reconnect loop:

- On `done` callback: re-call `watch()` to reconnect
- Track a consecutive-failure counter per watcher; reset to 0 on each successful event received
- If a watcher fails 3 times consecutively without receiving any events, stop that watcher, fall back to reconciliation-only mode for that resource type, and log a warning
- Reconciliation loop runs independently regardless of watcher state

## Prometheus & Loki Proxy Queries

Live queries proxied on each GraphQL request. No data stored in the DB.

### Pre-built Prometheus Queries

| GraphQL Field | PromQL | Description |
|--------------|--------|-------------|
| `cpuUsage` | `sum(rate(container_cpu_usage_seconds_total{namespace="$tenant"}[$range])) by (pod)` | CPU usage per pod |
| `memoryUsage` | `sum(container_memory_working_set_bytes{namespace="$tenant"}) by (pod)` | Memory per pod |
| `podRestartRate` | `sum(increase(kube_pod_container_status_restarts_total{namespace="$tenant"}[$range]))` | Restart trend |
| `httpRequestRate` | `sum(rate(http_requests_total{namespace="$tenant"}[$range])) by (status_code)` | Request rate by status |
| `httpLatency` | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{namespace="$tenant"}[$range])) by (le))` | p95 latency |

### Pre-built Loki Queries

| GraphQL Field | LogQL | Description |
|--------------|-------|-------------|
| `logs` | `{namespace="$tenant", app="$service"}` | Recent logs for a service |
| `errorLogs` | `{namespace="$tenant"} \|= "error" or "ERROR"` | Error-only logs |

### Response Shapes

Prometheus queries return time-series data:

```graphql
type MetricSeries {
  label: String!
  datapoints: [Datapoint!]!
}
type Datapoint {
  timestamp: Float!
  value: Float!
}
```

Loki queries return log entries:

```graphql
type LogEntry {
  timestamp: Float!
  line: String!
}
```

### Input Validation

- `range` — validated against allowlist: `1m`, `5m`, `15m`, `1h`, `6h`, `24h`
- `since` — same allowlist as `range`
- `limit` — max log lines, capped at 500
- `service` — optional filter: `CONNECT` or `SWITCHBOARD`

### Configuration

Environment variables:

- `PROMETHEUS_URL` — defaults to `http://prometheus-server.monitoring.svc`
- `LOKI_URL` — defaults to `http://loki.monitoring.svc:3100`

## GraphQL Schema

```graphql
type Query {
  # Cached state (from DB, populated by watchers)
  environmentStatus(tenantId: String!): EnvironmentStatus
  environmentPods(tenantId: String!): [Pod!]!
  environmentEvents(tenantId: String!, limit: Int): [KubeEvent!]!

  # Live metrics (proxied to Prometheus)
  cpuUsage(tenantId: String!, range: MetricRange): [MetricSeries!]!
  memoryUsage(tenantId: String!, range: MetricRange): [MetricSeries!]!
  podRestartRate(tenantId: String!, range: MetricRange): [MetricSeries!]!
  httpRequestRate(tenantId: String!, range: MetricRange): [MetricSeries!]!
  httpLatency(tenantId: String!, range: MetricRange): [MetricSeries!]!

  # Live logs (proxied to Loki)
  logs(tenantId: String!, service: TenantService, since: MetricRange, limit: Int): [LogEntry!]!
  errorLogs(tenantId: String!, since: MetricRange, limit: Int): [LogEntry!]!
}

type EnvironmentStatus {
  tenantId: String!
  argoSyncStatus: ArgoSyncStatus!
  argoHealthStatus: ArgoHealthStatus!
  argoLastSyncedAt: String
  argoMessage: String
  configDriftDetected: Boolean!
  tlsCertValid: Boolean
  tlsCertExpiresAt: String
  domainResolves: Boolean
  updatedAt: String!
}

type Pod {
  name: String!
  service: TenantService
  phase: PodPhase!
  ready: Boolean!
  restartCount: Int!
  updatedAt: String!
}

type KubeEvent {
  type: EventType!
  reason: String!
  message: String!
  involvedObject: String!
  timestamp: String!
}

type MetricSeries {
  label: String!
  datapoints: [Datapoint!]!
}

type Datapoint {
  timestamp: Float!
  value: Float!
}

type LogEntry {
  timestamp: Float!
  line: String!
}

enum ArgoSyncStatus { SYNCED, OUT_OF_SYNC, UNKNOWN }
enum ArgoHealthStatus { HEALTHY, DEGRADED, PROGRESSING, MISSING, UNKNOWN }
enum PodPhase { RUNNING, PENDING, SUCCEEDED, FAILED, UNKNOWN }
enum EventType { NORMAL, WARNING }
enum TenantService { CONNECT, SWITCHBOARD }
enum MetricRange { ONE_MIN, FIVE_MIN, FIFTEEN_MIN, ONE_HOUR, SIX_HOURS, TWENTY_FOUR_HOURS }
```

## Authorization

This subgraph exposes per-tenant operational data (pod status, logs, metrics) which is sensitive. Access control strategy:

- The subgraph runs inside the Switchboard, which is not directly exposed to end users — it is accessed via the Powerhouse reactor API layer
- Resolvers validate that the requested `tenantId` exists in the `environments` table (rejects queries for unknown tenants)
- Network-level isolation: the Switchboard's GraphQL endpoint is internal-only, protected by Kubernetes NetworkPolicy restricting ingress to the Connect frontend pods and authorized API consumers
- Future enhancement: if multi-tenancy with untrusted callers is introduced, resolvers should verify the caller's identity maps to the requested tenantId via a context-based auth check

## Credentials via OpenBao

Instead of static ServiceAccount tokens, the subgraph acquires short-lived K8s API credentials through OpenBao's Kubernetes secrets engine.

### OpenBao Setup (one-time)

1. **Enable the Kubernetes secrets engine** at `kubernetes/` mount
2. **Configure it** with the cluster's API server URL and a long-lived ServiceAccount token that has permission to call the TokenRequest API. This ServiceAccount (`vetra-openbao-k8s-engine` in the `openbao` namespace) is created as part of the cluster bootstrap and its token is stored in OpenBao's configuration — not in environment variables or application code. Rotation: re-run the OpenBao `config` write with a new token when the SA token is rotated.
3. **Create a ClusterRole** `vetra-observability-reader`:
   - `get`, `list`, `watch` on `argoproj.io/v1alpha1/applications`
   - `get`, `list`, `watch` on `v1/pods` and `v1/events` across namespaces
   - Read-only — no mutations
4. **Create an OpenBao role** `vetra-observability`:
   - Generates ServiceAccount tokens scoped to the `vetra-observability-reader` ClusterRole
   - TTL: 1h, renewable
5. **Create an OpenBao policy** `vetra-observability`:
   ```hcl
   path "kubernetes/creds/vetra-observability" {
     capabilities = ["read"]
   }
   ```
6. **Bind the Switchboard's ServiceAccount** to this policy via the existing K8s auth method (same pattern as the ESO `external-secrets` role)

### Subgraph Token Flow

```
onSetup():
  1. Authenticate to OpenBao via K8s auth (pod's own SA token)
  2. Read kubernetes/creds/vetra-observability → short-lived K8s token
  3. Create K8s API client using that token
  4. Start watchers with the authenticated client
  5. Schedule token renewal before TTL expiry

onDisconnect():
  1. Stop watchers
  2. Clear reconciliation interval
  3. Cancel token renewal timer
  4. Revoke OpenBao lease
```

### Environment Variables

- `OPENBAO_ADDR` — `https://openbao.vetra.io` (likely already set from ESO integration)
- No static token needed — uses K8s auth from the pod's mounted ServiceAccount token

## Subgraph Lifecycle

### Class Structure

```typescript
class VetraCloudObservabilitySubgraph extends BaseSubgraph {
  name = "vetra-cloud-observability";
  typeDefs = schema;
  resolvers = getResolvers(this);
  additionalContextFields = {};

  async onSetup() {
    // 1. Run DB migrations (create tables)
    // 2. Authenticate to OpenBao via K8s auth
    // 3. Acquire K8s API token from OpenBao
    // 4. Start watchers (ArgoCD apps, Pods, Events)
    // 5. Start reconciliation loop (60s interval)
    // 6. Schedule token renewal (before TTL expiry)
  }

  async onDisconnect() {
    // 1. Stop watchers
    // 2. Clear reconciliation interval
    // 3. Cancel token renewal timer
    // 4. Revoke OpenBao lease
  }
}
```

### Registration

Exported from `subgraphs/index.ts`. The existing `export {};` stub must be replaced with:

```typescript
export { VetraCloudObservabilitySubgraph } from "./vetra-cloud-observability/index.js";
```

The package's `powerhouse.config.json` already points `subgraphsDir` to `./subgraphs`, so it gets picked up automatically.

## File Structure

```
subgraphs/
  vetra-cloud-observability/
    index.ts          # VetraCloudObservabilitySubgraph class
    schema.ts         # GraphQL type defs
    resolvers.ts      # Resolver implementations
    watchers.ts       # K8s watch + reconcile logic
    prometheus.ts     # Prometheus query client
    loki.ts           # Loki query client
    openbao.ts        # Token acquisition + renewal
    db/
      schema.ts       # Kysely table interfaces
      migrations.ts   # Table creation
  index.ts            # Re-exports subgraph
```

## Dependencies

New to `package.json`:

- `@kubernetes/client-node` — K8s API client with watch support
- `node-vault` (or raw HTTP calls) — OpenBao/Vault-compatible client

Already available: `kysely`, `graphql-tag`, `graphql`.

## RBAC Requirements

A `ClusterRole` with the following permissions:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: vetra-observability-reader
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["applications"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods", "events"]
    verbs: ["get", "list", "watch"]
```

This ClusterRole is referenced by the OpenBao Kubernetes secrets engine role, not bound directly to a ServiceAccount.
