import type { ArchivesRepo } from "./archive-repo.js";
import { reconcileArchiveJob } from "./archive-watcher.js";
import type { DumpsK8sClient } from "./k8s-client.js";
import type { DumpsRepo } from "./repo.js";
import { reconcileJob } from "./watcher.js";

export type WatchDeps = {
  dumps: DumpsRepo;
  archives: ArchivesRepo;
  k8s: Pick<
    DumpsK8sClient,
    | "listManagedJobs"
    | "readJobStatus"
    | "readPodPhaseForJob"
    | "readPodLogsForJob"
  >;
  headSize: (s3Key: string) => Promise<number | null>;
  now: () => Date;
};

const gone = (name: string, ns: string, what: string) =>
  `Job "${name}" no longer exists in namespace ${ns}; orphaned ${what} marked failed.`;

/**
 * One tick of the dumps Job watcher: every in-flight database dump and /data
 * archive against its Job (matched by label, so a restart resumes). A row
 * whose Job was named but is gone is FAILED; a row without a Job name yet is
 * left for the next tick (its creator is between insert and createJob).
 */
export async function watchJobsOnce(deps: WatchDeps): Promise<void> {
  const dumps = await deps.dumps.listInFlight();
  const archives = await deps.archives.listInFlight();
  if (dumps.length === 0 && archives.length === 0) return;
  const managed = await deps.k8s.listManagedJobs();
  const byDump = new Map(
    managed.filter((j) => j.dumpId).map((j) => [j.dumpId!, j]),
  );
  const byArchive = new Map(
    managed.filter((j) => j.archiveId).map((j) => [j.archiveId!, j]),
  );

  for (const dump of dumps) {
    const ref = byDump.get(dump.id);
    if (!ref) {
      if (dump.jobName)
        await deps.dumps.markFailed(
          dump.id,
          gone(dump.jobName, dump.tenantId, "dump"),
          deps.now(),
        );
      continue;
    }
    const status = await deps.k8s.readJobStatus(ref.namespace, ref.name);
    if (!status) continue;
    await reconcileJob({
      repo: deps.dumps,
      dumpId: dump.id,
      jobName: ref.name,
      jobStatus: status,
      podPhase: await deps.k8s.readPodPhaseForJob(ref.namespace, ref.name),
      now: deps.now(),
      headSize: deps.headSize,
      readPodLogs: () => deps.k8s.readPodLogsForJob(ref.namespace, ref.name),
    });
  }

  for (const archive of archives) {
    const ref = byArchive.get(archive.id);
    if (!ref) {
      if (archive.jobName)
        await deps.archives.markFailed(
          archive.id,
          gone(archive.jobName, archive.tenantId, "archive"),
          deps.now(),
        );
      continue;
    }
    const status = await deps.k8s.readJobStatus(ref.namespace, ref.name);
    if (!status) continue;
    await reconcileArchiveJob({
      repo: deps.archives,
      archiveId: archive.id,
      jobName: ref.name,
      jobStatus: status,
      podPhase: await deps.k8s.readPodPhaseForJob(ref.namespace, ref.name),
      now: deps.now(),
      headSize: deps.headSize,
      readPodLogs: () => deps.k8s.readPodLogsForJob(ref.namespace, ref.name),
    });
  }
}
