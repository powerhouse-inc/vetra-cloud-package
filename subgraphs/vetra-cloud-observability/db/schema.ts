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
  service: string; // CONNECT, SWITCHBOARD, OTHER
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
  /** ISO timestamp of the last announcement that included this endpoint. */
  lastSeen: string;
}

// Note: CLINT announce tokens are stateless HMAC-SHA256 signatures
// (see shared/clint-announce-token.ts). No DB table needed; the
// resolver verifies in constant time using a shared secret loaded
// from CLINT_ANNOUNCE_SECRET at module init.

export interface ObservabilityDB {
  environment_status: EnvironmentStatus;
  environment_pods: EnvironmentPods;
  environment_events: EnvironmentEvents;
  release_index: ReleaseIndex;
  release_history: ReleaseHistory;
  clint_runtime_endpoints: ClintRuntimeEndpoint;
}
