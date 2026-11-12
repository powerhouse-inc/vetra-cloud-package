import type { Kysely } from "kysely";
import {
  AUDIT_SYSTEM_ACTOR,
  recordAudit,
  type AuditEntry,
} from "../audit/repo.js";
import { instanceHealth, rolloutsEnabled, rolloutsHeld } from "../config.js";
import type { RolloutStepStatus, VetraAppsDB } from "../db/schema.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import { UPDATE_TIMEOUT_MS } from "../instances/status.js";
import { targetOf } from "../instances/targets.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { releaseProblem } from "./check.js";
import {
  lockRollout,
  movingStep,
  openRollouts,
  stepsOf,
  transitionStep,
  updateRollout,
  type RolloutRow,
  type RolloutStepRow,
} from "./repo.js";
import type { RolloutActor } from "./service.js";
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
 * A step failed: `failed` (forward) or `revert_failed` (rollback), the
 * instance sent back to `sendBackTo` when given (a timeout; the reconciler
 * already went back after a failed update), and the rollout paused with an
 * alert row (spec 7 step 4). A forward step of a rollout that is no longer
 * open (cancelled while it moved) is not left failed: its instance goes back
 * to `from_version` and the step is skipped; nothing pauses.
 */
async function failStep(
  deps: AppsDeps,
  app: AppRow,
  step: RolloutStepRow,
  to: "failed" | "revert_failed",
  error: string,
  sendBackTo: string | null,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  let paused = false;
  await deps.db.transaction().execute(async (trx) => {
    const r = await lockRollout(trx, step.rollout_id);
    const closed = r.status !== "active" && r.status !== "paused";
    const status: RolloutStepStatus =
      closed && to === "failed" ? "skipped" : to;
    const back =
      sendBackTo ?? (status === "skipped" ? step.from_version : null);
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
        ...(back ? { target_moved: false } : {}),
      },
      nowIso,
    );
    if (!done) return;
    if (back)
      await pointInstanceAt(trx, app.id, step.instance_id, back, nowIso);
    await recordAudit(trx, stepEntry(step, status, nowIso, { error, note }));
    if (r.status !== "active") return;
    await updateRollout(
      trx,
      r.id,
      {
        status: "paused",
        paused_at: nowIso,
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
    paused = true;
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
    await endStep(deps, step, gone, {
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
  if (inst.status === "failed" && inst.failed_digest === inst.target_digest) {
    await failStep(
      deps,
      app,
      step,
      to,
      inst.reason ?? "the update failed",
      null,
    );
    return false;
  }
  if (
    inst.status === "degraded" &&
    inst.running_digest === inst.target_digest
  ) {
    await failStep(
      deps,
      app,
      step,
      to,
      `not healthy after the update: ${inst.reason ?? "degraded"}`,
      null,
    );
    return false;
  }
  const started = Date.parse(step.started_at ?? "");
  if (
    !Number.isFinite(started) ||
    deps.now().getTime() - started > STEP_TIMEOUT_MS
  ) {
    await failStep(
      deps,
      app,
      step,
      to,
      `not ready on ${want} after ${STEP_TIMEOUT_MS / 60_000} minutes`,
      back ? null : step.from_version,
    );
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
    inst.running_version === s.to_version
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

/** Starts a rollback step (Task 11 fills this in). */
async function startRevert(
  _deps: AppsDeps,
  _app: AppRow,
  _s: RolloutStepRow,
): Promise<boolean> {
  return false;
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
      for (const s of queue) if (await startRevert(deps, app, s)) return;
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
      if (await startStep(deps, app, s)) return;
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
        ? ["pending", "applying", "failed"]
        : ["revert_pending", "reverting", "revert_failed"];
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
  const moving = await movingStep(deps.db, app.id);
  const stillMoving = moving ? await settle(deps, app, moving) : false;
  if (!stillMoving && !rolloutsHeld(deps.cfg)) await startNext(deps, app);
  await finishDone(deps, app);
}
