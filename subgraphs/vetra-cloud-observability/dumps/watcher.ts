import type { DumpsRepo } from "./repo.js";

type JobCondition = { type?: string; status?: string; reason?: string };
type JobStatus = {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: JobCondition[];
};

export type ReconcileJobInput = {
  repo: DumpsRepo;
  dumpId: string;
  jobName: string;
  jobStatus: JobStatus;
  podPhase: string | null;
  now: Date;
  headSize: (s3Key: string) => Promise<number | null>;
  readPodLogs: (jobName: string) => Promise<string>;
};

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function isTrue(condition: JobCondition | undefined): boolean {
  return condition?.status === "True";
}

/**
 * Translates a Job's observed state into row transitions on the
 * `database_dumps` table.
 *
 * - Idempotent: if the row is already in a terminal state (READY or
 *   FAILED), returns without touching it.
 * - Failure preferred over success: if both a Failed condition and a
 *   succeeded count are present (shouldn't happen, but be safe), we
 *   record the failure.
 * - Job condition `Complete=True` (or `succeeded > 0`) → READY. We
 *   then HEAD the s3 object to record `sizeBytes`; a missing object
 *   stores `0` rather than failing the row, so the user at least sees
 *   the dump is "done" — they can retry if download fails.
 * - Job condition `Failed=True` (or `failed > 0`) → FAILED. The error
 *   message is the last non-empty line of pod logs, or the Failed
 *   condition's reason as a fallback.
 */
export async function reconcileJob(input: ReconcileJobInput): Promise<void> {
  const {
    repo,
    dumpId,
    jobName,
    jobStatus,
    podPhase,
    now,
    headSize,
    readPodLogs,
  } = input;
  const dump = await repo.getById(dumpId);
  if (!dump) return;

  if (dump.status === "READY" || dump.status === "FAILED") return;

  const failedCondition = jobStatus.conditions?.find(
    (c) => c.type === "Failed",
  );
  const completeCondition = jobStatus.conditions?.find(
    (c) => c.type === "Complete",
  );
  const isFailed = isTrue(failedCondition) || (jobStatus.failed ?? 0) > 0;
  const isComplete =
    !isFailed &&
    (isTrue(completeCondition) || (jobStatus.succeeded ?? 0) > 0);

  if (isFailed) {
    const logs = await readPodLogs(jobName).catch(() => "");
    const reason =
      lastNonEmptyLine(logs) || failedCondition?.reason || "Job failed";
    await repo.markFailed(dumpId, reason, now);
    return;
  }

  if (isComplete) {
    const s3Key = `${dump.tenantId}/${dump.id}.dump`;
    const size = (await headSize(s3Key).catch(() => null)) ?? 0;
    await repo.markReady(dumpId, s3Key, size, now);
    return;
  }

  if (podPhase === "Running" && dump.status === "PENDING") {
    await repo.markRunning(dumpId, jobName, now);
  }
}
