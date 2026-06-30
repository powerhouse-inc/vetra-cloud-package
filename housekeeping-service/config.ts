/**
 * Runtime config for the studio-housekeeping service. Read once at startup from
 * env vars. The service does two jobs (idle detector + wake activator); both are
 * always on, but the detector is gated by HOUSEKEEPING_DRY_RUN until rollout.
 */

export interface HousekeepingConfig {
  /** Direct Postgres connection string (the env read-model lives here). */
  databaseUrl: string;
  /** Reactor namespace for the environments read-model. */
  dbNamespace: string;
  /** Base URL of Loki (e.g. http://loki-gateway.monitoring.svc). */
  lokiUrl: string;
  /** Loki stream selector for Traefik access logs. */
  lokiSelector: string;
  /** Switchboard GraphQL endpoint exposing the vetra-housekeeping subgraph. */
  switchboardGraphqlUrl: string;
  /** Admin bearer token the service uses to call sleep/wake mutations. */
  adminToken: string;
  /** Wildcard base domain studios live under (e.g. vetra.io). */
  baseDomain: string;
  /** Idle window in seconds — no proper request for this long ⇒ sleep. */
  idleThresholdSeconds: number;
  /** Detector scan cadence in ms. */
  scanIntervalMs: number;
  /** When true, the detector logs what it would sleep but never sleeps. */
  dryRun: boolean;
  /** tenantIds/subdomains that must never be slept (VIP allowlist). */
  allowlist: string[];
  /** Port for the activator HTTP server + health endpoints. */
  port: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`invalid numeric env ${name}: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HousekeepingConfig {
  return {
    databaseUrl: required("DATABASE_URL"),
    dbNamespace: env.DB_NAMESPACE ?? "vetra-cloud-environments",
    lokiUrl: (env.LOKI_URL ?? "http://loki-gateway.monitoring.svc").replace(/\/$/, ""),
    lokiSelector: env.LOKI_SELECTOR ?? '{namespace="traefik"}',
    switchboardGraphqlUrl: required("SWITCHBOARD_GRAPHQL_URL"),
    adminToken: required("HOUSEKEEPING_ADMIN_TOKEN"),
    baseDomain: env.STUDIO_BASE_DOMAIN ?? "vetra.io",
    idleThresholdSeconds: intEnv("HOUSEKEEPING_IDLE_THRESHOLD_SECONDS", 24 * 60 * 60),
    scanIntervalMs: intEnv("HOUSEKEEPING_SCAN_INTERVAL_MS", 15 * 60 * 1000),
    dryRun: (env.HOUSEKEEPING_DRY_RUN ?? "true").toLowerCase() !== "false",
    allowlist: (env.HOUSEKEEPING_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    port: intEnv("PORT", 8080),
  };
}
