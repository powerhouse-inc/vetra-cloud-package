import { archiveKey, type ArchivesRepo } from "./archive-repo.js";
import { parseArchiveSha256 } from "./archive-job-spec.js";

type JobCondition = { type?: string; status?: string; reason?: string };
export type ArchiveJobStatus = {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: JobCondition[];
};

export type ReconcileArchiveInput = {
  repo: ArchivesRepo;
  archiveId: string;
  jobName: string;
  jobStatus: ArchiveJobStatus;
  podPhase: string | null;
  now: Date;
  headSize: (s3Key: string) => Promise<number | null>;
  readPodLogs: (jobName: string) => Promise<string>;
};

const lastLine = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .at(-1) ?? "";

/**
 * reconcileJob's twin for /data archives, stricter on success: a restore
 * trusts an archive only with its checksum and its object, so a Job that
 * finished without either is FAILED, never READY with size 0.
 */
export async function reconcileArchiveJob(
  i: ReconcileArchiveInput,
): Promise<void> {
  const a = await i.repo.getById(i.archiveId);
  if (!a || a.status === "READY" || a.status === "FAILED") return;
  const cond = (type: string) =>
    i.jobStatus.conditions?.some(
      (c) => c.type === type && c.status === "True",
    ) ?? false;
  const failed = cond("Failed") || (i.jobStatus.failed ?? 0) > 0;
  const complete =
    !failed && (cond("Complete") || (i.jobStatus.succeeded ?? 0) > 0);
  if (failed) {
    const logs = await i.readPodLogs(i.jobName).catch(() => "");
    const reason = i.jobStatus.conditions?.find(
      (c) => c.type === "Failed",
    )?.reason;
    await i.repo.markFailed(
      a.id,
      lastLine(logs) || reason || "Job failed",
      i.now,
    );
    return;
  }
  if (complete) {
    const sha = parseArchiveSha256(
      await i.readPodLogs(i.jobName).catch(() => ""),
    );
    if (!sha) {
      await i.repo.markFailed(
        a.id,
        "the archive Job finished without a checksum",
        i.now,
      );
      return;
    }
    const key = archiveKey(a.tenantId, a.id);
    const size = await i.headSize(key).catch(() => null);
    if (size === null) {
      await i.repo.markFailed(a.id, "the archive is not in the bucket", i.now);
      return;
    }
    await i.repo.markReady(a.id, key, size, sha, i.now);
    return;
  }
  if (i.podPhase === "Running" && a.status === "PENDING")
    await i.repo.markRunning(a.id, i.jobName, i.now);
}
