import type { V1Job } from "@kubernetes/client-node";
import type { DatabaseRestores } from "../db/schema.js";
import type { DumpsK8sClient } from "./k8s-client.js";
import type { DumpsRepo } from "./repo.js";
import type { RestoresRepo } from "./restore-repo.js";

/** The tenant's database writers: the chart labels the Switchboard Deployment and its pods with this. */
export const SWITCHBOARD_SELECTOR = "app.kubernetes.io/component=switchboard";

/** How long STOPPING / STARTING may take before the advancer moves on. */
export const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** Kubernetes surface the restore flow needs. */
export interface RestoreK8s {
  createJob: DumpsK8sClient["createJob"];
  readJobStatus: DumpsK8sClient["readJobStatus"];
  readPodLogsForJob: DumpsK8sClient["readPodLogsForJob"];
  /** `spec.replicas` of every Deployment matching the selector, by name. */
  readDeploymentReplicas(namespace: string, labelSelector: string): Promise<Record<string, number>>;
  scaleDeployment(namespace: string, name: string, replicas: number): Promise<void>;
  /** Pods matching the selector that haven't terminated yet. */
  countPods(namespace: string, labelSelector: string): Promise<number>;
  /** True when every named Deployment has at least its desired replicas ready. */
  deploymentsReady(namespace: string, replicas: Record<string, number>): Promise<boolean>;
}

export type AdvanceDeps = {
  restores: Pick<RestoresRepo, "update">;
  dumps: Pick<DumpsRepo, "getById">;
  k8s: RestoreK8s;
  buildJob: (row: DatabaseRestores) => V1Job;
  /** Called once when a restore reaches SUCCEEDED or FAILED (e.g. safety-dump retention). */
  onFinished?: (row: DatabaseRestores) => Promise<void>;
};

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

function parseReplicas(raw: string | null): Record<string, number> {
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
}

async function scaleAll(k8s: RestoreK8s, ns: string, replicas: Record<string, number>, to?: number) {
  for (const [name, n] of Object.entries(replicas)) {
    await k8s.scaleDeployment(ns, name, to ?? n);
  }
}

/**
 * Moves one restore forward by at most one step. Every step is driven only
 * by the persisted row and the cluster, so ticks are idempotent and a
 * subgraph restart resumes where it left off:
 *
 *   SAFETY_DUMP — wait for the PRE_RESTORE dump; READY → record Switchboard
 *                 replicas, scale to 0 → STOPPING. FAILED → FAILED, nothing
 *                 touched.
 *   STOPPING    — no Switchboard pods left → create the restore Job →
 *                 RESTORING. Timeout → scale back, STARTING with an error.
 *   RESTORING   — Job done (either way) → scale back → STARTING; a failure
 *                 keeps its last log line in `errorMessage`.
 *   STARTING    — Switchboard ready (or timeout) → SUCCEEDED, or FAILED when
 *                 an error was recorded.
 */
export async function advanceRestore(
  row: DatabaseRestores,
  deps: AdvanceDeps,
  now: Date,
): Promise<void> {
  const { restores, dumps, k8s } = deps;
  const ns = row.tenantId;
  const timedOut = now.getTime() - new Date(row.updatedAt).getTime() > STEP_TIMEOUT_MS;

  const finish = async (errorMessage: string | null) => {
    const patch = {
      status: errorMessage ? ("FAILED" as const) : ("SUCCEEDED" as const),
      errorMessage,
      completedAt: now.toISOString(),
    };
    await restores.update(row.id, patch, now);
    await deps.onFinished?.({ ...row, ...patch });
  };

  switch (row.status) {
    case "SAFETY_DUMP": {
      const safety = await dumps.getById(row.safetyDumpId);
      if (!safety || safety.status === "FAILED") {
        await finish(`Safety backup failed: ${safety?.errorMessage ?? "dump record missing"}`);
        return;
      }
      if (safety.status !== "READY") return;
      const replicas = await k8s.readDeploymentReplicas(ns, SWITCHBOARD_SELECTOR);
      if (Object.keys(replicas).length === 0) {
        await finish("No Switchboard deployment found for this environment");
        return;
      }
      // Persist before scaling so a crash between the two can always scale back.
      await restores.update(row.id, { status: "STOPPING", replicas: JSON.stringify(replicas) }, now);
      await scaleAll(k8s, ns, replicas, 0);
      return;
    }

    case "STOPPING": {
      const replicas = parseReplicas(row.replicas);
      if ((await k8s.countPods(ns, SWITCHBOARD_SELECTOR)) === 0) {
        const jobName = await k8s.createJob(ns, deps.buildJob(row));
        await restores.update(row.id, { status: "RESTORING", jobName: jobName || `pgrestore-${row.id}` }, now);
        return;
      }
      if (timedOut) {
        await restores.update(
          row.id,
          { status: "STARTING", errorMessage: "Switchboard did not stop in time; database not changed" },
          now,
        );
        await scaleAll(k8s, ns, replicas);
        return;
      }
      await scaleAll(k8s, ns, replicas, 0); // idempotent; re-asserts if something scaled it back
      return;
    }

    case "RESTORING": {
      const status = row.jobName ? await k8s.readJobStatus(ns, row.jobName) : null;
      const isTrue = (type: string) =>
        status?.conditions?.some((c) => c.type === type && c.status === "True") ?? false;
      let errorMessage: string | null;
      if (!status) {
        errorMessage = `Restore Job "${row.jobName}" no longer exists`;
      } else if (isTrue("Failed") || (status.failed ?? 0) > 0) {
        errorMessage =
          lastLine(await k8s.readPodLogsForJob(ns, row.jobName!)) || "Restore Job failed";
      } else if (isTrue("Complete") || (status.succeeded ?? 0) > 0) {
        errorMessage = null;
      } else {
        return; // still running; the Job's own deadline bounds this step
      }
      await restores.update(row.id, { status: "STARTING", errorMessage }, now);
      await scaleAll(k8s, ns, parseReplicas(row.replicas));
      return;
    }

    case "STARTING": {
      const replicas = parseReplicas(row.replicas);
      if (!(await k8s.deploymentsReady(ns, replicas)) && !timedOut) {
        await scaleAll(k8s, ns, replicas); // idempotent
        return;
      }
      await finish(row.errorMessage);
      return;
    }

    default:
      return;
  }
}
