import type { Pool } from "pg";

/**
 * Minimal kubernetes surface the explorer needs: reads the
 * `<tenantNs>-pg-app` Secret that the chart renders for every tenant.
 * Same credential triple the pg_dump Job uses — see
 * `dumps/job-spec.ts`'s `dbSecret` for the canonical reference.
 *
 * Defined as an interface so the factory can be unit-tested with a
 * stub and so the production implementation can lazy-load
 * `@kubernetes/client-node` (its import has measurable cost).
 */
export interface ExplorerK8sClient {
  /** Reads `${namespace}-pg-app` and returns the connection triple. */
  readPgAppSecret(namespace: string): Promise<{
    username: string;
    password: string;
    dbname: string;
  }>;
}

export interface TenantPoolFactory {
  /**
   * Returns a `pg.Pool` for the given tenant namespace, creating it
   * on first use and caching for the subgraph's lifetime. Errors
   * (secret-not-found, k8s API down, etc.) propagate to the caller —
   * the resolver maps them to a GraphQL error.
   */
  getPool(tenantNs: string): Promise<Pool>;
  /** Drains every cached pool. Called from `onDisconnect`. */
  endAll(): Promise<void>;
}

/**
 * Production implementation. Holds a `Map<tenantNs, Pool>` for the
 * subgraph's lifetime and creates pools lazily on first access.
 *
 * Connection settings rationale:
 *   - `host`: the tenant's PgBouncer pooler (same as pg_dump uses) so
 *     we ride the existing connection pool instead of competing with
 *     the app for primary slots.
 *   - `max: 2`: low ceiling per tenant. The explorer is owner-only +
 *     interactive, so concurrent connections per tenant is bounded by
 *     human reaction time; 2 covers schema-describe + one in-flight
 *     query without starving anything else.
 *   - `idleTimeoutMillis: 60s`: idle connections expire after a
 *     minute so we don't hold them open forever when a tenant is
 *     untouched.
 *   - `connectionTimeoutMillis: 5s`: bail fast on a dead pooler
 *     rather than hanging the resolver for the default 0 (no
 *     timeout).
 */
export function createTenantPoolFactory(
  k8s: ExplorerK8sClient,
): TenantPoolFactory {
  const pools = new Map<string, Promise<Pool>>();

  async function buildPool(tenantNs: string): Promise<Pool> {
    // Lazy import so test runs that never touch the factory don't
    // pay the cost — and so `pg` stays optional at the module
    // boundary even though it's a hard dep at runtime.
    const { Pool } = await import("pg");
    const creds = await k8s.readPgAppSecret(tenantNs);
    return new Pool({
      host: `${tenantNs}-pg-pooler.${tenantNs}.svc.cluster.local`,
      port: 5432,
      user: creds.username,
      password: creds.password,
      database: creds.dbname,
      max: 2,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  return {
    getPool(tenantNs: string): Promise<Pool> {
      let p = pools.get(tenantNs);
      if (!p) {
        p = buildPool(tenantNs).catch((err) => {
          // Drop the cache entry on construction failure so the next
          // call retries. Without this, a transient k8s outage at
          // first-use would poison the cache for the subgraph's
          // lifetime.
          pools.delete(tenantNs);
          throw err;
        });
        pools.set(tenantNs, p);
      }
      return p;
    },
    async endAll(): Promise<void> {
      const all = Array.from(pools.values());
      pools.clear();
      await Promise.allSettled(
        all.map(async (p) => {
          try {
            const pool = await p;
            await pool.end();
          } catch {
            // Pool never resolved — nothing to drain.
          }
        }),
      );
    },
  };
}

/**
 * Default production `ExplorerK8sClient` — reads the `<ns>-pg-app`
 * Secret via a `CoreV1Api` instance using the pod's in-cluster
 * ServiceAccount. Kept in this file rather than `k8s-client.ts` to
 * keep the explorer module self-contained.
 *
 * The Secret keys (`username`, `password`, `dbname`) match the chart's
 * pg-app Secret schema; the pg_dump Job's `secretKeyRef` uses the same
 * keys, so any future schema drift will be caught by both surfaces at
 * once.
 */
export async function createDefaultExplorerK8sClient(): Promise<ExplorerK8sClient> {
  const { KubeConfig, CoreV1Api } = await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const core = kc.makeApiClient(CoreV1Api);

  return {
    async readPgAppSecret(namespace: string) {
      const res = await core.readNamespacedSecret({
        namespace,
        name: `${namespace}-pg-app`,
      });
      const data = res.data ?? {};
      const decode = (key: string): string => {
        const raw = data[key];
        if (!raw) {
          throw new Error(`PG_APP_SECRET_MISSING_KEY:${key}`);
        }
        return Buffer.from(raw, "base64").toString("utf8");
      };
      return {
        username: decode("username"),
        password: decode("password"),
        dbname: decode("dbname"),
      };
    },
  };
}
