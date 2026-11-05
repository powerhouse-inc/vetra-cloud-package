/** One-off cleanup: delete environment_pods rows whose pod no longer exists. */
// The observability pod watcher used to upsert pods even on DELETED events and
// reconcile never pruned, so the table accumulated every pod ever seen
// (~250k rows, many FAILED). The fixed watcher prunes rows of namespaces it
// lists from now on; this script cleans up the backlog, including tenants
// whose namespace is gone entirely (the live reconcile leaves those alone).
//
// It reuses the live reconcile logic (subgraphs/vetra-cloud-observability/
// pod-sync.ts → reconcilePods): one cluster-wide pod listing, every listed
// pod upserted, every other row of the in-scope tenants deleted. The listing
// is cluster-wide, so a tenant with rows in the DB but no pod in the listing
// has no pods at all, and all of its rows are stale. If the pod listing
// fails, the script exits before touching the DB.
//
// Usage (see docs/ops/prune-environment-pods.md for the full runbook):
//   node --experimental-strip-types scripts/prune-environment-pods.mts \
//     --database-url postgres://USER:PASS@localhost:5432/vetra_db \
//     [--schema <namespace schema>] [--context <kube context>] [--dry-run]
//
// --dry-run opens the DB connection with default_transaction_read_only=on and
// only prints stale counts per tenant.
import { parseArgs } from "node:util";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type {
  PodLike,
  reconcilePods as ReconcilePods,
} from "../subgraphs/vetra-cloud-observability/pod-sync.js";
import type { ObservabilityDB } from "../subgraphs/vetra-cloud-observability/db/schema.js";

// Loaded by URL so plain `node --experimental-strip-types` resolves the .ts
// source while tsc still type-checks the call through the type import.
const podSyncUrl = new URL(
  "../subgraphs/vetra-cloud-observability/pod-sync.ts",
  import.meta.url,
);
const { reconcilePods } = (await import(
  podSyncUrl.href
)) as { reconcilePods: typeof ReconcilePods };

const { values: args } = parseArgs({
  options: {
    "database-url": { type: "string" },
    schema: { type: "string" },
    context: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing --database-url (or DATABASE_URL).");
  process.exit(2);
}
const dryRun = args["dry-run"];

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  ...(dryRun ? { options: "-c default_transaction_read_only=on" } : {}),
});
const root = new Kysely<ObservabilityDB>({
  dialect: new PostgresDialect({ pool }),
});

async function resolveSchema(): Promise<string> {
  if (args.schema) return args.schema;
  // Subgraph tables live in a per-namespace schema with a generated name.
  const rows = await pool.query<{ table_schema: string }>(
    "select table_schema from information_schema.tables where table_name = 'environment_pods'",
  );
  const schemas = rows.rows.map((r) => r.table_schema);
  if (schemas.length !== 1) {
    throw new Error(
      `Expected exactly one schema with environment_pods, found [${schemas.join(", ")}]; pass --schema.`,
    );
  }
  return schemas[0];
}

async function listAllPods(kc: KubeConfig): Promise<PodLike[]> {
  const core = kc.makeApiClient(CoreV1Api);
  const res = await core.listPodForAllNamespaces({});
  if (!Array.isArray(res.items))
    throw new Error("pod listing returned no items array");
  if (res.metadata?._continue)
    throw new Error("pod listing is paginated; refusing a partial list");
  return res.items as PodLike[];
}

async function main(): Promise<void> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  if (args.context) kc.setCurrentContext(args.context);
  console.log(`kube context: ${kc.getCurrentContext()}`);

  const schema = await resolveSchema();
  const db = root.withSchema(schema);
  console.log(
    `schema: ${schema}${dryRun ? " (dry run, read-only connection)" : ""}`,
  );

  const namespaces = new Set(
    (await kc.makeApiClient(CoreV1Api).listNamespace({})).items
      .map((n) => n.metadata?.name)
      .filter((n): n is string => !!n),
  );

  const dbTenants = (
    await db
      .selectFrom("environment_pods")
      .select("tenantId")
      .distinct()
      .execute()
  ).map((r) => r.tenantId);
  const before = await db
    .selectFrom("environment_pods")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .executeTakeFirstOrThrow();

  const result = await reconcilePods(db, () => listAllPods(kc), {
    extraTenants: dbTenants,
    dryRun,
  });

  const perTenant = [...result.stale.entries()].sort((a, b) => b[1] - a[1]);
  let total = 0;
  let goneNs = 0;
  let goneRows = 0;
  for (const [tenant, n] of perTenant) {
    total += n;
    const gone = !namespaces.has(tenant);
    if (gone) {
      goneNs++;
      goneRows += n;
    }
    console.log(
      `${String(n).padStart(8)}  ${tenant}${gone ? "  (namespace gone)" : ""}`,
    );
  }
  console.log("");
  console.log(`rows before:            ${before.n}`);
  console.log(
    `live pods upserted:     ${dryRun ? "(skipped, dry run)" : result.upserted}`,
  );
  console.log(
    `stale rows ${dryRun ? "to delete" : "deleted"}:    ${total} across ${perTenant.length} tenants`,
  );
  console.log(
    `  of which namespace gone: ${goneRows} rows across ${goneNs} tenants`,
  );
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await root.destroy();
}
