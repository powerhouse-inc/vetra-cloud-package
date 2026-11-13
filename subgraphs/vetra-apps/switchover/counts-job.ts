import type { V1Job } from "@kubernetes/client-node";

/** What a switch-over compares between the old database, its copy and the started instance. Counts, never content. */
export interface Counts {
  documentsByType: Record<string, number>;
  operations: number;
  attachments: number;
  workflowSecrets: number;
  /** A fingerprint of the workflow secrets' key check, null when the tenant has none. */
  keyCheck: string | null;
  /**
   * A fingerprint of the operation log's content: md5 over the ordered
   * operation ids plus the highest index of every document stream. Equal
   * counts with other content (a swapped or partial copy) still differ.
   */
  contentFingerprint: string | null;
}

/**
 * The counts, as SQL. The workflow secret tables live in a hashed schema
 * found by table name (`secret_key_check`), so they are counted with
 * dynamic SQL through a function in pg_temp (nothing persists). Tables a
 * fresh tenant may not have yet (attachments, the workflow secrets) count 0.
 */
export const COUNTS_SQL = `
create function pg_temp.vetra_count(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute q into n; return n; end $$;
create function pg_temp.vetra_text(q text) returns text language plpgsql as $$
declare t text; begin execute q into t; return t; end $$;
with s as (
  select table_schema from information_schema.tables
  where table_name = 'secret_key_check' limit 1
)
select json_build_object(
  'documentsByType', (
    select coalesce(json_object_agg(t, n), '{}'::json) from (
      select "documentType" t, count(*) n from reactor."DocumentSnapshot"
      where scope = 'global' and not "isDeleted" group by 1
    ) d
  ),
  'operations', (select count(*) from reactor."Operation"),
  'contentFingerprint', md5(
    coalesce((select string_agg(id::text, ',' order by id) from reactor."Operation"), '')
    || '|' ||
    coalesce((
      select string_agg(format('%s/%s/%s:%s', "documentId", scope, branch, m), ',' order by "documentId", scope, branch)
      from (
        select "documentId", scope, branch, max("index") m
        from reactor."Operation" group by 1, 2, 3
      ) x
    ), '')
  ),
  'attachments', case when to_regclass('attachments.attachment') is null then 0
    else pg_temp.vetra_count('select count(*) from attachments.attachment') end,
  'workflowSecrets', coalesce((
    select pg_temp.vetra_count(format('select count(*) from %I.secret', s.table_schema))
    from s where to_regclass(format('%I.secret', s.table_schema)) is not null
  ), 0),
  'keyCheck', (
    select pg_temp.vetra_text(format(
      'select md5(coalesce(string_agg(t::text, %L order by t::text), %L)) from %I.secret_key_check t',
      ',', '', s.table_schema))
    from s
  )
);
`;

/** The Job runs this: the SQL goes to psql from a file, only the final JSON line reaches the log. */
export const COUNTS_SCRIPT = [
  "set -eu -o pipefail",
  "cat > /tmp/counts.sql <<'SQL'",
  COUNTS_SQL.trim(),
  "SQL",
  "psql -X -q -At -v ON_ERROR_STOP=1 -f /tmp/counts.sql",
].join("\n");

export interface BuildCountsJobInput {
  tenantNs: string;
  /** The dump image (it has psql). */
  image: string;
  runId: string;
}

export const countsJobName = (runId: string) => `pgcounts-${runId}`;

/**
 * Reads the counts from the tenant's primary (`<ns>-pg-rw`) with the app
 * role's credentials from the chart's `<ns>-pg-app` secret (the same as the
 * dump Job; no S3 credentials, nothing inline). Kept a day, so a missed pass
 * still reads its outcome.
 */
export function buildCountsJob(i: BuildCountsJobInput): V1Job {
  const dbSecret = `${i.tenantNs}-pg-app`;
  const labels = {
    "app.kubernetes.io/managed-by": "vetra-apps",
    "vetra.io/kind": "switchover-counts",
    "vetra.io/run-id": i.runId,
  };
  const fromSecret = (key: string) => ({
    valueFrom: { secretKeyRef: { name: dbSecret, key } },
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: countsJobName(i.runId), namespace: i.tenantNs, labels },
    spec: {
      ttlSecondsAfterFinished: 24 * 3600,
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "default",
          imagePullSecrets: [{ name: "harbor-credentials" }],
          containers: [
            {
              name: "counts",
              image: i.image,
              command: ["/bin/sh", "-c"],
              args: [COUNTS_SCRIPT],
              env: [
                {
                  name: "PGHOST",
                  value: `${i.tenantNs}-pg-rw.${i.tenantNs}.svc.cluster.local`,
                },
                { name: "PGPORT", value: "5432" },
                { name: "PGDATABASE", ...fromSecret("dbname") },
                { name: "PGUSER", ...fromSecret("username") },
                { name: "PGPASSWORD", ...fromSecret("password") },
              ],
              resources: {
                requests: { cpu: "100m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "256Mi" },
              },
            },
          ],
        },
      },
    },
  };
}

/** The last line of the log, as Counts; anything else is an error (the Job's log is not trusted blindly). */
export function parseCounts(log: string): Counts {
  const line = log.trim().split("\n").filter(Boolean).at(-1) ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("the counts job printed no JSON line");
  }
  const o = raw as Partial<Record<keyof Counts, unknown>> | null;
  const num = (v: unknown, what: string) => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
      throw new Error(`the counts job's ${what} is not a count`);
    return n;
  };
  if (!o || typeof o !== "object")
    throw new Error("the counts job printed no object");
  const byType = o.documentsByType;
  if (!byType || typeof byType !== "object" || Array.isArray(byType))
    throw new Error("the counts job's documentsByType is not an object");
  return {
    documentsByType: Object.fromEntries(
      Object.entries(byType as Record<string, unknown>)
        .map(([k, v]) => [k, num(v, `documentsByType.${k}`)] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    operations: num(o.operations, "operations"),
    attachments: num(o.attachments, "attachments"),
    workflowSecrets: num(o.workflowSecrets, "workflowSecrets"),
    contentFingerprint:
      typeof o.contentFingerprint === "string" ? o.contentFingerprint : null,
    keyCheck:
      o.keyCheck === null || o.keyCheck === undefined
        ? null
        : typeof o.keyCheck === "string"
          ? o.keyCheck
          : (() => {
              throw new Error("the counts job's keyCheck is not a string");
            })(),
  };
}

/** The first field (by name, never a value) on which two counts differ; null when equal. `operations` can be skipped (migrations add some). */
export function firstCountDifference(
  a: Counts,
  b: Counts,
  o: { operations?: boolean } = {},
): string | null {
  const types = new Set([
    ...Object.keys(a.documentsByType),
    ...Object.keys(b.documentsByType),
  ]);
  for (const t of [...types].sort())
    if ((a.documentsByType[t] ?? 0) !== (b.documentsByType[t] ?? 0))
      return `documents of type ${t}`;
  if (o.operations !== false && a.operations !== b.operations)
    return "operations";
  // With `operations: false` (migrations may append some) the content is only
  // comparable while the log has the same length.
  if (
    a.operations === b.operations &&
    a.contentFingerprint !== b.contentFingerprint
  )
    return "the operation log's content";
  if (a.attachments !== b.attachments) return "attachments";
  if (a.workflowSecrets !== b.workflowSecrets) return "workflow secrets";
  if (a.keyCheck !== b.keyCheck) return "the workflow secrets' key check";
  return null;
}

export type CountsResult =
  | { status: "RUNNING" }
  | { status: "FAILED"; error: string }
  | { status: "READY"; counts: Counts };

/** Counts jobs against a cluster; idempotent per (tenant, runId). */
export interface CountsRunner {
  start(i: { tenant: string; runId: string }): Promise<void>;
  result(i: { tenant: string; runId: string }): Promise<CountsResult>;
}

export function createCountsRunner(d: {
  k8s: {
    createJob(ns: string, job: V1Job): Promise<string>;
    readJobStatus(
      ns: string,
      name: string,
    ): Promise<{
      succeeded?: number;
      failed?: number;
      conditions?: Array<{ type?: string; status?: string }>;
    } | null>;
    readPodLogsForJob(ns: string, name: string): Promise<string>;
  };
  image: string;
}): CountsRunner {
  return {
    async start({ tenant, runId }) {
      if (await d.k8s.readJobStatus(tenant, countsJobName(runId))) return;
      await d.k8s.createJob(
        tenant,
        buildCountsJob({ tenantNs: tenant, image: d.image, runId }),
      );
    },
    async result({ tenant, runId }) {
      const name = countsJobName(runId);
      const s = await d.k8s.readJobStatus(tenant, name);
      if (!s) return { status: "FAILED", error: `Job ${name} does not exist` };
      const isTrue = (t: string) =>
        s.conditions?.some((c) => c.type === t && c.status === "True") ?? false;
      const log = async () =>
        d.k8s.readPodLogsForJob(tenant, name).catch(() => "");
      if (isTrue("Failed") || (s.failed ?? 0) > 0)
        return {
          status: "FAILED",
          error:
            (await log())
              .trim()
              .split("\n")
              .filter(Boolean)
              .at(-1)
              ?.slice(0, 300) || "the counts job failed",
        };
      if (isTrue("Complete") || (s.succeeded ?? 0) > 0) {
        try {
          return { status: "READY", counts: parseCounts(await log()) };
        } catch (err) {
          return { status: "FAILED", error: (err as Error).message };
        }
      }
      return { status: "RUNNING" };
    },
  };
}
