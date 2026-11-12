import type { Kysely } from "kysely";
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { recordAudit } from "../audit/repo.js";
import type { RolloutStepStatus, VetraAppsDB } from "../db/schema.js";
import { appsError } from "../errors.js";
import type { AppsDeps } from "../service.js";
import {
  appInstancesLock,
  getStep,
  lockRollout,
  OPEN_ROLLOUT,
  stepsOf,
  transitionStep,
  updateRollout,
  type RolloutRow,
} from "./repo.js";
import { pointInstanceAt, stepEntry } from "./runner.js";
import {
  auditAs,
  callerActor,
  loadRollout,
  rolloutJson,
  type RolloutActor,
  type RolloutJson,
} from "./service.js";

const BLOCKING: RolloutStepStatus[] = ["failed", "revert_failed"];

/** Runs `change` under the App's lock in one transaction, then returns the rollout as it is. */
async function underLock(
  deps: AppsDeps,
  appId: string,
  rolloutId: string,
  change: (
    trx: Kysely<VetraAppsDB>,
    cur: RolloutRow,
    nowIso: string,
  ) => Promise<void>,
): Promise<RolloutJson> {
  return withKeyLock(appInstancesLock(appId), async () => {
    const nowIso = deps.now().toISOString();
    await deps.db.transaction().execute(async (trx) => {
      await change(trx, await lockRollout(trx, rolloutId), nowIso);
    });
    return rolloutJson(
      deps.db,
      await deps.db
        .selectFrom("rollouts")
        .selectAll()
        .where("id", "=", rolloutId)
        .executeTakeFirstOrThrow(),
    );
  });
}

async function loadStepFor(deps: AppsDeps, caller: Caller, stepId: string) {
  const s = await getStep(deps.db, stepId);
  if (!s) throw appsError("NOT_FOUND", "Rollout step not found");
  const { r, app } = await loadRollout(deps, caller, s.rollout_id, "release");
  return { s, r, app };
}

/** A paused rollout whose last blocking step was retried or skipped goes on. */
async function resumeIfClear(
  trx: Kysely<VetraAppsDB>,
  cur: RolloutRow,
  who: RolloutActor,
  nowIso: string,
): Promise<void> {
  if (cur.status !== "paused") return;
  if ((await stepsOf(trx, cur.id)).some((s) => BLOCKING.includes(s.status)))
    return;
  await updateRollout(
    trx,
    cur.id,
    { status: "active", paused_at: null, paused_reason: null },
    nowIso,
  );
  await auditAs(trx, who, {
    appId: cur.app_id,
    at: nowIso,
    action: "rollout.resumed",
    subject: `rollout:${cur.id}`,
    detail: { version: cur.version },
  });
}

export async function pauseRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
  reason?: string | null,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  const why = reason?.trim().slice(0, 500) || `paused by ${caller.address}`;
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (cur.status === "paused") return;
    if (cur.status !== "active")
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    await updateRollout(
      trx,
      cur.id,
      { status: "paused", paused_at: nowIso, paused_reason: why },
      nowIso,
    );
    await auditAs(trx, callerActor(caller), {
      appId: app.id,
      at: nowIso,
      action: "rollout.paused",
      subject: `rollout:${cur.id}`,
      detail: { alert: false, version: cur.version, reason: why },
    });
  });
}

export async function resumeRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (cur.status === "active") return;
    if (cur.status !== "paused")
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    const stuck = (await stepsOf(trx, cur.id)).filter((s) =>
      BLOCKING.includes(s.status),
    );
    if (stuck.length > 0)
      throw appsError(
        "BAD_USER_INPUT",
        `Retry or skip ${stuck.map((s) => s.instance_name).join(", ")} first`,
      );
    await updateRollout(
      trx,
      cur.id,
      { status: "active", paused_at: null, paused_reason: null },
      nowIso,
    );
    await auditAs(trx, callerActor(caller), {
      appId: app.id,
      at: nowIso,
      action: "rollout.resumed",
      subject: `rollout:${cur.id}`,
      detail: { version: cur.version },
    });
  });
}

export async function cancelRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
): Promise<RolloutJson> {
  const { r, app } = await loadRollout(deps, caller, rolloutId, "release");
  const who = callerActor(caller);
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (!(OPEN_ROLLOUT as readonly string[]).includes(cur.status))
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    if (cur.direction === "back")
      throw appsError(
        "BAD_USER_INPUT",
        "A rollback is not cancelled: pause it, or retry or skip its steps",
      );
    for (const s of await stepsOf(trx, cur.id)) {
      if (s.status !== "pending" && s.status !== "failed") continue;
      // A failed step, or a retried one (pending again), targets the new release: back it goes.
      const back = s.target_moved && !!s.from_version;
      if (back)
        await pointInstanceAt(
          trx,
          app.id,
          s.instance_id,
          s.from_version!,
          nowIso,
        );
      const note = back
        ? `rollout cancelled; back on ${s.from_version}`
        : "rollout cancelled";
      await transitionStep(
        trx,
        s.id,
        [s.status],
        {
          status: "skipped",
          note,
          target_moved: back ? false : s.target_moved,
          finished_at: nowIso,
        },
        nowIso,
      );
      await recordAudit(trx, stepEntry(s, "skipped", nowIso, { note }, who));
    }
    await updateRollout(
      trx,
      cur.id,
      {
        status: "cancelled",
        finished_at: nowIso,
        paused_at: null,
        paused_reason: null,
      },
      nowIso,
    );
    await auditAs(trx, who, {
      appId: app.id,
      at: nowIso,
      action: "rollout.cancelled",
      subject: `rollout:${cur.id}`,
      detail: { version: cur.version },
    });
  });
}

export async function retryRolloutStep(
  deps: AppsDeps,
  caller: Caller,
  stepId: string,
): Promise<RolloutJson> {
  const { s, r, app } = await loadStepFor(deps, caller, stepId);
  const who = callerActor(caller);
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    if (!(OPEN_ROLLOUT as readonly string[]).includes(cur.status))
      throw appsError("BAD_USER_INPUT", `The rollout is ${cur.status}`);
    const step = (await getStep(trx, s.id))!;
    const to =
      step.status === "failed"
        ? "pending"
        : step.status === "revert_failed"
          ? "revert_pending"
          : null;
    if (!to)
      throw appsError(
        "BAD_USER_INPUT",
        `Only a failed step is retried (this one is ${step.status})`,
      );
    await transitionStep(
      trx,
      step.id,
      [step.status],
      { status: to, error: null, finished_at: null, requested_at: nowIso },
      nowIso,
    );
    await recordAudit(
      trx,
      stepEntry(step, to, nowIso, { note: "retried" }, who),
    );
    await resumeIfClear(trx, cur, who, nowIso);
  });
}

export async function skipRolloutStep(
  deps: AppsDeps,
  caller: Caller,
  stepId: string,
): Promise<RolloutJson> {
  const { s, r, app } = await loadStepFor(deps, caller, stepId);
  const who = callerActor(caller);
  return underLock(deps, app.id, r.id, async (trx, cur, nowIso) => {
    const step = (await getStep(trx, s.id))!;
    let note: string;
    let back = false;
    if (step.status === "pending" || step.status === "failed") {
      // A failed (or retried, now pending) step's instance targets the new release: back it goes.
      back = step.target_moved && !!step.from_version;
      note = back
        ? `skipped by ${caller.address}; back on ${step.from_version}`
        : `skipped by ${caller.address}`;
    } else if (
      step.status === "revert_pending" ||
      step.status === "revert_failed"
    )
      note = `left on ${step.to_version}`;
    else
      throw appsError(
        "BAD_USER_INPUT",
        `Only a pending or failed step is skipped (this one is ${step.status})`,
      );
    if (back)
      await pointInstanceAt(
        trx,
        app.id,
        step.instance_id,
        step.from_version!,
        nowIso,
      );
    await transitionStep(
      trx,
      step.id,
      [step.status],
      {
        status: "skipped",
        note,
        target_moved: back ? false : step.target_moved,
        finished_at: nowIso,
      },
      nowIso,
    );
    await recordAudit(trx, stepEntry(step, "skipped", nowIso, { note }, who));
    await resumeIfClear(trx, cur, who, nowIso);
  });
}
