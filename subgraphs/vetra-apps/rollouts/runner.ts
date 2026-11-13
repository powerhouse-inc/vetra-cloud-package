import { GraphQLError } from "graphql";
import type { Kysely } from "kysely";
import {
  AUDIT_SYSTEM_ACTOR,
  recordAudit,
  type AuditEntry,
} from "../audit/repo.js";
import {
  BACKUP_TIMEOUT_MS,
  BackupBusyError,
  backupBeforeUpdate,
  backupProgress,
  backupsOn,
  isHeld,
  restoreBackup,
  restoreProgress,
} from "../backups/rollout.js";
import { instanceHealth, rolloutsEnabled, rolloutsHeld } from "../config.js";
import type { RolloutStepStatus, VetraAppsDB } from "../db/schema.js";
import {
  getInstance,
  updateInstance,
  type InstanceRow,
} from "../instances/repo.js";
import { UPDATE_TIMEOUT_MS } from "../instances/status.js";
import { targetOf } from "../instances/targets.js";
import { listPlans, updatePlan } from "../plans/repo.js";
import { listReleases, releaseByVersion } from "../releases/repo.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { releaseProblem } from "./check.js";
import {
  getRollout,
  getStep,
  lastFinishedStep,
  lockRollout,
  movingStep,
  openRolloutOfPlan,
  openRollouts,
  stepsOf,
  transitionStep,
  updateRollout,
  type RolloutRow,
  type RolloutStepRow,
} from "./repo.js";
import { parsePolicy, policyCandidate, type Policy } from "./policy.js";
import { beginRollout, type RolloutActor } from "./service.js";
import { inWindow, parseWindow, type UpdateWindow } from "./window.js";

/** The reconciler's update timeout plus 10 minutes (decision R10). */
export const STEP_TIMEOUT_MS = UPDATE_TIMEOUT_MS + 10 * 60_000;
export const STOPPED_NOTE = "stopped: updated when it wakes";
export const REMOVED_NOTE = "the instance was removed";
export const SYSTEM = { actor: AUDIT_SYSTEM_ACTOR, source: "system" as const };

type Who = RolloutActor | typeof SYSTEM;

/** The audit row of a step's change (subject: its rollout). */
export function stepEntry(
  step: RolloutStepRow,
  to: RolloutStepStatus,
  at: string,
  more: { note?: string | null; error?: string | null } = {},
  who: Who = SYSTEM,
): AuditEntry {
  return {
    appId: step.app_id,
    at,
    actor: who.actor,
    source: who.source,
    action: "rollout.step",
    subject: `rollout:${step.rollout_id}`,
    detail: {
      stepId: step.id,
      instance: step.instance_name,
      kind: step.instance_kind,
      from: step.status,
      to,
      fromVersion: step.from_version,
      toVersion: step.to_version,
      note: more.note ?? null,
      error: more.error ?? null,
    },
  };
}

/**
 * Sets the instance's target to the App's release `version` and clears a
 * failed target, so the reconciler applies it (or goes back to it). Pass the
 * transaction.
 */
export async function pointInstanceAt(
  db: Kysely<VetraAppsDB>,
  appId: string,
  instanceId: string,
  version: string,
  nowIso: string,
): Promise<void> {
  const r = await releaseByVersion(db, appId, version);
  if (!r) throw new Error(`the App has no release ${version}`);
  await updateInstance(
    db,
    instanceId,
    { ...targetOf(r), failed_digest: null, failed_settings: null },
    nowIso,
  );
}

const due = (iso: string, nowMs: number) => {
  const t = Date.parse(iso);
  // Fails closed: a date that does not parse is never due.
  return Number.isFinite(t) && t <= nowMs;
};

/** Ends a step (guarded), with its audit row; `also` runs in the same transaction. */
async function endStep(
  deps: AppsDeps,
  step: RolloutStepRow,
  to: RolloutStepStatus,
  more: { note?: string | null; error?: string | null } = {},
  also?: (trx: Kysely<VetraAppsDB>, nowIso: string) => Promise<void>,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const done = await transitionStep(
      trx,
      step.id,
      [step.status],
      {
        status: to,
        note: more.note ?? step.note,
        error: more.error ?? null,
        finished_at: nowIso,
      },
      nowIso,
    );
    if (!done) return;
    await also?.(trx, nowIso);
    await recordAudit(trx, stepEntry(step, to, nowIso, more));
  });
}

/**
 * Pauses the step's open rollout `r` (locked by the caller) with an alert row
 * (spec 7 step 4). Paused by the publisher already: the alert is still raised
 * and the error becomes the reason (it is what blocks the rollout now).
 */
async function pauseWithAlert(
  trx: Kysely<VetraAppsDB>,
  app: AppRow,
  step: RolloutStepRow,
  r: RolloutRow,
  error: string,
  nowIso: string,
): Promise<boolean> {
  if (r.status !== "active" && r.status !== "paused") return false;
  await updateRollout(
    trx,
    r.id,
    {
      status: "paused",
      paused_at: r.status === "paused" ? r.paused_at : nowIso,
      paused_reason: `${step.instance_name}: ${error}`.slice(0, 500),
    },
    nowIso,
  );
  await recordAudit(trx, {
    appId: app.id,
    at: nowIso,
    ...SYSTEM,
    action: "rollout.paused",
    subject: `rollout:${r.id}`,
    detail: {
      alert: true,
      version: r.version,
      instance: step.instance_name,
      reason: error,
    },
  });
  return true;
}

/**
 * A step failed: `failed` (forward) or `revert_failed` (rollback), and the
 * rollout paused with an alert row (spec 7 step 4). The instance's target is
 * set to the release it is left on: `from_version` after a forward failure,
 * `to_version` after a failed way back (the reconciler already reverted the
 * image, or the runner sends it after a timeout). A failed target is never
 * left on a customer instance: the reconciler would retry it on the next
 * settings change, outside the rollout. A forward step of a rollout that is
 * no longer open (cancelled while it moved) is skipped; nothing pauses.
 */
async function failStep(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
  to: "failed" | "revert_failed",
  error: string,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  let paused = false;
  await deps.db.transaction().execute(async (trx) => {
    const r = await lockRollout(trx, step.rollout_id);
    const closed = r.status !== "active" && r.status !== "paused";
    const status: RolloutStepStatus =
      closed && to === "failed" ? "skipped" : to;
    const back = to === "failed" ? step.from_version : step.to_version;
    const note =
      status === "skipped" ? `rollout ${r.status}; back on ${back}` : step.note;
    const done = await transitionStep(
      trx,
      step.id,
      [step.status],
      {
        status,
        error,
        note,
        finished_at: nowIso,
        ...(back && to === "failed" ? { target_moved: false } : {}),
      },
      nowIso,
    );
    if (!done) return;
    // A release that is gone cannot be pointed at: the target stays (never throws every pass).
    if (back && (await releaseByVersion(trx, app.id, back)))
      await pointInstanceAt(trx, app.id, step.instance_id, back, nowIso);
    await recordAudit(trx, stepEntry(step, status, nowIso, { error, note }));
    if (closed) return;
    paused = await pauseWithAlert(trx, app, step, r, error, nowIso);
  });
  if (paused)
    deps.logger.warn(
      `[vetra-apps] rollout ${step.rollout_id} of ${app.slug} paused: ${step.instance_name}: ${error}`,
    );
}

/** Settles the moving step from the instance row the reconciler wrote; true while it still moves. */
async function settle(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
): Promise<boolean> {
  if (step.status === "backing_up") return settleBackup(deps, app, step);
  if (step.status === "restoring") return settleRestore(deps, app, step);
  const back = step.status === "reverting";
  const want = back ? step.from_version : step.to_version;
  const done: RolloutStepStatus = back ? "rolled_back" : "succeeded";
  const gone: RolloutStepStatus = back ? "rolled_back" : "skipped";
  const inst = await getInstance(deps.db, step.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, step, gone, { note: REMOVED_NOTE });
    return false;
  }
  if (inst.stop_reason || inst.status === "stopped") {
    await endStep(deps, step, gone, {
      note: back ? `stopped: back on ${want} when it wakes` : STOPPED_NOTE,
    });
    return false;
  }
  if (inst.target_version !== want) {
    // Not back on the old release: someone moved it elsewhere.
    await endStep(deps, step, "skipped", {
      note: `moved to ${inst.target_version} meanwhile`,
    });
    return false;
  }
  if (
    inst.status === "ready" &&
    inst.running_version === want &&
    inst.running_digest === inst.target_digest
  ) {
    await endStep(deps, step, done);
    return false;
  }
  const to = back ? "revert_failed" : "failed";
  // B8: a forward failure of a release that migrates restores its backup instead.
  const fail = async (error: string) =>
    !back && (await wantsRecovery(deps, app, step))
      ? recover(deps, app, step, error)
      : failStep(deps, app, step, to, error);
  if (inst.status === "failed" && inst.failed_digest === inst.target_digest) {
    await fail(inst.reason ?? "the update failed");
    return false;
  }
  if (
    inst.status === "degraded" &&
    inst.running_digest === inst.target_digest
  ) {
    await fail(`not healthy after the update: ${inst.reason ?? "degraded"}`);
    return false;
  }
  const started = Date.parse(step.started_at ?? "");
  if (
    !Number.isFinite(started) ||
    deps.now().getTime() - started > STEP_TIMEOUT_MS
  ) {
    await fail(`not ready on ${want} after ${STEP_TIMEOUT_MS / 60_000} minutes`);
    return false;
  }
  return true;
}

/** Starts a forward step; true when an instance now moves (one per App). */
async function startStep(
  deps: AppsDeps,
  app: AppRow,
  s: RolloutStepRow,
): Promise<boolean> {
  const inst = await getInstance(deps.db, s.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, s, "skipped", { note: REMOVED_NOTE });
    return false;
  }
  if (inst.pinned_version && inst.pinned_version !== s.to_version) {
    await endStep(deps, s, "skipped", {
      note: `pinned at ${inst.pinned_version}`,
    });
    return false;
  }
  if (
    inst.target_version === s.to_version &&
    inst.status === "ready" &&
    inst.running_version === s.to_version &&
    !!inst.running_digest &&
    inst.running_digest === inst.target_digest
  ) {
    await endStep(deps, s, "succeeded", { note: `already on ${s.to_version}` });
    return false;
  }
  const release = await releaseByVersion(deps.db, app.id, s.to_version);
  const problem = releaseProblem(s.to_version, release);
  if (problem) {
    await endStep(deps, s, "skipped", { note: problem });
    return false;
  }
  try {
    targetOf(release!);
  } catch (err) {
    await endStep(deps, s, "skipped", { note: String(err).slice(0, 500) });
    return false;
  }
  const stopped = !!inst.stop_reason || inst.status === "stopped";
  if (inst.maintenance) {
    // A restore owns it: wait (one instance at a time), unless a failed restore holds it.
    if (!isHeld(inst.maintenance)) return true;
    await failStep(
      deps,
      app,
      s,
      "failed",
      "the instance is stopped after a failed restore; restore it first",
    );
    return false;
  }
  // Spec 7 step 4: a backup before each update. The target moves in settleBackup.
  if (!stopped && backupsOn(deps)) return startBackup(deps, app, inst, s);
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["pending"],
      stopped
        ? {
            status: "skipped",
            note: STOPPED_NOTE,
            target_moved: true,
            started_at: nowIso,
            finished_at: nowIso,
            attempts: s.attempts + 1,
          }
        : {
            status: "applying",
            target_moved: true,
            started_at: nowIso,
            error: null,
            attempts: s.attempts + 1,
          },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(trx, app.id, inst.id, s.to_version, nowIso);
    await recordAudit(
      trx,
      stepEntry(s, moved.status, nowIso, { note: moved.note }),
    );
  });
  return !stopped;
}

/** Starts the backup before a step moves its instance; true while the queue waits on it. */
async function startBackup(
  deps: AppsDeps,
  app: AppRow,
  inst: InstanceRow,
  s: RolloutStepRow,
): Promise<boolean> {
  let backupId: string;
  try {
    backupId = await backupBeforeUpdate(deps, inst, s.id);
  } catch (err) {
    // A daily or manual backup of it is running: this step waits its turn.
    if (err instanceof BackupBusyError) return true;
    await failStep(
      deps,
      app,
      s,
      "failed",
      `cannot back up the instance: ${message(err)}`,
    );
    return false;
  }
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["pending"],
      {
        status: "backing_up",
        backup_id: backupId,
        started_at: nowIso,
        error: null,
        attempts: s.attempts + 1,
      },
      nowIso,
    );
    if (moved)
      await recordAudit(
        trx,
        stepEntry(s, "backing_up", nowIso, {
          note: "backing up before the update",
        }),
      );
  });
  return true;
}

/** The backup is ready: the target moves (applying); failed or late: the step fails, nothing moved. */
async function settleBackup(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
): Promise<boolean> {
  const inst = await getInstance(deps.db, step.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, step, "skipped", { note: REMOVED_NOTE });
    return false;
  }
  const p = await backupProgress(deps, step.backup_id!);
  if (p.state === "pending") {
    const started = Date.parse(step.started_at ?? "");
    if (
      Number.isFinite(started) &&
      deps.now().getTime() - started <= BACKUP_TIMEOUT_MS
    )
      return true;
    await failStep(
      deps,
      app,
      step,
      "failed",
      `the backup did not finish in ${BACKUP_TIMEOUT_MS / 60_000} minutes`,
    );
    return false;
  }
  if (p.state === "failed") {
    await failStep(deps, app, step, "failed", `backup failed: ${p.error}`);
    return false;
  }
  const nowIso = deps.now().toISOString();
  const r = await getRollout(deps.db, step.rollout_id);
  if (r?.status !== "active") {
    // Paused or cancelled meanwhile (B15): nothing moved. A paused step takes a
    // fresh backup when it starts again (this one would miss what is written until then).
    const paused = r?.status === "paused";
    await deps.db.transaction().execute(async (trx) => {
      const moved = await transitionStep(
        trx,
        step.id,
        ["backing_up"],
        paused
          ? { status: "pending", backup_id: null, started_at: null }
          : {
              status: "skipped",
              note: "cancelled before its update",
              finished_at: nowIso,
            },
        nowIso,
      );
      if (moved)
        await recordAudit(
          trx,
          stepEntry(step, moved.status, nowIso, { note: moved.note }),
        );
    });
    return false;
  }
  if (inst.maintenance || inst.stop_reason || inst.status === "stopped") {
    // A restore began, or it was stopped, since the backup started: nothing moved; try again.
    await deps.db.transaction().execute(async (trx) => {
      const moved = await transitionStep(
        trx,
        step.id,
        ["backing_up"],
        { status: "pending", backup_id: null, started_at: null },
        nowIso,
      );
      if (moved)
        await recordAudit(
          trx,
          stepEntry(step, "pending", nowIso, {
            note: "the instance changed while it was backed up",
          }),
        );
    });
    return false;
  }
  await deps.db.transaction().execute(async (trx) => {
    // STEP_TIMEOUT_MS counts from here.
    const moved = await transitionStep(
      trx,
      step.id,
      ["backing_up"],
      { status: "applying", target_moved: true, started_at: nowIso },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(
      trx,
      app.id,
      step.instance_id,
      step.to_version,
      nowIso,
    );
    await recordAudit(
      trx,
      stepEntry(step, "applying", nowIso, { note: "backed up" }),
    );
  });
  return true;
}

/** B8: a failed update of a release that migrates, with a ready backup from before it. */
async function wantsRecovery(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
): Promise<boolean> {
  if (
    step.status !== "applying" ||
    !step.backup_id ||
    !step.from_version ||
    !backupsOn(deps)
  )
    return false;
  const release = await releaseByVersion(deps.db, app.id, step.to_version);
  if (!release?.migrates) return false;
  return (await backupProgress(deps, step.backup_id)).state === "ready";
}

/**
 * Restores the step's pre-update backup and sends the instance back to
 * from_version (B8); the rollout pauses now with an alert. settleRestore
 * ends the step failed once the restore is done.
 */
async function recover(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
  error: string,
): Promise<void> {
  const inst = await getInstance(deps.db, step.instance_id);
  let restoreId: string;
  try {
    restoreId = await restoreBackup(deps, inst!, step.backup_id!, {
      purpose: "failed_update",
      thenVersion: step.from_version,
      stepId: step.id,
    });
  } catch (err) {
    await failStep(
      deps,
      app,
      step,
      "failed",
      `${error}; its backup could not be restored: ${message(err)}`,
    );
    return;
  }
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      step.id,
      ["applying"],
      { status: "restoring", restore_id: restoreId, error, target_moved: false },
      nowIso,
    );
    if (!moved) return;
    await recordAudit(
      trx,
      stepEntry(step, "restoring", nowIso, {
        error,
        note: "restoring the backup from before the update",
      }),
    );
    const r = await lockRollout(trx, step.rollout_id);
    await pauseWithAlert(trx, app, step, r, error, nowIso);
  });
}

/** A restoring step: back (rollback) goes on to reverting; forward (B8) ends failed, with the outcome. */
async function settleRestore(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
): Promise<boolean> {
  const p = await restoreProgress(deps, step.restore_id!);
  if (p.state === "running") return true;
  const r = await getRollout(deps.db, step.rollout_id);
  if (r?.direction === "back") {
    if (p.state === "failed") {
      await failStep(
        deps,
        app,
        step,
        "revert_failed",
        `restore failed: ${p.error}${p.held ? " (the instance stays stopped)" : ""}`,
      );
      return false;
    }
    // Restored and set back to from_version by the restore: settle() ends it once ready there.
    const nowIso = deps.now().toISOString();
    await deps.db.transaction().execute(async (trx) => {
      const moved = await transitionStep(
        trx,
        step.id,
        ["restoring"],
        { status: "reverting", started_at: nowIso },
        nowIso,
      );
      if (moved)
        await recordAudit(
          trx,
          stepEntry(step, "reverting", nowIso, {
            note: "restored the backup from before the update",
          }),
        );
    });
    return true;
  }
  await endStep(
    deps,
    step,
    "failed",
    p.state === "succeeded"
      ? {
          note: "restored the backup from before the update",
          error: step.error,
        }
      : {
          error: `${step.error ?? "the update failed"}; restore failed: ${p.error}${p.held ? " (the instance stays stopped)" : ""}`,
        },
  );
  return false;
}

/** Starts one rollback step; true when an instance now moves. Ignores notice and windows (decision R5). */
async function startRevert(
  deps: AppsDeps,
  app: AppRow,
  s: RolloutStepRow,
): Promise<boolean> {
  const back = s.from_version;
  const inst = await getInstance(deps.db, s.instance_id);
  if (!inst || inst.removed_at || inst.status === "removed") {
    await endStep(deps, s, "rolled_back", { note: REMOVED_NOTE });
    return false;
  }
  if (!back) {
    await endStep(deps, s, "skipped", { note: "no release to go back to" });
    return false;
  }
  if (inst.pinned_version && inst.pinned_version !== back) {
    await endStep(deps, s, "skipped", {
      note: `pinned at ${inst.pinned_version}: left alone`,
    });
    return false;
  }
  if (
    inst.target_version === back &&
    inst.status === "ready" &&
    inst.running_version === back &&
    !!inst.running_digest &&
    inst.running_digest === inst.target_digest
  ) {
    await endStep(deps, s, "rolled_back");
    return false;
  }
  if (!(await releaseByVersion(deps.db, app.id, back))) {
    await failStep(
      deps,
      app,
      s,
      "revert_failed",
      `the App has no release ${back}`,
    );
    return false;
  }
  const stopped = !!inst.stop_reason || inst.status === "stopped";
  // B14: a release that migrates goes back by restoring the backup from before the update.
  let note: string | null = null;
  const forward = await releaseByVersion(deps.db, app.id, s.to_version);
  // Already restored for this step (its failed forward update did), or already back: no second restore.
  const restoredAlready =
    inst.target_version === back ||
    !!(await deps.db
      .selectFrom("instance_restores")
      .select("id")
      .where("rollout_step_id", "=", s.id)
      .executeTakeFirst());
  if (forward?.migrates && backupsOn(deps) && !restoredAlready) {
    if (stopped) {
      await endStep(deps, s, "skipped", {
        note: `stopped: its database is from ${s.to_version}; restore its backup from before the update when it wakes`,
      });
      return false;
    }
    if (inst.maintenance) {
      if (!isHeld(inst.maintenance)) return true;
      await failStep(
        deps,
        app,
        s,
        "revert_failed",
        "the instance is stopped after a failed restore; restore it first",
      );
      return false;
    }
    // Its update has not settled: wait (never restore under a moving update).
    if (inst.status === "updating") return true;
    const progress = s.backup_id
      ? await backupProgress(deps, s.backup_id)
      : null;
    if (progress && progress.state !== "ready") {
      // Never image only for a migrated instance: its database is from the new release.
      await failStep(
        deps,
        app,
        s,
        "revert_failed",
        `its backup from before the update is ${progress.state === "failed" ? `unusable (${progress.error})` : progress.state}; restore by hand`,
      );
      return false;
    }
    if (progress) {
      const restoreId = await restoreBackup(deps, inst, s.backup_id!, {
        purpose: "rollback",
        thenVersion: back,
        stepId: s.id,
      });
      const at = deps.now().toISOString();
      await deps.db.transaction().execute(async (trx) => {
        const moved = await transitionStep(
          trx,
          s.id,
          ["revert_pending"],
          {
            status: "restoring",
            restore_id: restoreId,
            target_moved: false,
            started_at: at,
            finished_at: null,
            error: null,
          },
          at,
        );
        if (moved)
          await recordAudit(
            trx,
            stepEntry(s, "restoring", at, {
              note: "restoring the backup from before the update",
            }),
          );
      });
      return true;
    }
    note =
      "no backup from before the update (it joined on the new release, or its update never ran): image only";
  }
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const moved = await transitionStep(
      trx,
      s.id,
      ["revert_pending"],
      stopped
        ? {
            status: "rolled_back",
            note: `stopped: back on ${back} when it wakes`,
            target_moved: false,
            started_at: nowIso,
            finished_at: nowIso,
          }
        : {
            status: "reverting",
            target_moved: false,
            started_at: nowIso,
            finished_at: null,
            error: null,
            ...(note ? { note } : {}),
          },
      nowIso,
    );
    if (!moved) return;
    await pointInstanceAt(trx, app.id, inst.id, back, nowIso);
    await recordAudit(
      trx,
      stepEntry(s, moved.status, nowIso, { note: moved.note }),
    );
  });
  return !stopped;
}

async function windowsOf(
  deps: AppsDeps,
  r: RolloutRow,
): Promise<Map<string, UpdateWindow | null>> {
  const rows = await deps.db
    .selectFrom("plans")
    .innerJoin("rollout_plans", "rollout_plans.plan_id", "plans.id")
    .select(["plans.id as id", "plans.update_window as window"])
    .where("rollout_plans.rollout_id", "=", r.id)
    .execute();
  return new Map(rows.map((x) => [x.id, parseWindow(x.window)]));
}

const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 400);

/**
 * Runs a step's start; an error fails the step (and pauses its rollout)
 * instead of throwing again on every pass and blocking the App's rollouts.
 * True when an instance now moves, or the step failed (nothing else starts).
 */
async function guarded(
  deps: AppsDeps,
  app: AppRow,
  s: RolloutStepRow,
  run: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await run();
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] rollout step ${s.id} of ${app.slug} could not start: ${message(err)}`,
    );
    const cur = (await getStep(deps.db, s.id)) ?? s;
    await failStep(
      deps,
      app,
      cur,
      cur.status === "revert_pending" || cur.status === "reverting"
        ? "revert_failed"
        : "failed",
      `could not start: ${message(err)}`,
    );
    return true;
  }
}

/** Starts the next due step of the App's active rollouts, oldest rollout first; at most one moves. */
async function startNext(deps: AppsDeps, app: AppRow): Promise<void> {
  const now = deps.now();
  for (const r of await openRollouts(deps.db, app.id)) {
    if (r.status !== "active") continue;
    const steps = await stepsOf(deps.db, r.id);
    if (r.direction === "back") {
      const queue = steps
        .filter((s) => s.status === "revert_pending")
        .sort((a, b) => b.position - a.position);
      for (const s of queue)
        if (await guarded(deps, app, s, () => startRevert(deps, app, s)))
          return;
      continue;
    }
    // A forward step succeeds only on health (decision R2): none starts while health is not enforced.
    if (instanceHealth(deps.cfg).mode !== "enforce") continue;
    const pending = steps.filter((s) => s.status === "pending");
    const sharedLeft = pending.some((s) => s.instance_kind === "shared");
    const windows = await windowsOf(deps, r);
    for (const s of pending) {
      // Update now / retry (decision R4): no notice, window or shared-first.
      if (s.requested_at === null) {
        if (s.instance_kind === "own" && sharedLeft) continue;
        if (!due(s.due_at, now.getTime())) continue;
        const w = windows.get(s.plan_id);
        if (w && !inWindow(w, now)) continue;
      }
      if (await guarded(deps, app, s, () => startStep(deps, app, s))) return;
    }
  }
}

const tally = (steps: RolloutStepRow[]) =>
  steps.reduce<Record<string, number>>(
    (m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }),
    {},
  );

/** Open rollouts with nothing left to do are complete (forward) or rolled back (back). */
async function finishDone(deps: AppsDeps, app: AppRow): Promise<void> {
  for (const r of await openRollouts(deps.db, app.id)) {
    const steps = await stepsOf(deps.db, r.id);
    const open: RolloutStepStatus[] =
      r.direction === "forward"
        ? ["pending", "backing_up", "applying", "restoring", "failed"]
        : ["revert_pending", "restoring", "reverting", "revert_failed"];
    if (steps.some((s) => open.includes(s.status))) continue;
    const status = r.direction === "forward" ? "complete" : "rolled_back";
    const nowIso = deps.now().toISOString();
    await deps.db.transaction().execute(async (trx) => {
      const cur = await lockRollout(trx, r.id);
      if (cur.status !== "active" && cur.status !== "paused") return;
      await updateRollout(
        trx,
        r.id,
        { status, finished_at: nowIso, paused_at: null, paused_reason: null },
        nowIso,
      );
      await recordAudit(trx, {
        appId: app.id,
        at: nowIso,
        ...SYSTEM,
        action:
          status === "complete" ? "rollout.completed" : "rollout.rolled_back",
        subject: `rollout:${r.id}`,
        detail: { version: r.version, steps: tally(steps) },
      });
    });
  }
}

const POLICY = { actor: AUDIT_SYSTEM_ACTOR, source: "policy" as const };

/**
 * Policies start rollouts by themselves (spec section 7; decision R13): one
 * plan per rollout, as Vetra, with the plan's notice. A plan in an open
 * rollout waits for it (R7). A refusal is recorded once per plan and version.
 * An unexpected error of one plan is logged and passed by: it never blocks
 * the other plans or the steps of this pass.
 */
async function runPolicies(deps: AppsDeps, app: AppRow): Promise<void> {
  const plans = (await listPlans(deps.db, app.id)).filter(
    (p) => p.status === "active" && p.policy !== "manual" && !!p.target_version,
  );
  if (plans.length === 0) return;
  const releases = await listReleases(deps.db, app.id, {
    kind: "release",
    limit: 200,
  });
  for (const plan of plans) {
    let policy: Policy;
    try {
      policy = parsePolicy(plan.policy);
    } catch {
      continue;
    }
    const want = policyCandidate(policy, plan.target_version!, releases);
    const nowIso = deps.now().toISOString();
    if (!want) {
      if (plan.policy_note)
        await updatePlan(deps.db, plan.id, { policy_note: null }, nowIso);
      continue;
    }
    if (await openRolloutOfPlan(deps.db, plan.id)) continue;
    try {
      await beginRollout(deps, app, want.version, [plan], POLICY, null);
      if (plan.policy_note)
        await updatePlan(deps.db, plan.id, { policy_note: null }, nowIso);
    } catch (err) {
      if (!(err instanceof GraphQLError)) {
        deps.logger.warn(
          `[vetra-apps] policy ${plan.policy} of ${app.slug}/${plan.slug} failed: ${String(err)}`,
        );
        continue;
      }
      const note = `${want.version}: ${err.message}`.slice(0, 500);
      if (plan.policy_note === note) continue;
      await deps.db.transaction().execute(async (trx) => {
        await updatePlan(trx, plan.id, { policy_note: note }, nowIso);
        await recordAudit(trx, {
          appId: app.id,
          at: nowIso,
          ...POLICY,
          action: "rollout.policy_refused",
          subject: `plan:${plan.id}`,
          detail: {
            slug: plan.slug,
            version: want.version,
            policy: plan.policy,
            reason: err.message,
          },
        });
      });
    }
  }
}

/**
 * Whether the instance of the step that ended last is still being updated
 * (the reconciler reverting a failure, or applying a target that moved
 * meanwhile): the next instance waits for it (one moving instance per App).
 */
async function lastStillUpdating(
  deps: AppsDeps,
  app: AppRow,
): Promise<boolean> {
  const last = await lastFinishedStep(deps.db, app.id);
  if (!last) return false;
  const inst = await getInstance(deps.db, last.instance_id);
  return !!inst && !inst.removed_at && inst.status === "updating";
}

/**
 * Whether a revert_pending step waits for its instance to settle an update
 * (a rollback while applying): that instance is the App's moving step.
 */
async function revertAwaitsUpdate(
  deps: AppsDeps,
  app: AppRow,
): Promise<boolean> {
  return !!(await deps.db
    .selectFrom("rollout_steps")
    .innerJoin("instances", "instances.id", "rollout_steps.instance_id")
    .select("rollout_steps.id")
    .where("rollout_steps.app_id", "=", app.id)
    .where("rollout_steps.status", "=", "revert_pending")
    .where("instances.status", "=", "updating")
    .where("instances.removed_at", "is", null)
    .executeTakeFirst());
}

/**
 * One pass of the App's rollouts (spec section 7). Runs inside the
 * reconciler's per-App pass, under appInstancesLock (never taken here):
 * settles the moving step from the instance row, starts the next due step
 * (one moving instance per App), and closes finished rollouts. The
 * reconciler applies a moved target in the same pass.
 */
export async function advanceRollouts(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  if (!rolloutsEnabled(deps.cfg)) return;
  if (!rolloutsHeld(deps.cfg)) await runPolicies(deps, app);
  const moving = await movingStep(deps.db, app.id);
  let stillMoving = false;
  if (moving) {
    try {
      stillMoving = await settle(deps, app, moving);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] rollout step ${moving.id} of ${app.slug} could not settle: ${message(err)}`,
      );
      await failStep(
        deps,
        app,
        moving,
        moving.status === "reverting" ? "revert_failed" : "failed",
        `could not settle: ${message(err)}`,
      );
    }
  }
  if (
    !stillMoving &&
    !rolloutsHeld(deps.cfg) &&
    !(await lastStillUpdating(deps, app)) &&
    !(await revertAwaitsUpdate(deps, app))
  )
    await startNext(deps, app);
  await finishDone(deps, app);
}
