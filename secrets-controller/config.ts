/**
 * Runtime configuration for the secrets-controller binary.
 *
 * The controller is a small standalone Node service. It reads everything
 * from env vars and never mutates the runtime state — `loadConfig()` is
 * called once at startup and the result is passed down.
 */

export interface ControllerConfig {
  /** Postgres connection string for both the LISTEN/NOTIFY socket and the
   *  Kysely-backed read queries. Must be a direct-primary connection;
   *  pgbouncer transaction-mode poolers don't support LISTEN. */
  databaseUrl: string;
  /** Human-readable reactor namespace ("vetra-cloud-secrets" by default).
   *  The controller hashes this the same way reactor-api does to derive
   *  the actual Postgres schema name. */
  dbNamespace: string;
  /** Base URL of OpenBao for transit decryption. */
  openbaoAddr: string;
  /** OpenBao role used to authenticate transit calls. */
  transitRole: string;
  /** Prefix for the per-tenant transit key name; the tenantId is appended
   *  to derive the full key per env. */
  transitKeyPrefix: string;
  /** Periodic full-sweep interval in ms (default 5 min). Catches anything
   *  the LISTEN socket missed (dropped notifications, restarts). */
  fullReconcileIntervalMs: number;
  /** Port for the HTTP health server (/healthz, /readyz). */
  healthPort: number;
  /** Postgres NOTIFY channel name. Must match what the subgraph's mutations
   *  pg_notify on. */
  notifyChannel: string;
  /** Value applied to the `app.kubernetes.io/managed-by` label on
   *  upserted ConfigMaps and Secrets, so we can tell at a glance which
   *  controller owns them. */
  managedLabelValue: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(): ControllerConfig {
  const parseInt10 = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`invalid numeric env value: ${v}`);
    }
    return n;
  };

  return {
    databaseUrl: required("DATABASE_URL"),
    dbNamespace: process.env.DB_NAMESPACE ?? "vetra-cloud-secrets",
    openbaoAddr: required("OPENBAO_ADDR"),
    transitRole: process.env.OPENBAO_TRANSIT_ROLE ?? "vetra-secrets-controller",
    transitKeyPrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX ?? "vetra-tenant-",
    fullReconcileIntervalMs: parseInt10(
      process.env.FULL_RECONCILE_INTERVAL_MS,
      5 * 60 * 1000,
    ),
    healthPort: parseInt10(process.env.HEALTH_PORT, 8080),
    notifyChannel: process.env.NOTIFY_CHANNEL ?? "vetra_secrets_changed",
    managedLabelValue: "vetra-secrets-controller",
  };
}
