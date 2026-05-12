export interface EnvironmentStatus {
  tenantId: string;
  argoSyncStatus: string;
  argoHealthStatus: string;
  argoLastSyncedAt: string | null;
  argoMessage: string | null;
  configDriftDetected: number; // 0/1 for boolean compat
  tlsCertValid: number | null;
  tlsCertExpiresAt: string | null;
  domainResolves: number | null;
  updatedAt: string;
}

export interface EnvironmentPods {
  id: string; // {tenantId}/{podName}
  tenantId: string;
  name: string;
  service: string; // CONNECT, SWITCHBOARD, OTHER (derived from `component` label)
  /**
   * Value of the `app.kubernetes.io/component` label set by the chart.
   * One of: connect, switchboard, clint, fusion, registry, etc. Null
   * for pods that don't carry the label (e.g. pre-chart legacy pods,
   * one-off helper pods).
   */
  component: string | null;
  /**
   * Value of the `clint.vetra.io/agent` label set by the chart on every
   * clint pod. Non-null only for clint pods. The vetra.to UI uses this
   * to attribute a pod to a specific agent without parsing pod names.
   */
  agent: string | null;
  phase: string;
  ready: number; // 0/1
  restartCount: number;
  updatedAt: string;
}

export interface EnvironmentEvents {
  id: string; // K8s event .metadata.uid
  tenantId: string;
  type: string; // Normal, Warning
  reason: string;
  message: string;
  involvedObject: string;
  timestamp: string;
}

/**
 * Latest known release tag per (channel, image). Upserted by
 * notifyNewImageRelease. Queried by the UI to render "latest on channel"
 * next to each env's current service version, and by the update-now
 * mutation to pull the tag to bump an env to.
 */
export interface ReleaseIndex {
  /** Composite key: `${channel}/${image}`. */
  id: string;
  channel: string; // DEV, STAGING, LATEST
  image: string; // connect, switchboard
  tag: string;
  publishedAt: string;
  /** github release URL — optional, best-effort. */
  releaseUrl: string | null;
}

/**
 * Per-environment release history. One row per dispatched
 * SET_SERVICE_VERSION (whether automatic, manual update-now, or rollback).
 */
export interface ReleaseHistory {
  id: string; // `${documentId}/${service}/${at}`
  documentId: string;
  tenantId: string | null;
  service: string; // CONNECT, SWITCHBOARD
  fromTag: string | null;
  toTag: string;
  trigger: string; // AUTO, MANUAL, ROLLBACK
  channel: string | null; // channel that triggered this, if any
  at: string;
  releaseUrl: string | null;
}

/**
 * Runtime-announced endpoint, reported by a clint agent via its
 * SERVICE_ANNOUNCE_URL callback. The agent is the source of truth — we
 * upsert on each announcement and prune entries the agent stops
 * reporting (or trust last_seen as a freshness signal).
 *
 * The doc model intentionally does NOT mirror this state; runtime data
 * lives in this subgraph's DB, like pods/events/status.
 */
export interface ClintRuntimeEndpoint {
  /** `${documentId}|${prefix}|${endpointId}` — composite key. */
  id: string;
  documentId: string;
  /** Service prefix, e.g. "rupert". Identifies the agent within the env. */
  prefix: string;
  /** Endpoint ID as reported by the agent, e.g. "agent-graphql". */
  endpointId: string;
  /** "api-graphql" | "api-mcp" | "website" — see ClintEndpointType. */
  type: string;
  /** Port the agent exposes the endpoint on (string for forward-compat). */
  port: string;
  /** "enabled" | "disabled" — agent can mark endpoints down without removing. */
  status: string;
  /** ISO timestamp of the last pull-worker tick that observed this endpoint. */
  lastSeen: string;
}

/**
 * On-demand pg_dump exports of a tenant env's Postgres. Files have a
 * 24h TTL on S3 (bucket lifecycle); rows are pruned after 7 days. See
 * `docs/superpowers/specs/2026-05-07-environment-database-dump-design.md`
 * in vetra.to for the full design.
 */
export interface DatabaseDumps {
  id: string;
  documentId: string;
  tenantId: string;
  requestedBy: string;
  status: string; // PENDING | RUNNING | READY | FAILED
  jobName: string | null;
  s3Key: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
  /**
   * Discriminator for who/what asked for the dump. `MANUAL` is a user
   * clicking "Create dump" via requestEnvironmentDump. `SCHEDULED` is
   * the backupScheduleRunner firing on cadence. Used by the UI to
   * distinguish manual vs. scheduled dumps and by the runner for
   * retention enforcement.
   */
  source: string; // MANUAL | SCHEDULED
}

export interface ObservabilityDB {
  environment_status: EnvironmentStatus;
  environment_pods: EnvironmentPods;
  environment_events: EnvironmentEvents;
  release_index: ReleaseIndex;
  release_history: ReleaseHistory;
  clint_runtime_endpoints: ClintRuntimeEndpoint;
  database_dumps: DatabaseDumps;
}
