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
  /**
   * Deletes a Job (and its child Pods, via propagationPolicy=Foreground).
   * Idempotent: a missing Job resolves successfully so the caller can use
   * this to cancel both running and orphaned dumps.
   */
  deleteJob(namespace: string, name: string): Promise<void>;
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
    async deleteJob(namespace, name) {
      try {
        await batch.deleteNamespacedJob({
          namespace,
          name,
          propagationPolicy: "Foreground",
        });
      } catch (err: unknown) {
        const code = (err as { code?: number; statusCode?: number })?.code
          ?? (err as { code?: number; statusCode?: number })?.statusCode;
        if (code === 404) return; // already gone — treat as success
        throw err;
      }
    },
    async readJobStatus(namespace, name) {
      // Hit `readNamespacedJob` (the regular Job endpoint) rather than
      // `readNamespacedJobStatus`. Both return the full object with
      // `.status`, but the former only needs `get jobs` RBAC, while
      // the latter additionally needs `get jobs/status` (a separate
      // subresource). Our ClusterRole only grants `jobs`, and the
      // 403 from the subresource was being swallowed silently here,
      // leaving every dump stuck in PENDING.
      try {
        const res = await batch.readNamespacedJob({ namespace, name });
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
      } catch (err) {
        // 404 (Job already gone) is normal during cleanup races;
        // anything else is worth surfacing rather than silently
        // dropping the row into orphan-detection on the next tick.
        const code = (err as { code?: number; statusCode?: number })?.code
          ?? (err as { code?: number; statusCode?: number })?.statusCode;
        if (code !== 404) {
          console.warn(
            `[dump-k8s] readJobStatus(${namespace}/${name}) failed:`,
            err,
          );
        }
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
