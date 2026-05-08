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
