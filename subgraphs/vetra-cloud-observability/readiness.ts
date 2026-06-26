/**
 * Pod-readiness helpers for the deployment reconciler.
 *
 * The reconciler historically marked an environment READY only once ArgoCD
 * reported the Application "Healthy". ArgoCD's health aggregation lags actual
 * pod readiness by ~15-30s (it waits for the slowest pod and adds its own
 * assessment delay), so the user-visible "ready" signal was slow. The pod
 * watcher already tracks per-pod readiness event-driven in `environment_pods`,
 * so we can flip READY as soon as the workload is actually serving.
 */

export interface PodReadiness {
  ready: number | boolean | null;
  phase: string | null;
}

interface EnvServiceEntry {
  type?: string;
  enabled?: boolean;
}

/** Number of enabled services in an environment record's `services` JSON. */
export function enabledServiceCount(servicesRaw: unknown): number {
  let arr: unknown = servicesRaw;
  if (typeof servicesRaw === "string") {
    try {
      arr = JSON.parse(servicesRaw);
    } catch {
      return 0;
    }
  }
  if (!Array.isArray(arr)) return 0;
  return (arr as EnvServiceEntry[]).filter((s) => s && s.enabled === true)
    .length;
}

function podIsReady(p: PodReadiness): boolean {
  const ready = p.ready === 1 || p.ready === true;
  return ready && (p.phase ?? "").toUpperCase() === "RUNNING";
}

/**
 * True when the environment's workload is actually serving: every observed pod
 * is ready+Running AND there are at least as many pods as enabled services (so
 * we never fire before a service's pod has even been created). Conservative by
 * design — a single not-yet-ready pod, or a missing service pod, keeps it false
 * and lets the reconciler fall back to ArgoCD health (which still catches
 * DEGRADED/timeout failures).
 */
export function coreServicesReady(
  servicesRaw: unknown,
  pods: ReadonlyArray<PodReadiness>,
): boolean {
  const expected = enabledServiceCount(servicesRaw);
  if (expected <= 0) return false;
  if (pods.length < expected) return false;
  return pods.every(podIsReady);
}
