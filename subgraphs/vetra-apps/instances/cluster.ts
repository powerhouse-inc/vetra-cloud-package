import type { Kysely } from "kysely";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import type { ArgoSnapshot, PodSnapshot } from "./health.js";

/**
 * The cluster as the observability subgraph records it (its watchers keep
 * these tables; nothing here talks to Kubernetes). Host pods are the tenant's
 * pods whose image is the environment's FUSION repository; database and
 * helper pods are left out. Null: no row at all for the tenant.
 */
export async function readCluster(
  db: Kysely<ObservabilityDB>,
  tenantId: string,
  repository: string | null,
): Promise<{ argo: ArgoSnapshot | null; hostPods: PodSnapshot[] } | null> {
  const argo = await db
    .selectFrom("environment_status")
    .select([
      "argoSyncStatus",
      "argoHealthStatus",
      "argoMessage",
      "configDriftDetected",
    ])
    .where("tenantId", "=", tenantId)
    .executeTakeFirst();
  const pods = await db
    .selectFrom("environment_pods")
    .select([
      "phase",
      "ready",
      "restartCount",
      "image",
      "imageId",
      "waitingReason",
    ])
    .where("tenantId", "=", tenantId)
    .orderBy("id")
    .execute();
  if (!argo && pods.length === 0) return null;
  const isHost = (image: string | null | undefined) =>
    !!repository &&
    !!image &&
    (image.startsWith(`${repository}:`) || image.startsWith(`${repository}@`));
  return {
    argo: argo
      ? {
          syncStatus: argo.argoSyncStatus,
          healthStatus: argo.argoHealthStatus,
          drift: Number(argo.configDriftDetected) === 1,
          message: argo.argoMessage,
        }
      : null,
    hostPods: pods
      .filter((p) => isHost(p.image))
      .map((p) => ({
        phase: p.phase,
        ready: Number(p.ready) === 1,
        restartCount: Number(p.restartCount),
        image: p.image ?? null,
        imageId: p.imageId ?? null,
        waitingReason: p.waitingReason ?? null,
      })),
  };
}
