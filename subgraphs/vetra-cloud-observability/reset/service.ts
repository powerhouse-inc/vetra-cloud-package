import type { Pool } from "pg";

/**
 * Pure helpers for the Reset Environment + Restart Service feature.
 *
 * The resolver layer wires owner-checks, `getTenantPool`, and the
 * existing tenant k8s client into these helpers; the helpers themselves
 * don't know about GraphQL, auth, or the subgraph host. That separation
 * mirrors the dumps and explorer modules, and makes the SQL/k8s parts
 * trivially unit-testable with stubs.
 */

/**
 * Minimal k8s surface the reset/restart helpers need. Production
 * wiring uses the same client as the dumps feature (see
 * `dumps/k8s-client.ts`) with the two new methods added to that
 * interface.
 */
export interface ResetK8sClient {
  /**
   * List deployments in the namespace that belong to a tenant app
   * (one of connect / switchboard / clint / fusion). Returns the
   * deployment name plus the value of the chart's
   * `app.kubernetes.io/component` label.
   *
   * Additional labels (currently just `clint.vetra.io/agent`) are
   * returned in `labels` so `restartSingleService` can disambiguate
   * clint deployments by agent prefix without a second API call.
   */
  listAppDeployments(namespace: string): Promise<
    Array<{
      name: string;
      component: string;
      labels: Record<string, string>;
    }>
  >;
  /**
   * Patch the named Deployment's pod template with the standard
   * `kubectl.kubernetes.io/restartedAt` annotation, which causes the
   * Deployment controller to roll the underlying ReplicaSet.
   */
  patchDeploymentRestart(namespace: string, name: string): Promise<void>;
}

/** Service types eligible for restart. Matches the GraphQL TenantService enum. */
export type RestartableService = "CONNECT" | "SWITCHBOARD" | "CLINT" | "FUSION";

/** Components considered "tenant app" for the bulk-restart path. */
const APP_COMPONENTS: ReadonlySet<string> = new Set([
  "connect",
  "switchboard",
  "clint",
  "fusion",
]);

/**
 * TRUNCATE every user-schema base table in a single transaction.
 *
 * The whole operation is wrapped in BEGIN/COMMIT so a failure on any
 * one table rolls back the lot — partial truncation would leave the
 * database in a state where some app data is missing while related
 * rows are still present, defeating the "clean slate" goal.
 *
 *   - `information_schema.tables` is queried with the standard
 *     exclusions (pg_catalog, information_schema, temp schemas).
 *   - Only BASE TABLEs are touched; views, foreign tables, and
 *     materialised views are deliberately left alone (they can't be
 *     TRUNCATEd anyway, and dropping them is out of scope).
 *   - Identifiers are double-quoted with embedded `"` escaped to `""`
 *     so a malicious schema/table name can't break out of the literal.
 *   - RESTART IDENTITY resets any owned sequences so the next insert
 *     starts at 1 — matches the freshly-provisioned env experience.
 *   - CASCADE walks FK chains so we don't have to topologically sort
 *     the table list; with the whole user schema being truncated at
 *     once this is the simplest correct option.
 *
 * Returns the number of tables truncated; 0 when the schema is empty
 * (in which case we don't run anything — TRUNCATE TABLE with zero
 * targets is a syntax error).
 */
export async function truncateUserTables(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_schema NOT LIKE 'pg_temp_%'
          AND table_type = 'BASE TABLE'`,
    );
    const tables = res.rows;
    if (tables.length === 0) return 0;

    const list = tables
      .map((row) => `${quoteIdent(row.table_schema)}.${quoteIdent(row.table_name)}`)
      .join(", ");
    const truncate = `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`;

    await client.query("BEGIN");
    try {
      await client.query(truncate);
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Best-effort rollback — surface the original error regardless.
      }
      throw err;
    }
    return tables.length;
  } finally {
    client.release();
  }
}

/**
 * Patch every tenant app deployment with the rollout-restart annotation.
 *
 * Per-deployment errors are collected, not thrown — the caller decides
 * how to surface a partial restart. We deliberately don't short-circuit
 * on the first failure: restarting 3-of-4 services is strictly better
 * than restarting 0, and the failing one is named in the result so the
 * UI can warn the user.
 */
export async function restartAppDeployments(
  k8s: ResetK8sClient,
  namespace: string,
): Promise<{
  restarted: number;
  failed: Array<{ name: string; error: string }>;
}> {
  const all = await k8s.listAppDeployments(namespace);
  const targets = all.filter((d) => APP_COMPONENTS.has(d.component));
  let restarted = 0;
  const failed: Array<{ name: string; error: string }> = [];
  for (const dep of targets) {
    try {
      await k8s.patchDeploymentRestart(namespace, dep.name);
      restarted += 1;
    } catch (err) {
      failed.push({
        name: dep.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { restarted, failed };
}

/**
 * Roll-restart one service's deployment. Returns the name of the
 * deployment that was patched.
 *
 * For CONNECT/SWITCHBOARD/FUSION the deployment is identified by its
 * `app.kubernetes.io/component` label alone — the chart enforces a
 * single deployment per component for these services.
 *
 * For CLINT the chart renders one Deployment per agent prefix, so we
 * additionally filter by `clint.vetra.io/agent=<agentPrefix>`. Calling
 * with service=CLINT but no agentPrefix is ambiguous by definition
 * (we'd have to pick one of several clint deployments at random) and
 * raises AMBIGUOUS_SERVICE — the UI must always pass the agent prefix
 * when restarting a clint service.
 */
export async function restartSingleService(
  k8s: ResetK8sClient,
  namespace: string,
  service: RestartableService,
  agentPrefix?: string,
): Promise<string> {
  const target = service.toLowerCase();
  const all = await k8s.listAppDeployments(namespace);

  let matches: Array<{
    name: string;
    component: string;
    labels: Record<string, string>;
  }>;
  if (service === "CLINT") {
    if (!agentPrefix) {
      // The chart deploys one Deployment per agent prefix, so without
      // the prefix we can't pick one — surface AMBIGUOUS_SERVICE so
      // the UI doesn't silently restart the wrong agent.
      throw new Error("AMBIGUOUS_SERVICE");
    }
    matches = all.filter(
      (d) =>
        d.component === target &&
        d.labels["clint.vetra.io/agent"] === agentPrefix,
    );
  } else {
    matches = all.filter((d) => d.component === target);
  }

  if (matches.length === 0) throw new Error("DEPLOYMENT_NOT_FOUND");
  if (matches.length > 1) throw new Error("AMBIGUOUS_SERVICE");

  const [{ name }] = matches;
  await k8s.patchDeploymentRestart(namespace, name);
  return name;
}

/** Double-quote a Postgres identifier, escaping embedded quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
