import type { Kysely } from "kysely";
import type { V1Job } from "@kubernetes/client-node";
import { buildDataRestoreJob } from "../../vetra-cloud-observability/dumps/archive-job-spec.js";
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { createArchiveAndJob } from "../../vetra-cloud-observability/dumps/archive-service.js";
import { buildFreshRestoreJob } from "../../vetra-cloud-observability/dumps/job-spec.js";
import { DumpsRepo } from "../../vetra-cloud-observability/dumps/repo.js";
import { createDumpAndJob } from "../../vetra-cloud-observability/dumps/service.js";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import { APP_SELECTOR } from "../backups/k8s.js";
import { BackupBusyError } from "../backups/service.js";
import type { InstanceBackupDeps } from "../backups/k8s.js";
import { readFilesFromTarZst } from "./archive-files.js";

export interface JobState {
  status: "PENDING" | "RUNNING" | "READY" | "FAILED";
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Days a switch-over's dump and /data archive are kept (S13); slice 4's rule is 30. */
export const SWITCHOVER_KEEP_DAYS = 180;
/** pg_dump of a multi-GB database: well past the 1 h of an instance backup. */
export const SWITCHOVER_DUMP_DEADLINE_S = 4 * 3600;

/** The dump's and archive's keys of a switch-over: its own prefix, outside the 30-day lifecycle of the tenants' prefixes. */
export const switchoverKeys = (switchoverId: string, phase = "") => ({
  dump: `switchover/${switchoverId}/${phase}db.dump`,
  archive: `switchover/${switchoverId}/${phase}data.tar.zst`,
});

export interface SwitchoverBackups {
  /** pg_dump of a tenant's database through its pooler; source SWITCHOVER, requested by "vetra". Idempotent per key. */
  startDump(i: {
    tenant: string;
    environmentId: string;
    key: string;
  }): Promise<{ dumpId: string }>;
  dumpStatus(dumpId: string): Promise<JobState & { sizeBytes: number | null }>;
  /**
   * tar.zst of a /data PVC, mounted read-only; `sameNodeAs`: run beside that
   * pod of the tenant (the volume is RWO), for dry runs. Idempotent per key.
   */
  startArchive(i: {
    tenant: string;
    pvc: string;
    key: string;
    sameNodeAs?: { namespace: string; pod: string };
  }): Promise<{ archiveId: string }>;
  archiveStatus(archiveId: string): Promise<
    JobState & {
      sha256: string | null;
      files: number | null;
      bytes: number | null;
    }
  >;
  /**
   * Restore a dump made in another tenant into an empty, never-started
   * database (refuses a non-empty target). `attempt` > 0 re-runs after a
   * failure under a new Job name; `reset` first drops what the failed run
   * left (only for a target that never started). Idempotent per attempt.
   */
  startRestoreDump(i: {
    dumpId: string;
    targetTenant: string;
    mode: "fresh";
    jobs: number;
    attempt?: number;
    reset?: boolean;
  }): Promise<{ restoreId: string }>;
  /** Replace the target's /data with an archive of another tenant; the app must not run there. Idempotent per attempt. */
  startRestoreArchive(i: {
    archiveId: string;
    targetTenant: string;
    pvc: string;
    attempt?: number;
  }): Promise<{ restoreId: string }>;
  restoreStatus(restoreId: string): Promise<JobState>;
  /** The named files of an archive, read in memory (never written to disk or logged). */
  readArchiveFiles(
    archiveId: string,
    names: string[],
  ): Promise<Map<string, Buffer>>;
}

export interface SwitchoverBackupsDeps {
  backups: InstanceBackupDeps;
  observabilityDb: Kysely<ObservabilityDB>;
  now: () => Date;
}

/** The backups are not set up as the switch-over needs them: not retryable by waiting. */
export class SwitchoverBackupsUnavailableError extends Error {}

const REQUESTED_BY = "vetra";
const tail = (text: string) =>
  text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 300) ?? "";

const stateOf = (r: {
  status: string;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}): JobState => ({
  status: r.status as JobState["status"],
  error: r.errorMessage,
  startedAt: r.startedAt,
  finishedAt: r.completedAt,
});

const attemptSuffix = (attempt?: number) =>
  attempt && attempt > 0 ? `-${Math.floor(attempt)}` : "";

/**
 * SwitchoverBackups over slice 4's real code: observability's dump and
 * archive rows and Job builders (extended with a key override, a retention
 * and, for dumps, a deadline), the same Job watcher, and restore Jobs read
 * by name like backups/restore.ts does. A restore id is "<namespace>/<Job>".
 * Nothing here deletes anything.
 */
export function createSwitchoverBackups(
  d: SwitchoverBackupsDeps,
): SwitchoverBackups {
  const { backups: b } = d;
  const dumps = new DumpsRepo(d.observabilityDb);
  const archives = new ArchivesRepo(d.observabilityDb);
  const createJob = (ns: string, job: V1Job) => b.k8s.createJob(ns, job);

  const jobOutcome = async (ns: string, name: string): Promise<JobState> => {
    const s = await b.k8s.readJobStatus(ns, name);
    // A missing Job says nothing about the outcome: fail closed.
    if (!s)
      return {
        status: "FAILED",
        error: `Job ${name} no longer exists; its outcome is unknown`,
        startedAt: null,
        finishedAt: null,
      };
    const isTrue = (t: string) =>
      s.conditions?.some((c) => c.type === t && c.status === "True") ?? false;
    if (isTrue("Failed") || (s.failed ?? 0) > 0)
      return {
        status: "FAILED",
        error:
          tail(await b.k8s.readPodLogsForJob(ns, name).catch(() => "")) ||
          "the Job failed",
        startedAt: null,
        finishedAt: d.now().toISOString(),
      };
    if (isTrue("Complete") || (s.succeeded ?? 0) > 0)
      return {
        status: "READY",
        error: null,
        startedAt: null,
        finishedAt: d.now().toISOString(),
      };
    return {
      status: "RUNNING",
      error: null,
      startedAt: null,
      finishedAt: null,
    };
  };

  const splitId = (id: string): { ns: string; name: string } => {
    const [ns, name, extra] = id.split("/");
    if (!ns || !name || extra !== undefined)
      throw new Error(`not a restore id: ${id}`);
    return { ns, name };
  };

  return {
    async startDump(i) {
      if (!i.key.startsWith("switchover/"))
        throw new Error("a switch-over dump lives under switchover/");
      const rows = (
        await d.observabilityDb
          .selectFrom("database_dumps")
          .selectAll()
          .where("tenantId", "=", i.tenant)
          .where("source", "=", "SWITCHOVER")
          .where("s3Key", "=", i.key)
          .where("status", "in", ["PENDING", "RUNNING", "READY"])
          .orderBy("requestedAt", "desc")
          .execute()
      ).slice(0, 1);
      if (rows[0]) return { dumpId: rows[0].id };
      try {
        const dump = await createDumpAndJob(
          { repo: dumps, createJob, ...b.dumpJob },
          {
            documentId: i.environmentId,
            tenantId: i.tenant,
            requestedBy: REQUESTED_BY,
            source: "SWITCHOVER",
            now: d.now(),
            s3Key: i.key,
            ttlDays: SWITCHOVER_KEEP_DAYS,
            deadlineSeconds: SWITCHOVER_DUMP_DEADLINE_S,
          },
        );
        return { dumpId: dump.id };
      } catch (err) {
        if ((err as Error).message === "DUMP_IN_PROGRESS")
          throw new BackupBusyError("a database dump of the tenant is running");
        throw err;
      }
    },

    async dumpStatus(dumpId) {
      const r = await dumps.getById(dumpId);
      if (!r)
        return {
          status: "FAILED",
          error: "the dump is gone",
          startedAt: null,
          finishedAt: null,
          sizeBytes: null,
        };
      return {
        ...stateOf(r),
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      };
    },

    async startArchive(i) {
      if (!i.key.startsWith("switchover/"))
        throw new Error("a switch-over archive lives under switchover/");
      const found = await d.observabilityDb
        .selectFrom("data_archives")
        .selectAll()
        .where("tenantId", "=", i.tenant)
        .where("s3Key", "=", i.key)
        .where("status", "in", ["PENDING", "RUNNING", "READY"])
        .orderBy("requestedAt", "desc")
        .executeTakeFirst();
      if (found) return { archiveId: found.id };
      try {
        const a = await createArchiveAndJob(
          { repo: archives, createJob, ...b.dumpJob, image: b.archiveImage },
          {
            documentId: i.tenant,
            tenantId: i.tenant,
            requestedBy: REQUESTED_BY,
            pvcName: i.pvc,
            // The Job's affinity matches the tenant's app pod (APP_LABELS) and mounts the volume read-only.
            colocate: !!i.sameNodeAs,
            now: d.now(),
            s3Key: i.key,
            ttlDays: SWITCHOVER_KEEP_DAYS,
          },
        );
        return { archiveId: a.id };
      } catch (err) {
        if ((err as Error).message === "ARCHIVE_IN_PROGRESS")
          throw new BackupBusyError("a /data archive of the tenant is running");
        throw err;
      }
    },

    async archiveStatus(archiveId) {
      const r = await archives.getById(archiveId);
      if (!r)
        return {
          status: "FAILED",
          error: "the archive is gone",
          startedAt: null,
          finishedAt: null,
          sha256: null,
          files: null,
          bytes: null,
        };
      return {
        ...stateOf(r),
        sha256: r.sha256,
        files: null,
        bytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      };
    },

    async startRestoreDump(i) {
      if (i.mode !== "fresh")
        throw new Error("only a fresh target is supported");
      const dump = await dumps.getById(i.dumpId);
      if (!dump || dump.status !== "READY" || !dump.s3Key)
        throw new Error("the dump is not ready");
      if (dump.source !== "SWITCHOVER")
        throw new Error("only a switch-over dump is restored across tenants");
      if (dump.tenantId === i.targetTenant)
        throw new Error(
          "a switch-over restores into another tenant than the dump's",
        );
      const name = `pgfresh-${dump.id}${attemptSuffix(i.attempt)}`;
      const restoreId = `${i.targetTenant}/${name}`;
      if (await b.k8s.readJobStatus(i.targetTenant, name)) return { restoreId };
      await createJob(
        i.targetTenant,
        buildFreshRestoreJob({
          restoreId: `${dump.id}${attemptSuffix(i.attempt)}`,
          tenantNs: i.targetTenant,
          s3Key: dump.s3Key,
          jobs: i.jobs,
          reset: i.reset,
          ...b.dumpJob,
          dumpId: dump.id,
        }),
      );
      return { restoreId };
    },

    async startRestoreArchive(i) {
      const a = await archives.getById(i.archiveId);
      if (!a || a.status !== "READY" || !a.s3Key || !a.sha256)
        throw new Error("the archive is not ready");
      if (a.tenantId === i.targetTenant)
        throw new Error(
          "a switch-over restores into another tenant than the archive's",
        );
      if (!a.s3Key.startsWith("switchover/"))
        throw new Error(
          "only a switch-over archive is restored across tenants",
        );
      const name = `datarestore-${a.id}${attemptSuffix(i.attempt)}`;
      const restoreId = `${i.targetTenant}/${name}`;
      if (await b.k8s.readJobStatus(i.targetTenant, name)) return { restoreId };
      // /data is replaced under a stopped app only.
      if ((await b.k8s.countPods(i.targetTenant, APP_SELECTOR)) > 0)
        throw new SwitchoverBackupsUnavailableError(
          "the target's app is running; /data is not replaced under it",
        );
      const pvc = await b.k8s.findDataPvc(i.targetTenant);
      if (!pvc || pvc !== i.pvc)
        throw new SwitchoverBackupsUnavailableError(
          "the target's data volume is not the one named",
        );
      await createJob(
        i.targetTenant,
        buildDataRestoreJob({
          restoreId: `${a.id}${attemptSuffix(i.attempt)}`,
          archiveId: a.id,
          sha256: a.sha256,
          tenantNs: i.targetTenant,
          pvcName: pvc,
          image: b.archiveImage,
          bucket: b.dumpJob.bucket,
          s3Endpoint: b.dumpJob.s3Endpoint,
          s3AccessKey: b.dumpJob.s3AccessKey,
          s3SecretKey: b.dumpJob.s3SecretKey,
          s3Key: a.s3Key,
        }),
      );
      return { restoreId };
    },

    async restoreStatus(restoreId) {
      const { ns, name } = splitId(restoreId);
      return jobOutcome(ns, name);
    },

    async readArchiveFiles(archiveId, names) {
      const a = await archives.getById(archiveId);
      if (!a || a.status !== "READY" || !a.s3Key)
        throw new Error("the archive is not ready");
      if (!b.readObject)
        throw new SwitchoverBackupsUnavailableError(
          "reading archives is not configured",
        );
      return readFilesFromTarZst(await b.readObject(a.s3Key), names);
    },
  };
}
