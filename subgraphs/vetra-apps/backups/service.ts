import type { V1Job } from "@kubernetes/client-node";
import type {
  DataArchives,
  DatabaseDumps,
} from "../../vetra-cloud-observability/db/schema.js";
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { createArchiveAndJob } from "../../vetra-cloud-observability/dumps/archive-service.js";
import { DumpsRepo } from "../../vetra-cloud-observability/dumps/repo.js";
import { createDumpAndJob } from "../../vetra-cloud-observability/dumps/service.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { backupsConfigOf } from "../config.js";
import type { BackupReason } from "../db/schema.js";
import type { InstanceRow } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { APP_SELECTOR } from "./k8s.js";
import {
  lastBackupOf,
  insertBackup,
  pendingBackupsOfApp,
  updateBackup,
  type InstanceBackupRow,
} from "./repo.js";

const DAY_MS = 86_400_000;
/** The Jobs' own deadline is 60 minutes; the watcher records them within seconds. */
export const BACKUP_TIMEOUT_MS = 75 * 60_000;
/** Days a backup is kept, per reason (B6); daily backups: VETRA_APPS_BACKUP_DAILY_KEEP_DAYS. */
export const KEEP_DAYS: Record<Exclude<BackupReason, "daily">, number> = {
  pre_update: 30,
  manual: 30,
  pre_restore: 7,
  pre_stop: 30,
};

/** A dump or archive of the instance's namespace is running: try again on a later pass. */
export class BackupBusyError extends Error {}
/** The instance cannot be backed up (no environment, namespace, /data volume, or configuration). */
export class BackupUnavailableError extends Error {}

const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Starts a backup of a shared or own instance: a pg_dump Job and a /data
 * archive Job in its namespace, recorded as one pending backup. The dump
 * goes first; when the archive cannot start, the dump is failed and its Job
 * deleted, so a backup is always both or neither.
 */
export async function startInstanceBackup(
  deps: AppsDeps,
  inst: InstanceRow,
  o: {
    reason: BackupReason;
    requestedBy: string;
    rolloutStepId?: string | null;
  },
): Promise<InstanceBackupRow> {
  const b = deps.backups;
  const obs = deps.observabilityDb;
  if (!b || !obs)
    throw new BackupUnavailableError("backups are not configured");
  if (inst.kind !== "shared" && inst.kind !== "own")
    throw new BackupUnavailableError(`a ${inst.kind} instance has no backups`);
  const envId = inst.environment_id;
  if (!envId)
    throw new BackupUnavailableError("the instance has no environment yet");
  const tenant = deps.envTenant ? await deps.envTenant(envId) : null;
  if (!tenant)
    throw new BackupUnavailableError(
      "the instance's namespace is not known yet",
    );
  const pvc = await b.k8s.findDataPvc(tenant);
  if (!pvc)
    throw new BackupUnavailableError("the instance has no /data volume");
  const dumps = new DumpsRepo(obs);
  const archives = new ArchivesRepo(obs);
  if (await archives.inFlightForTenant(tenant))
    throw new BackupBusyError("a /data archive of the instance is running");
  const now = deps.now();
  const createJob = (ns: string, job: V1Job) => b.k8s.createJob(ns, job);
  let dump: DatabaseDumps;
  try {
    dump = await createDumpAndJob(
      { repo: dumps, createJob, ...b.dumpJob },
      {
        documentId: envId,
        tenantId: tenant,
        requestedBy: o.requestedBy,
        source: o.reason === "pre_update" ? "PRE_UPDATE" : "INSTANCE",
        now,
      },
    );
  } catch (err) {
    if (message(err) === "DUMP_IN_PROGRESS")
      throw new BackupBusyError("a database dump of the instance is running");
    throw err;
  }
  let archive: DataArchives;
  try {
    archive = await createArchiveAndJob(
      { repo: archives, createJob, ...b.dumpJob, image: b.archiveImage },
      {
        documentId: envId,
        tenantId: tenant,
        requestedBy: o.requestedBy,
        pvcName: pvc,
        colocate: (await b.k8s.countPods(tenant, APP_SELECTOR)) > 0,
        now,
      },
    );
  } catch (err) {
    await dumps.markFailed(dump.id, "its /data archive could not start", now);
    await b.k8s.deleteJob(tenant, `pgdump-${dump.id}`).catch(() => {});
    if (message(err) === "ARCHIVE_IN_PROGRESS")
      throw new BackupBusyError("a /data archive of the instance is running");
    throw err;
  }
  const nowIso = now.toISOString();
  const days =
    o.reason === "daily"
      ? backupsConfigOf(deps.cfg).dailyKeepDays
      : KEEP_DAYS[o.reason];
  return insertBackup(deps.db, {
    id: deps.newId(),
    app_id: inst.app_id,
    instance_id: inst.id,
    environment_id: envId,
    tenant_id: tenant,
    reason: o.reason,
    version: inst.running_version,
    digest: inst.running_digest,
    dump_id: dump.id,
    archive_id: archive.id,
    status: "pending",
    error: null,
    size_bytes: null,
    requested_by: o.requestedBy,
    rollout_step_id: o.rolloutStepId ?? null,
    created_at: nowIso,
    updated_at: nowIso,
    finished_at: null,
    expires_at: new Date(now.getTime() + days * DAY_MS).toISOString(),
  });
}

/**
 * Settles the App's pending backups from observability's rows (its Job
 * watcher records them): ready when the dump and the archive are READY,
 * failed when either failed or vanished, or after BACKUP_TIMEOUT_MS.
 */
export async function advanceBackups(
  deps: AppsDeps,
  appId: string,
): Promise<void> {
  const obs = deps.observabilityDb;
  // Off: no query at all (behaviour as without slice 4).
  if (!obs || !deps.backups || !backupsConfigOf(deps.cfg).enabled) return;
  const dumps = new DumpsRepo(obs);
  const archives = new ArchivesRepo(obs);
  for (const b of await pendingBackupsOfApp(deps.db, appId)) {
    const dump = b.dump_id ? await dumps.getById(b.dump_id) : null;
    const archive = b.archive_id ? await archives.getById(b.archive_id) : null;
    const now = deps.now();
    const nowIso = now.toISOString();
    const age = now.getTime() - Date.parse(b.created_at);
    const failure = !dump
      ? "its database dump is gone"
      : dump.status === "FAILED"
        ? `database dump: ${dump.errorMessage ?? "failed"}`
        : !archive
          ? "its /data archive is gone"
          : archive.status === "FAILED"
            ? `/data archive: ${archive.errorMessage ?? "failed"}`
            : // Fails closed: a created_at that does not parse is timed out.
              !(age <= BACKUP_TIMEOUT_MS)
              ? `not finished after ${BACKUP_TIMEOUT_MS / 60_000} minutes`
              : null;
    if (failure) {
      await deps.db.transaction().execute(async (trx) => {
        await updateBackup(
          trx,
          b.id,
          {
            status: "failed",
            error: failure.slice(0, 500),
            finished_at: nowIso,
          },
          nowIso,
        );
        await recordAudit(trx, {
          appId,
          at: nowIso,
          actor: AUDIT_SYSTEM_ACTOR,
          source: "system",
          action: "backup.failed",
          subject: `instance:${b.instance_id}`,
          detail: { backupId: b.id, reason: b.reason, error: failure },
        });
      });
      deps.logger.warn(
        `[vetra-apps] backup ${b.id} of instance ${b.instance_id} failed: ${failure}`,
      );
      continue;
    }
    if (dump!.status === "READY" && archive!.status === "READY")
      await updateBackup(
        deps.db,
        b.id,
        {
          status: "ready",
          size_bytes:
            Number(dump!.sizeBytes ?? 0) + Number(archive!.sizeBytes ?? 0),
          finished_at: nowIso,
        },
        nowIso,
      );
  }
}

/**
 * The final backup before Vetra stops a plan instance (licence ended, plan
 * retired; decision B9). Called by the stop path (instances/reconciler.ts
 * stopPlanInstance) through preStopGate.
 *
 * Behind VETRA_APPS_BACKUPS: off (or not configured) is a no-op returning
 * null. On: starts a pre_stop backup and returns its id; throws
 * BackupBusyError (try again later) or BackupUnavailableError (no
 * environment, namespace or /data volume) as startInstanceBackup does.
 */
export async function beforePlanInstanceStop(
  deps: AppsDeps,
  instance: InstanceRow,
): Promise<string | null> {
  if (!backupsConfigOf(deps.cfg).enabled || !deps.backups) return null;
  const b = await startInstanceBackup(deps, instance, {
    reason: "pre_stop",
    requestedBy: AUDIT_SYSTEM_ACTOR,
  });
  return b.id;
}

/**
 * The stop path's question before it holds a plan instance: "wait" while its
 * final backup runs (or cannot start yet because another backup does), "go"
 * otherwise. A pre_stop backup of the last day decides: pending waits, ready
 * or failed goes (the hold keeps the database and /data anyway; the backup
 * is the extra copy, never a reason to keep running an instance whose
 * licence ended). Backups off or not possible for this instance: "go".
 */
export async function preStopGate(
  deps: AppsDeps,
  instance: InstanceRow,
): Promise<"wait" | "go"> {
  if (!backupsConfigOf(deps.cfg).enabled || !deps.backups) return "go";
  const last = await lastBackupOf(deps.db, instance.id, "pre_stop");
  if (
    last &&
    deps.now().getTime() - Date.parse(last.created_at) < DAY_MS
  )
    return last.status === "pending" ? "wait" : "go";
  try {
    await beforePlanInstanceStop(deps, instance);
    return "wait";
  } catch (err) {
    if (err instanceof BackupBusyError) return "wait";
    if (err instanceof BackupUnavailableError) return "go";
    throw err;
  }
}
