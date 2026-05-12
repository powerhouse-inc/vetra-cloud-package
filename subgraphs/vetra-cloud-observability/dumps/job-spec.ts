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
};

/**
 * Restore Jobs reuse the same input shape as dump Jobs — same image
 * (carries both pg_dump and pg_restore), same S3 + DB env, same
 * tenant-scoped naming. The only difference is the container command
 * (see `buildRestoreJob`) and the label discriminator (`vetra.io/kind`).
 */
export type BuildRestoreJobInput = BuildDumpJobInput;

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
      activeDeadlineSeconds: 3600,
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
                { name: "S3_KEY", value: `${tenantNs}/${dumpId}.dump` },
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

/**
 * Builds the one-shot Job manifest for an on-demand pg_restore.
 *
 * Reuses the `pgdump-uploader` image (it already carries `pg_restore`
 * and `s5cmd`) and the dump pipeline's env contract — same S3 key
 * (`${tenantNs}/${dumpId}.dump`), same DB credentials secret, same
 * resource/ttl/deadline knobs.
 *
 * Labels carry both the existing `app.kubernetes.io/managed-by` (so the
 * dump watcher's `listManagedJobs` selector still finds the Job and we
 * get a consistent global view) and two new labels:
 *   - `vetra.io/kind: restore` — discriminator so we can list restore
 *     Jobs separately for the RESTORE_IN_PROGRESS concurrency gate.
 *   - `vetra.io/restore-id: <dumpId>` — traceability back to the source
 *     dump. Keeping it parallel to `vetra.io/dump-id` lets us extend
 *     `listManagedJobs` in v2 without breaking the dump watcher's label
 *     filter today.
 *
 * Command: streams the dump file from S3 through `pg_restore`. Uses
 * `--clean --if-exists --no-owner --no-acl` to drop and recreate every
 * object in the target schema. `pipefail` so a mid-stream s5cmd error
 * fails the Job rather than leaving a half-restored database.
 */
export function buildRestoreJob(input: BuildRestoreJobInput): V1Job {
  const { dumpId, tenantNs, image, bucket, s3Endpoint, s3AccessKey, s3SecretKey } = input;
  const dbSecret = `${tenantNs}-pg-app`;
  const labels = {
    "app.kubernetes.io/managed-by": MANAGED_BY,
    "vetra.io/kind": "restore",
    "vetra.io/restore-id": dumpId,
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `pgrestore-${dumpId}`,
      namespace: tenantNs,
      labels,
    },
    spec: {
      ttlSecondsAfterFinished: 600,
      backoffLimit: 0,
      activeDeadlineSeconds: 3600,
      template: {
        metadata: {
          labels,
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: "default",
          imagePullSecrets: [{ name: "harbor-credentials" }],
          containers: [
            {
              name: "pgrestore",
              image,
              command: ["/bin/sh", "-c"],
              args: [
                'set -eu -o pipefail; s5cmd --endpoint-url "$S3_ENDPOINT" cat "s3://$S3_BUCKET/$S3_KEY" | pg_restore --clean --if-exists --no-owner --no-acl --dbname="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"',
              ],
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
                { name: "S3_KEY", value: `${tenantNs}/${dumpId}.dump` },
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
