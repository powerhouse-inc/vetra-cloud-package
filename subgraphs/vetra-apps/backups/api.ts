import { withKeyLock } from "../../../shared/key-lock.js";
import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import { backupsConfigOf } from "../config.js";
import { appsError, notConfigured } from "../errors.js";
import { getInstance, type InstanceRow } from "../instances/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  getBackup,
  listBackupsOfInstance,
  listRestoresOfInstance,
  type InstanceBackupRow,
  type InstanceRestoreRow,
} from "./repo.js";
import { beginRestore, isHeld, RestoreBusyError } from "./restore.js";
import {
  BackupBusyError,
  BackupUnavailableError,
  startInstanceBackup,
} from "./service.js";

const DAY_MS = 86_400_000;

export interface InstanceBackupJson {
  id: string;
  instanceId: string;
  reason: string;
  status: string;
  version: string | null;
  sizeBytes: number | null;
  error: string | null;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
  rolloutStepId: string | null;
}

export interface InstanceRestoreJson {
  id: string;
  instanceId: string;
  backupId: string;
  purpose: string;
  status: string;
  thenVersion: string | null;
  error: string | null;
  held: boolean;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

/** Metadata only (spec 14.5): no dump or archive ids, keys or URLs. */
export const backupJson = (b: InstanceBackupRow): InstanceBackupJson => ({
  id: b.id,
  instanceId: b.instance_id,
  reason: b.reason,
  status: b.status,
  version: b.version,
  sizeBytes: b.size_bytes,
  error: b.error,
  requestedBy: b.requested_by,
  createdAt: b.created_at,
  finishedAt: b.finished_at,
  expiresAt: b.expires_at,
  rolloutStepId: b.rollout_step_id,
});

export const restoreJson = (r: InstanceRestoreRow): InstanceRestoreJson => ({
  id: r.id,
  instanceId: r.instance_id,
  backupId: r.backup_id,
  purpose: r.purpose,
  status: r.status,
  thenVersion: r.then_version,
  error: r.error,
  held: r.held,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

async function loadPlanInstance(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  need: "view" | "release",
) {
  const inst = await getInstance(deps.db, instanceId);
  if (!inst || inst.removed_at || inst.status === "removed")
    throw appsError("NOT_FOUND", "No such instance");
  const app = await loadAppForOwner(deps, caller, inst.app_id, { need });
  if (inst.kind !== "shared" && inst.kind !== "own")
    throw appsError(
      "BAD_USER_INPUT",
      "Only shared and own instances have backups",
    );
  return { inst, app };
}

function requireBackups(deps: AppsDeps): void {
  if (!backupsConfigOf(deps.cfg).enabled || !deps.backups)
    throw notConfigured("Instance backups");
}

/**
 * TODO(releases phase 3 slice 3, Task 13): whether a rollout step moves the
 * instance (rollout_steps with a MOVING status), so a manual restore never
 * races a step. Slice 3 is not merged yet: no rollout table exists, so
 * nothing moves an instance but the reconciler. Once it lands:
 *
 *   const row = await deps.db
 *     .selectFrom("rollout_steps")
 *     .select("id")
 *     .where("instance_id", "=", inst.id)
 *     .where("status", "in", [...MOVING])
 *     .executeTakeFirst();
 *   return !!row;
 */
async function stepMoves(
  _deps: AppsDeps,
  _inst: InstanceRow,
): Promise<boolean> {
  return false;
}

export async function instanceBackupsFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  limit = 50,
): Promise<InstanceBackupJson[]> {
  const { inst } = await loadPlanInstance(deps, caller, instanceId, "view");
  return (
    await listBackupsOfInstance(
      deps.db,
      inst.id,
      Math.min(Math.max(limit, 1), 200),
    )
  ).map(backupJson);
}

export async function instanceRestoresFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<InstanceRestoreJson[]> {
  const { inst } = await loadPlanInstance(deps, caller, instanceId, "view");
  return (await listRestoresOfInstance(deps.db, inst.id, 20)).map(restoreJson);
}

/** "Back up now" (reason manual, kept 30 days). */
export async function backUpInstanceFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<InstanceBackupJson> {
  const { inst, app } = await loadPlanInstance(
    deps,
    caller,
    instanceId,
    "release",
  );
  requireBackups(deps);
  return withKeyLock(`instances:${app.id}`, async () => {
    const cur = (await getInstance(deps.db, inst.id))!;
    if (cur.maintenance)
      throw appsError("BAD_USER_INPUT", `${cur.name} is being restored`);
    try {
      const b = await startInstanceBackup(deps, cur, {
        reason: "manual",
        requestedBy: caller.address,
      });
      await auditCaller(deps.db, caller, {
        appId: app.id,
        at: b.created_at,
        action: "backup.requested",
        subject: `instance:${cur.id}`,
        detail: { backupId: b.id, reason: "manual" },
      });
      return backupJson(b);
    } catch (err) {
      if (err instanceof BackupBusyError)
        throw appsError(
          "BAD_USER_INPUT",
          `A backup of ${cur.name} is already running; try again when it is done`,
        );
      if (err instanceof BackupUnavailableError)
        throw appsError(
          "BAD_USER_INPUT",
          `${cur.name} cannot be backed up: ${err.message}`,
        );
      throw err;
    }
  });
}

/** Restores one of the instance's backups into it (decision B10). */
export async function restoreInstanceBackupFor(
  deps: AppsDeps,
  caller: Caller,
  input: { instanceId: string; backupId: string; acceptDataLoss: boolean },
): Promise<InstanceRestoreJson> {
  const { inst, app } = await loadPlanInstance(
    deps,
    caller,
    input.instanceId,
    "release",
  );
  requireBackups(deps);
  if (input.acceptDataLoss !== true)
    throw appsError(
      "BAD_USER_INPUT",
      "Restoring replaces the instance's database and /data with the backup: everything written since it was taken is lost. Confirm with acceptDataLoss: true",
    );
  return withKeyLock(`instances:${app.id}`, async () => {
    const cur = (await getInstance(deps.db, inst.id))!;
    const backup = await getBackup(deps.db, input.backupId);
    if (!backup || backup.instance_id !== cur.id)
      throw appsError("NOT_FOUND", "No such backup of this instance");
    if (backup.status !== "ready")
      throw appsError("BAD_USER_INPUT", `The backup is ${backup.status}`);
    if (!(Date.parse(backup.expires_at) - deps.now().getTime() > DAY_MS))
      throw appsError(
        "BAD_USER_INPUT",
        "The backup expires within a day; back up now and restore that one",
      );
    if (cur.maintenance && !isHeld(cur.maintenance))
      throw appsError("BAD_USER_INPUT", `${cur.name} is being restored`);
    // A restore hands the instance back running: never start one Vetra stopped.
    if (cur.stop_reason)
      throw appsError(
        "BAD_USER_INPUT",
        `${cur.name} is stopped (${cur.stop_reason}); it can be restored once it runs again`,
      );
    const held = isHeld(cur.maintenance);
    if (
      !held &&
      cur.status === "updating" &&
      cur.running_version !== backup.version
    )
      throw appsError(
        "BAD_USER_INPUT",
        `${cur.name} is updating from ${cur.running_version ?? "an unknown release"}; wait for it to settle`,
      );
    if (!held && backup.version !== cur.target_version)
      throw appsError(
        "BAD_USER_INPUT",
        `The backup was taken on ${backup.version ?? "an unknown release"} and ${cur.name} runs ${cur.target_version}: roll back to ${backup.version} first`,
      );
    if (await stepMoves(deps, cur))
      throw appsError(
        "BAD_USER_INPUT",
        `A rollout is updating ${cur.name}; wait for its step`,
      );
    try {
      const r = await beginRestore(deps, cur, backup, {
        purpose: "manual",
        // A held instance takes the backup's release (its data is from it).
        thenVersion: held ? backup.version : null,
        who: { actor: caller.address, source: caller.source ?? "api" },
      });
      return restoreJson(r);
    } catch (err) {
      if (err instanceof RestoreBusyError)
        throw appsError("BAD_USER_INPUT", err.message);
      throw err;
    }
  });
}
