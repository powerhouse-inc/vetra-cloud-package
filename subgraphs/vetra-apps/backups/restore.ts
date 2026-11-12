import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { buildDataRestoreJob } from "../../vetra-cloud-observability/dumps/archive-job-spec.js";
import { buildRestoreJob } from "../../vetra-cloud-observability/dumps/job-spec.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import type { AuditSource, RestorePurpose } from "../db/schema.js";
import {
  getInstance,
  updateInstance,
  type InstanceRow,
} from "../instances/repo.js";
import { targetOf } from "../instances/targets.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { APP_SELECTOR, type BackupK8s } from "./k8s.js";
import {
  activeRestoresOfApp,
  getBackup,
  insertRestore,
  updateRestore,
  type InstanceBackupRow,
  type InstanceRestoreRow,
  type RestorePatch,
} from "./repo.js";
import { BackupBusyError, startInstanceBackup } from "./service.js";

export const RESTORE_STOP_TIMEOUT_MS = 10 * 60_000;
/** The restore Jobs' own deadline is 60 minutes. */
export const RESTORE_JOB_TIMEOUT_MS = 70 * 60_000;
/** Handing back: the restored release's image must reach the Deployment (gitops, Argo) and be ready. */
export const RESTORE_START_TIMEOUT_MS = 20 * 60_000;
/** How long a restore waits for a running backup of the instance before its safety backup can start. */
export const SAFETY_START_TIMEOUT_MS = 30 * 60_000;

export const activeMark = (restoreId: string) => `restore:${restoreId}`;
export const heldMark = (restoreId: string) => `held:${restoreId}`;
/** Held: a restore failed with /data possibly half restored; the instance stays stopped. */
export const isHeld = (m: string | null | undefined): boolean =>
  !!m && m.startsWith("held:");

export class RestoreBusyError extends Error {}

export interface Who {
  actor: string;
  source: AuditSource;
}
export const SYSTEM_WHO: Who = { actor: AUDIT_SYSTEM_ACTOR, source: "system" };

const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Starts restoring `backup` into the instance it was taken from (and no
 * other). The instance goes into maintenance in the same transaction, so
 * the reconciler, daily backups and rollouts leave it alone. Callers hold
 * instances:<appId>.
 */
export async function beginRestore(
  deps: AppsDeps,
  inst: InstanceRow,
  backup: InstanceBackupRow,
  o: {
    purpose: RestorePurpose;
    thenVersion: string | null;
    who: Who;
    rolloutStepId?: string | null;
  },
): Promise<InstanceRestoreRow> {
  if (backup.instance_id !== inst.id)
    throw new Error(`backup ${backup.id} is not a backup of ${inst.name}`);
  if (backup.status !== "ready")
    throw new Error(`backup ${backup.id} is ${backup.status}`);
  const now = deps.now();
  if (!(Date.parse(backup.expires_at) > now.getTime()))
    throw new Error(`backup ${backup.id} expired`);
  if (inst.maintenance && !isHeld(inst.maintenance))
    throw new RestoreBusyError(`${inst.name} is being restored`);
  const nowIso = now.toISOString();
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const row = await insertRestore(trx, {
        id: deps.newId(),
        app_id: inst.app_id,
        instance_id: inst.id,
        environment_id: backup.environment_id,
        tenant_id: backup.tenant_id,
        backup_id: backup.id,
        safety_backup_id: null,
        purpose: o.purpose,
        then_version: o.thenVersion,
        data: true,
        status: "safety_backup",
        phase_started_at: nowIso,
        db_job: null,
        data_job: null,
        replicas: null,
        target_set: false,
        was_held: isHeld(inst.maintenance),
        error: null,
        held: false,
        requested_by: o.who.actor,
        rollout_step_id: o.rolloutStepId ?? null,
        created_at: nowIso,
        updated_at: nowIso,
        finished_at: null,
      });
      await updateInstance(
        trx,
        inst.id,
        { maintenance: activeMark(row.id) },
        nowIso,
      );
      await recordAudit(trx, {
        appId: inst.app_id,
        at: nowIso,
        ...o.who,
        action: "restore.started",
        subject: `instance:${inst.id}`,
        detail: {
          restoreId: row.id,
          backupId: backup.id,
          takenAt: backup.created_at,
          backupVersion: backup.version,
          purpose: o.purpose,
          thenVersion: o.thenVersion,
        },
      });
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505")
      throw new RestoreBusyError(`${inst.name} is being restored`);
    throw err;
  }
}

/** One phase step for each active restore of the App (runs in the reconciler's pass, under its lock). */
export async function advanceRestores(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  const b = deps.backups;
  if (!b) return;
  for (const r of await activeRestoresOfApp(deps.db, app.id)) {
    try {
      await advanceRestore(deps, b.k8s, app, r);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] restore ${r.id} of ${app.slug}/${r.instance_id}: ${message(err)}`,
      );
    }
  }
}

const parseReplicas = (raw: string | null): Record<string, number> =>
  raw ? (JSON.parse(raw) as Record<string, number>) : {};

const lastLine = (text: string) =>
  text.trim().split("\n").filter(Boolean).at(-1) ?? "";

async function scaleAll(
  k8s: BackupK8s,
  ns: string,
  replicas: Record<string, number>,
  to?: number,
) {
  for (const [name, n] of Object.entries(replicas))
    await k8s.scaleDeployment(ns, name, to ?? n);
}

/** "running", or the Job's end: error null on success. */
async function jobOutcome(
  k8s: BackupK8s,
  ns: string,
  name: string,
  timedOut: boolean,
): Promise<"running" | { error: string | null }> {
  const s = await k8s.readJobStatus(ns, name);
  if (!s) return { error: `Job ${name} no longer exists` };
  const isTrue = (t: string) =>
    s.conditions?.some((c) => c.type === t && c.status === "True") ?? false;
  if (isTrue("Failed") || (s.failed ?? 0) > 0)
    return {
      error:
        lastLine(await k8s.readPodLogsForJob(ns, name)) || "the Job failed",
    };
  if (isTrue("Complete") || (s.succeeded ?? 0) > 0) return { error: null };
  if (timedOut) return { error: `Job ${name} did not finish in time` };
  return "running";
}

async function finish(
  deps: AppsDeps,
  r: InstanceRestoreRow,
  inst: InstanceRow | null,
  error: string | null,
  held: boolean,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    await updateRestore(
      trx,
      r.id,
      {
        status: error ? "failed" : "succeeded",
        error,
        held,
        finished_at: nowIso,
      },
      nowIso,
    );
    if (inst)
      await updateInstance(
        trx,
        inst.id,
        held
          ? {
              maintenance: heldMark(r.id),
              status: "failed",
              reason: `restore failed: ${error}`.slice(0, 500),
            }
          : { maintenance: null },
        nowIso,
      );
    await recordAudit(trx, {
      appId: r.app_id,
      at: nowIso,
      ...SYSTEM_WHO,
      action: "restore.finished",
      subject: `instance:${r.instance_id}`,
      detail: {
        restoreId: r.id,
        backupId: r.backup_id,
        purpose: r.purpose,
        outcome: error ? "failed" : "succeeded",
        error,
        held,
      },
    });
  });
  if (error)
    deps.logger.warn(
      `[vetra-apps] restore ${r.id} of instance ${r.instance_id} failed: ${error}${held ? " (held)" : ""}`,
    );
}

async function advanceRestore(
  deps: AppsDeps,
  k8s: BackupK8s,
  app: AppRow,
  r: InstanceRestoreRow,
): Promise<void> {
  const b = deps.backups!;
  const ns = r.tenant_id;
  const now = deps.now();
  const nowIso = now.toISOString();
  const age = now.getTime() - Date.parse(r.phase_started_at);
  // Fails closed: a phase start that does not parse is timed out.
  const over = (ms: number) => !(age <= ms);
  const move = (patch: RestorePatch) =>
    updateRestore(
      deps.db,
      r.id,
      { ...patch, phase_started_at: nowIso },
      nowIso,
    );
  const inst = await getInstance(deps.db, r.instance_id);
  if (!inst) return finish(deps, r, null, "the instance is gone", false);
  const replicas = parseReplicas(r.replicas);
  // Nothing touched yet: a held instance stays held and stopped, anything else runs again.
  const scaleBack = () =>
    scaleAll(k8s, ns, replicas, r.was_held ? 0 : undefined);
  const untouched = (error: string) => finish(deps, r, inst, error, r.was_held);

  switch (r.status) {
    case "safety_backup": {
      if (!r.safety_backup_id) {
        try {
          const s = await startInstanceBackup(deps, inst, {
            reason: "pre_restore",
            requestedBy: r.requested_by,
          });
          await updateRestore(
            deps.db,
            r.id,
            { safety_backup_id: s.id },
            nowIso,
          );
        } catch (err) {
          if (err instanceof BackupBusyError && !over(SAFETY_START_TIMEOUT_MS))
            return;
          return untouched(
            `the safety backup could not start: ${message(err)}; nothing was changed`,
          );
        }
        return;
      }
      const s = await getBackup(deps.db, r.safety_backup_id);
      if (!s || s.status === "failed")
        return untouched(
          `the safety backup failed: ${s?.error ?? "it is gone"}; nothing was changed`,
        );
      if (s.status !== "ready") return;
      const found = await k8s.readDeploymentReplicas(ns, APP_SELECTOR);
      if (Object.keys(found).length === 0)
        return untouched(
          "no app Deployment in the namespace; nothing was changed",
        );
      // A held instance is at 0 already: after a good restore it runs one replica.
      const keep = Object.fromEntries(
        Object.entries(found).map(([n, c]) => [n, Math.max(c, 1)]),
      );
      // Recorded before scaling: a crash in between can always scale back.
      await move({ status: "stopping", replicas: JSON.stringify(keep) });
      await scaleAll(k8s, ns, keep, 0);
      return;
    }

    case "stopping": {
      if ((await k8s.countPods(ns, APP_SELECTOR)) === 0) {
        const backup = await getBackup(deps.db, r.backup_id);
        if (!backup?.dump_id) {
          await move({
            status: "starting",
            error: "the backup is gone; nothing was changed",
          });
          await scaleBack();
          return;
        }
        const name = await k8s.createJob(
          ns,
          buildRestoreJob({
            restoreId: r.id,
            dumpId: backup.dump_id,
            tenantNs: ns,
            ...b.dumpJob,
          }),
        );
        await move({
          status: "restoring_db",
          db_job: name || `pgrestore-${r.id}`,
        });
        return;
      }
      if (over(RESTORE_STOP_TIMEOUT_MS)) {
        await move({
          status: "starting",
          error: "the app did not stop in time; nothing was changed",
        });
        await scaleBack();
        return;
      }
      await scaleAll(k8s, ns, replicas, 0); // idempotent; re-asserts it
      return;
    }

    case "restoring_db": {
      const out = await jobOutcome(
        k8s,
        ns,
        r.db_job!,
        over(RESTORE_JOB_TIMEOUT_MS),
      );
      if (out === "running") return;
      if (out.error) {
        // One transaction (RESTORE_SCRIPT): the database is as it was.
        await move({
          status: "starting",
          error: `database restore failed: ${out.error}; nothing was changed`,
        });
        await scaleBack();
        return;
      }
      if (!r.data) {
        await move({ status: "starting" });
        return;
      }
      const backup = await getBackup(deps.db, r.backup_id);
      const archive =
        backup?.archive_id && deps.observabilityDb
          ? await new ArchivesRepo(deps.observabilityDb).getById(
              backup.archive_id,
            )
          : null;
      if (!archive?.sha256)
        return finish(
          deps,
          r,
          inst,
          "the database is restored but the /data archive is gone",
          true,
        );
      const name = await k8s.createJob(
        ns,
        buildDataRestoreJob({
          restoreId: r.id,
          archiveId: archive.id,
          sha256: archive.sha256,
          tenantNs: ns,
          pvcName: archive.pvcName,
          image: b.archiveImage,
          bucket: b.dumpJob.bucket,
          s3Endpoint: b.dumpJob.s3Endpoint,
          s3AccessKey: b.dumpJob.s3AccessKey,
          s3SecretKey: b.dumpJob.s3SecretKey,
        }),
      );
      await move({
        status: "restoring_data",
        data_job: name || `datarestore-${r.id}`,
      });
      return;
    }

    case "restoring_data": {
      const out = await jobOutcome(
        k8s,
        ns,
        r.data_job!,
        over(RESTORE_JOB_TIMEOUT_MS),
      );
      if (out === "running") return;
      if (out.error)
        return finish(
          deps,
          r,
          inst,
          `/data restore failed: ${out.error}; the database is restored, /data may be half restored`,
          true,
        );
      await move({ status: "starting" });
      return;
    }

    case "starting": {
      if (r.error) {
        // Nothing was changed: back to what ran (a held instance stays at 0).
        if (
          !r.was_held &&
          !(await k8s.deploymentsReady(ns, replicas)) &&
          !over(RESTORE_STOP_TIMEOUT_MS)
        ) {
          await scaleBack();
          return;
        }
        return finish(deps, r, inst, r.error, r.was_held);
      }
      if (r.then_version && !r.target_set) {
        const release = await releaseByVersion(deps.db, app.id, r.then_version);
        if (!release)
          return finish(
            deps,
            r,
            inst,
            `the data is restored but the App has no release ${r.then_version}`,
            true,
          );
        const t = targetOf(release);
        await deps.db.transaction().execute(async (trx) => {
          // The restored data belongs to this release: a failed start goes
          // nowhere else (revertImage needs running_digest != target_digest),
          // never back to the image that migrated it. The reconciler applies
          // it and calls it ready only once it is healthy there ("updating"
          // until then, so a rollout never settles on the restore alone).
          await updateInstance(
            trx,
            inst.id,
            {
              ...t,
              status: "updating",
              reason: `restored the backup; starting ${t.target_version}`,
              update_started_at: nowIso,
              running_version: t.target_version,
              running_digest: t.target_digest,
              running_repository: t.target_repository,
              running_degraded: null,
              failed_digest: null,
              failed_settings: null,
              maintenance: null,
            },
            nowIso,
          );
          await updateRestore(
            trx,
            r.id,
            { target_set: true, phase_started_at: nowIso },
            nowIso,
          );
        });
        return;
      }
      if (r.target_set) {
        const images = await k8s.deploymentImages(ns, APP_SELECTOR);
        const onTarget =
          images.length > 0 &&
          images.every((i) => i.endsWith(`@${inst.target_digest}`));
        if (!onTarget) {
          if (over(RESTORE_START_TIMEOUT_MS))
            return finish(
              deps,
              r,
              inst,
              `the data is restored but ${r.then_version} did not reach the cluster in time`,
              true,
            );
          return;
        }
      }
      if (
        !(await k8s.deploymentsReady(ns, replicas)) &&
        !over(RESTORE_START_TIMEOUT_MS)
      ) {
        await scaleAll(k8s, ns, replicas);
        return;
      }
      // Ready, or the reconciler's health takes it from here.
      return finish(deps, r, inst, null, false);
    }

    default:
      return;
  }
}
