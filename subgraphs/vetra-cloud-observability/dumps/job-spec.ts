import type { V1Job } from "@kubernetes/client-node";

export type BuildDumpJobInput = {
  dumpId: string;
  tenantNs: string;
  image: string;
  bucket: string;
  s3Endpoint: string;
  /**
   * S3 credentials, passed inline as plain env values rather than via
   * secretKeyRef. Rationale: a per-namespace `env-dumps-s3-credentials`
   * Secret would require either a chart change (per-tenant ExternalSecret
   * gating) or RBAC `secrets: create` for the subgraph SA. The keys are
   * visible to anyone with `kubectl get pod -o yaml` in the tenant ns,
   * but those callers can already read the colocated `<ns>-pg-app` DB
   * password Secret directly, so the disclosure surface is the same.
   * Job pods are also short-lived (1h hard limit, 10min TTL after
   * completion).
   */
  s3AccessKey: string;
  s3SecretKey: string;
  /** Where the dump is written, when not `<tenantNs>/<dumpId>.dump`. */
  s3Key?: string;
  /** The Job's hard ceiling in seconds (default 3600; a switch-over dump of a multi-GB database takes longer). */
  deadlineSeconds?: number;
};

const MANAGED_BY = "vetra-cloud-observability";

/**
 * Builds the one-shot Job manifest for an on-demand pg_dump.
 *
 * - Runs against the tenant's PgBouncer pooler, not the primary, so
 *   `pg_dump` shares the same connection path the app uses.
 * - `backoffLimit: 0` — failure surfaces to the user as FAILED; "Retry"
 *   creates a new dump rather than re-running the same Job.
 * - `activeDeadlineSeconds: 3600` — hard 1h ceiling; envs with massive
 *   DBs would be a separate feature anyway.
 * - DB credentials come from the chart-rendered `<ns>-pg-app` secret.
 *   S3 credentials come from a per-tenant `env-dumps-s3-credentials`
 *   ExternalSecret (one bucket prefix scope per tenant).
 */
export function buildDumpJob(input: BuildDumpJobInput): V1Job {
  const { dumpId, tenantNs, image, bucket, s3Endpoint, s3AccessKey, s3SecretKey } = input;
  const dbSecret = `${tenantNs}-pg-app`;
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "vetra.io/dump-id": dumpId,
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `pgdump-${dumpId}`,
      namespace: tenantNs,
      labels,
    },
    spec: {
      ttlSecondsAfterFinished: 600,
      backoffLimit: 0,
      activeDeadlineSeconds: input.deadlineSeconds ?? 3600,
      template: {
        metadata: {
          labels,
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "default",
          // Tenant namespaces ship a `harbor-credentials` Secret via
          // the chart so first-party images on cr.vetra.io can be
          // pulled. Default SA does not auto-mount it, so we attach
          // it explicitly on the pod spec.
          imagePullSecrets: [{ name: "harbor-credentials" }],
          containers: [
            {
              name: "pgdump",
              image,
              env: [
                {
                  name: "PGHOST",
                  value: `${tenantNs}-pg-pooler.${tenantNs}.svc.cluster.local`,
                },
                { name: "PGPORT", value: "5432" },
                {
                  name: "PGDATABASE",
                  valueFrom: {
                    secretKeyRef: { name: dbSecret, key: "dbname" },
                  },
                },
                {
                  name: "PGUSER",
                  valueFrom: {
                    secretKeyRef: { name: dbSecret, key: "username" },
                  },
                },
                {
                  name: "PGPASSWORD",
                  valueFrom: {
                    secretKeyRef: { name: dbSecret, key: "password" },
                  },
                },
                { name: "S3_BUCKET", value: bucket },
                { name: "S3_KEY", value: input.s3Key ?? `${tenantNs}/${dumpId}.dump` },
                { name: "S3_ENDPOINT", value: s3Endpoint },
                { name: "AWS_ACCESS_KEY_ID", value: s3AccessKey },
                { name: "AWS_SECRET_ACCESS_KEY", value: s3SecretKey },
              ],
              resources: {
                requests: { cpu: "200m", memory: "256Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
            },
          ],
        },
      },
    },
  };
}

export type BuildRestoreJobInput = Omit<BuildDumpJobInput, "dumpId"> & {
  restoreId: string;
  /** The dump to restore; its file is `${tenantNs}/${dumpId}.dump`. */
  dumpId: string;
};

/**
 * Shell run by the restore Job. One `psql --single-transaction` with
 * ON_ERROR_STOP, so the database is either fully restored or untouched:
 *
 * 1. `DROP OWNED BY CURRENT_USER CASCADE` removes everything the app role
 *    owns — including tables in `public`, which on PG15+ belongs to
 *    `pg_database_owner` and would survive a schema-level drop — so objects
 *    created after the dump don't linger into a mixed state.
 * 2. The dump's SQL, minus EXTENSION entries: extensions are owned by the
 *    superuser, survive step 1, and the app role can't recreate or comment
 *    on them.
 */
export const RESTORE_SCRIPT = [
  "set -eu -o pipefail",
  's5cmd --endpoint-url "$S3_ENDPOINT" cp "s3://$S3_BUCKET/$S3_KEY" /tmp/restore.dump',
  "pg_restore -l /tmp/restore.dump | grep -v -E ' EXTENSION | COMMENT - EXTENSION ' > /tmp/restore.list",
  "{ echo 'DROP OWNED BY CURRENT_USER CASCADE;'; pg_restore --no-owner --no-acl -L /tmp/restore.list -f - /tmp/restore.dump; }" +
    " | psql -X -q -v ON_ERROR_STOP=1 --single-transaction",
  'echo "restore complete"',
].join("\n");

/**
 * Builds the one-shot Job that restores a dump into the tenant database.
 * Same image, credentials and knobs as the dump Job, but:
 * - connects to the CNPG primary (`<ns>-pg-rw`), never the PgBouncer
 *   pooler: tenants run it in transaction mode, which drops the session
 *   state (`search_path` etc.) a restore script depends on;
 * - labelled `vetra.io/kind=restore` + `vetra.io/restore-id` and NOT
 *   `vetra.io/dump-id`, so the dump watcher never mistakes it for a dump.
 */
export function buildRestoreJob(input: BuildRestoreJobInput): V1Job {
  const { restoreId, tenantNs } = input;
  const dumpJob = buildDumpJob(input);
  const dumpPod = dumpJob.spec!.template.spec!;
  const dumpContainer = dumpPod.containers[0];
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "vetra.io/kind": "restore",
    "vetra.io/restore-id": restoreId,
  };
  const env = (dumpContainer.env ?? []).map((e) =>
    e.name === "PGHOST"
      ? { name: "PGHOST", value: `${tenantNs}-pg-rw.${tenantNs}.svc.cluster.local` }
      : e,
  );

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: `pgrestore-${restoreId}`, namespace: tenantNs, labels },
    spec: {
      // Kept a day: vetra-apps reads the outcome by name, and a missing Job is an unknown outcome.
      ttlSecondsAfterFinished: 24 * 3600,
      backoffLimit: 0,
      activeDeadlineSeconds: dumpJob.spec!.activeDeadlineSeconds,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: dumpPod.serviceAccountName,
          imagePullSecrets: dumpPod.imagePullSecrets,
          containers: [
            {
              name: "pgrestore",
              image: dumpContainer.image,
              command: ["/bin/sh", "-c"],
              args: [RESTORE_SCRIPT],
              env,
              resources: dumpContainer.resources,
            },
          ],
        },
      },
    },
  };
}

export type BuildFreshRestoreJobInput = BuildDumpJobInput & {
  restoreId: string;
  /** The dump's object key (a switch-over dump lives under `switchover/`, not in the target's own prefix). */
  s3Key: string;
  /** pg_restore -j. */
  jobs: number;
  /**
   * Drop what an earlier, failed restore left in the target first. Only for a
   * target that never started (the caller checks): the empty-target check
   * below is the guard otherwise.
   */
  reset?: boolean;
};

/**
 * The switch-over's restore (plan 9, F8): a dump made in ANOTHER tenant goes
 * into this tenant's new, never-started, empty database. Unlike
 * RESTORE_SCRIPT there is no `DROP OWNED` (unless `reset`) and no single
 * transaction: pg_restore -j runs parallel, and a failure is redone from an
 * empty database. It refuses a target that already has relations of its own
 * (extensions' objects aside), so it can never overwrite data.
 */
export const FRESH_RESTORE_SCRIPT = [
  "set -eu -o pipefail",
  's5cmd --endpoint-url "$S3_ENDPOINT" cp "s3://$S3_BUCKET/$S3_KEY" /tmp/restore.dump',
  'if [ "${RESET_TARGET:-}" = "1" ]; then psql -X -q -v ON_ERROR_STOP=1 -c "DROP OWNED BY CURRENT_USER CASCADE"; fi',
  "N=$(psql -X -At -v ON_ERROR_STOP=1 -c \"select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_' and c.relkind in ('r','p','v','m','S','f') and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')\")",
  'if [ "$N" != "0" ]; then echo "the target database is not empty ($N relations): refusing to restore"; exit 1; fi',
  "pg_restore -l /tmp/restore.dump | grep -v -E ' EXTENSION | COMMENT - EXTENSION ' > /tmp/restore.list",
  'pg_restore --no-owner --no-acl --exit-on-error -j "$RESTORE_JOBS" -L /tmp/restore.list -d "$PGDATABASE" /tmp/restore.dump',
  'echo "restore complete"',
].join("\n");

/** Labelled vetra.io/kind=restore like buildRestoreJob (never a dump id); named `pgfresh-<restoreId>`. */
export function buildFreshRestoreJob(input: BuildFreshRestoreJobInput): V1Job {
  const { restoreId, tenantNs } = input;
  const base = buildRestoreJob({ ...input, dumpId: restoreId });
  const pod = base.spec!.template.spec!;
  const container = pod.containers[0];
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "vetra.io/kind": "restore",
    "vetra.io/restore-id": restoreId,
  };
  const env = (container.env ?? []).map((e) =>
    e.name === "S3_KEY" ? { name: "S3_KEY", value: input.s3Key } : e,
  );
  env.push({ name: "RESTORE_JOBS", value: String(Math.max(1, Math.floor(input.jobs))) });
  if (input.reset) env.push({ name: "RESET_TARGET", value: "1" });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: `pgfresh-${restoreId}`, namespace: tenantNs, labels },
    spec: {
      ttlSecondsAfterFinished: 24 * 3600,
      backoffLimit: 0,
      // A multi-GB dump restores for far longer than the hour the same-tenant restore keeps.
      activeDeadlineSeconds: 4 * 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: pod.serviceAccountName,
          imagePullSecrets: pod.imagePullSecrets,
          containers: [
            {
              name: "pgfresh",
              image: container.image,
              command: ["/bin/sh", "-c"],
              args: [FRESH_RESTORE_SCRIPT],
              env,
              resources: {
                requests: {
                  cpu: "500m",
                  memory: "512Mi",
                  "ephemeral-storage": "20Gi",
                },
                limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "30Gi" },
              },
            },
          ],
        },
      },
    },
  };
}
