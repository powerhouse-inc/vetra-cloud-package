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
  /** Lists currently-existing restore Jobs in the given namespace. Used
   *  for the RESTORE_IN_PROGRESS concurrency gate. Throws on k8s API
   *  errors — the resolver wraps this call and fails closed so a
   *  transient outage can't let two concurrent pg_restore --clean
   *  processes race the same database. */
  listRestoreJobsInNamespace(namespace: string): Promise<Array<{ name: string }>>;
  /**
   * Lists tenant-app Deployments in the namespace — those labelled
   * `app.kubernetes.io/component` with a value the reset/restart
   * feature recognises (connect / switchboard / clint / fusion). The
   * caller filters by component (and, for clint, by the additional
   * `clint.vetra.io/agent` label that disambiguates per-agent
   * deployments) so this method deliberately returns the raw label
   * map alongside the component shortcut.
   *
   * Throws on k8s API errors. The reset/restart resolvers wrap the
   * call so a missing RBAC grant surfaces as a clear GraphQL error.
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
   * `kubectl.kubernetes.io/restartedAt: <ISO>` annotation. The
   * Deployment controller sees a change to the pod template hash and
   * rolls the ReplicaSet — exactly what `kubectl rollout restart
   * deployment/<name>` does.
   *
   * Uses a strategic-merge patch so the annotation is added without
   * disturbing other annotations already on the template.
   */
  patchDeploymentRestart(namespace: string, name: string): Promise<void>;
}

/**
 * Label selector matching tenant-app Deployments. The chart renders
 * one Deployment per (component, [agent-prefix]) so a single list call
 * with this selector returns everything the reset + restart feature
 * cares about; the caller then filters by component / labels in TS.
 *
 * Kept colocated with the selector that distinguishes managed Jobs
 * so the two layers of "which resources are ours" stay in one file.
 */
const APP_COMPONENT_SELECTOR =
  "app.kubernetes.io/component in (connect,switchboard,clint,fusion)";

const MANAGED_BY_SELECTOR =
  "app.kubernetes.io/managed-by=vetra-cloud-observability";

/**
 * Production implementation. Uses the in-cluster ServiceAccount via
 * `loadFromCluster()` (the subgraph runs in-cluster).
 */
export async function createDefaultDumpsK8sClient(): Promise<DumpsK8sClient> {
  const {
    KubeConfig,
    BatchV1Api,
    CoreV1Api,
    AppsV1Api,
    PatchStrategy,
    setHeaderOptions,
  } = await import("@kubernetes/client-node");
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batch = kc.makeApiClient(BatchV1Api);
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);

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
    async listRestoreJobsInNamespace(namespace) {
      // No try/catch: callers (currently just the restoreEnvironmentDump
      // resolver's concurrency gate) must decide how to handle k8s API
      // errors. Swallowing here would let two concurrent restores both
      // observe an empty list and both proceed.
      const res = await batch.listNamespacedJob({
        namespace,
        labelSelector: `${MANAGED_BY_SELECTOR},vetra.io/kind=restore`,
      });
      return res.items
        .map((j) => ({ name: j.metadata?.name ?? "" }))
        .filter((j) => j.name);
    },
    async listAppDeployments(namespace) {
      const res = await apps.listNamespacedDeployment({
        namespace,
        labelSelector: APP_COMPONENT_SELECTOR,
      });
      return res.items
        .map((d) => {
          const labels = d.metadata?.labels ?? {};
          return {
            name: d.metadata?.name ?? "",
            component: labels["app.kubernetes.io/component"] ?? "",
            labels,
          };
        })
        .filter((d) => d.name);
    },
    async patchDeploymentRestart(namespace, name) {
      // strategic-merge is the patch type `kubectl rollout restart`
      // uses. The generated SDK's `patchNamespacedDeployment` defaults
      // to JSON-patch via `getPreferredMediaType`; we override the
      // Content-Type per call with setHeaderOptions so the body is
      // interpreted as a merge against the existing pod template
      // rather than a list of JSON-patch operations.
      const body = {
        spec: {
          template: {
            metadata: {
              annotations: {
                "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
              },
            },
          },
        },
      };
      await apps.patchNamespacedDeployment(
        { name, namespace, body },
        setHeaderOptions("Content-Type", PatchStrategy.StrategicMergePatch),
      );
    },
  };
}
