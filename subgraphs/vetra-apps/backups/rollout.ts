/**
 * What rollouts (releases phase 3 slice 3) call: the whole contract between
 * the rollout runner and instance backups. Nothing here reads a rollout
 * table; the runner keeps the ids on its steps.
 */
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { backupsConfigOf } from "../config.js";
import type { InstanceRestoreStatus } from "../db/schema.js";
import type { InstanceRow } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import { getBackup, getRestore } from "./repo.js";
import { beginRestore, SYSTEM_WHO } from "./restore.js";
import { startInstanceBackup } from "./service.js";

export {
  BACKUP_TIMEOUT_MS,
  BackupBusyError,
  BackupUnavailableError,
} from "./service.js";
export { isHeld, RestoreBusyError } from "./restore.js";

export type BackupProgress =
  | { state: "pending" }
  | { state: "ready"; takenAt: string; version: string | null }
  | { state: "failed"; error: string };

export type RestoreProgress =
  | { state: "running"; phase: InstanceRestoreStatus }
  | { state: "succeeded" }
  | { state: "failed"; error: string; held: boolean };

/** VETRA_APPS_BACKUPS=on and wired; false: rollouts behave as without slice 4. */
export const backupsOn = (deps: AppsDeps): boolean =>
  backupsConfigOf(deps.cfg).enabled && !!deps.backups;

/**
 * Starts the backup before a rollout step moves `instance`. Throws
 * BackupBusyError (try on a later pass) or BackupUnavailableError (fail the step).
 */
export async function backupBeforeUpdate(
  deps: AppsDeps,
  instance: InstanceRow,
  stepId: string,
): Promise<string> {
  const b = await startInstanceBackup(deps, instance, {
    reason: "pre_update",
    requestedBy: AUDIT_SYSTEM_ACTOR,
    rolloutStepId: stepId,
  });
  return b.id;
}

/** Advanced by advanceBackups, which runs in the same per-App pass before advanceRollouts. */
export async function backupProgress(
  deps: AppsDeps,
  backupId: string,
): Promise<BackupProgress> {
  const b = await getBackup(deps.db, backupId);
  if (!b) return { state: "failed", error: "the backup is gone" };
  if (b.status === "pending") return { state: "pending" };
  if (b.status === "failed")
    return { state: "failed", error: b.error ?? "the backup failed" };
  if (b.status !== "ready")
    return { state: "failed", error: `the backup is ${b.status}` };
  if (!(Date.parse(b.expires_at) > deps.now().getTime()))
    return { state: "failed", error: "the backup expired" };
  return { state: "ready", takenAt: b.created_at, version: b.version };
}

/**
 * Restores `backupId` into `instance` (its own backup only), then sets the
 * instance's target and running release to `thenVersion` (null: unchanged)
 * and hands it back to the reconciler. Callers hold instances:<appId>.
 */
export async function restoreBackup(
  deps: AppsDeps,
  instance: InstanceRow,
  backupId: string,
  o: {
    purpose: "rollback" | "failed_update";
    thenVersion: string | null;
    stepId: string;
  },
): Promise<string> {
  const backup = await getBackup(deps.db, backupId);
  if (!backup) throw new Error(`backup ${backupId} is gone`);
  const r = await beginRestore(deps, instance, backup, {
    purpose: o.purpose,
    thenVersion: o.thenVersion,
    who: SYSTEM_WHO,
    rolloutStepId: o.stepId,
  });
  return r.id;
}

/** Advanced by advanceRestores, in the same per-App pass before advanceRollouts. */
export async function restoreProgress(
  deps: AppsDeps,
  restoreId: string,
): Promise<RestoreProgress> {
  const r = await getRestore(deps.db, restoreId);
  if (!r) return { state: "failed", error: "the restore is gone", held: false };
  if (r.status === "succeeded") return { state: "succeeded" };
  if (r.status === "failed")
    return {
      state: "failed",
      error: r.error ?? "the restore failed",
      held: r.held,
    };
  return { state: "running", phase: r.status };
}
