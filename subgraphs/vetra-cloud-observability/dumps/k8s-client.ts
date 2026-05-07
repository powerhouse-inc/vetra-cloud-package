import type { V1Job } from "@kubernetes/client-node";

/**
 * Minimal Kubernetes surface used by the dumps feature. Defined as an
 * interface so the resolvers + watcher can be unit-tested with a stub
 * and so the production implementation can be lazy-loaded (avoids
 * paying the @kubernetes/client-node import cost in tests).
 */
export interface DumpsK8sClient {
  /** Creates a Job in the given namespace. Returns the assigned name. */
  createJob(namespace: string, job: V1Job): Promise<string>;
  /** Reads `.status` of a single Job. Returns null on error / 404. */
  readJobStatus(
    namespace: string,
    name: string,
  ): Promise<{
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  } | null>;
  /** Returns the phase of the (single) pod owned by the Job, or null. */
  readPodPhaseForJob(
    namespace: string,
    jobName: string,
  ): Promise<string | null>;
  /** Returns the pod's full log output. Empty string on error. */
  readPodLogsForJob(namespace: string, jobName: string): Promise<string>;
  /** Lists all dumps Jobs across the cluster (label-selected). */
  listManagedJobs(): Promise<
    Array<{ namespace: string; name: string; dumpId: string }>
  >;
}

const MANAGED_BY_SELECTOR =
  "app.kubernetes.io/managed-by=vetra-cloud-observability";

/**
 * Production implementation. Uses the in-cluster ServiceAccount via
 * `loadFromCluster()` (the subgraph runs in-cluster).
 */
export async function createDefaultDumpsK8sClient(): Promise<DumpsK8sClient> {
  const { KubeConfig, BatchV1Api, CoreV1Api } = await import(
    "@kubernetes/client-node"
  );
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batch = kc.makeApiClient(BatchV1Api);
  const core = kc.makeApiClient(CoreV1Api);

  return {
    async createJob(namespace, job) {
      const res = await batch.createNamespacedJob({ namespace, body: job });
      return res.metadata?.name ?? "";
    },
    async readJobStatus(namespace, name) {
      try {
        const res = await batch.readNamespacedJobStatus({ namespace, name });
        const s = res.status ?? {};
        return {
          active: s.active,
          succeeded: s.succeeded,
          failed: s.failed,
          conditions: s.conditions?.map((c) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
          })),
        };
      } catch {
        return null;
      }
    },
    async readPodPhaseForJob(namespace, jobName) {
      const list = await core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      return list.items[0]?.status?.phase ?? null;
    },
    async readPodLogsForJob(namespace, jobName) {
      const list = await core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      const podName = list.items[0]?.metadata?.name;
      if (!podName) return "";
      try {
        const logs = await core.readNamespacedPodLog({
          namespace,
          name: podName,
        });
        return typeof logs === "string" ? logs : "";
      } catch {
        return "";
      }
    },
    async listManagedJobs() {
      const res = await batch.listJobForAllNamespaces({
        labelSelector: MANAGED_BY_SELECTOR,
      });
      return res.items
        .map((j) => ({
          namespace: j.metadata?.namespace ?? "",
          name: j.metadata?.name ?? "",
          dumpId: j.metadata?.labels?.["vetra.io/dump-id"] ?? "",
        }))
        .filter((j) => j.name && j.dumpId);
    },
  };
}
