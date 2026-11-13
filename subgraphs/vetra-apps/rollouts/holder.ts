import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { rolloutsEnabled, rolloutsHeld } from "../config.js";
import { appsError } from "../errors.js";
import { getInstance } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import {
  appInstancesLock,
  pendingStepOfInstance,
  transitionStep,
} from "./repo.js";
import { nextWindowStart, parseWindow } from "./window.js";

/** What a holder is told about a coming update (spec 7 step 3; D5: in-app only). */
export interface HolderUpdateJson {
  rolloutId: string;
  version: string;
  /**
   * When it is expected: now when asked for, else after the notice, inside
   * the plan's window. null: never due as things stand (the plan's window
   * never opens, or the step's due date does not parse: times fail closed).
   */
  dueAt: string | null;
  notes: string | null;
  paused: boolean;
  canUpdateNow: boolean;
}

export async function holderUpdateOf(
  deps: AppsDeps,
  instanceId: string,
  kind: string,
): Promise<HolderUpdateJson | null> {
  if (!rolloutsEnabled(deps.cfg)) return null;
  const waiting = await pendingStepOfInstance(deps.db, instanceId);
  if (!waiting) return null;
  const { step, rollout } = waiting;
  const plan = await deps.db
    .selectFrom("plans")
    .select("update_window")
    .where("id", "=", step.plan_id)
    .executeTakeFirst();
  const now = deps.now();
  const window = parseWindow(plan?.update_window);
  const dueMs = Date.parse(step.due_at);
  const notBefore = Number.isFinite(dueMs)
    ? new Date(Math.max(dueMs, now.getTime()))
    : null;
  const dueAt = step.requested_at
    ? now
    : !notBefore
      ? null
      : window
        ? nextWindowStart(window, notBefore)
        : notBefore;
  return {
    rolloutId: rollout.id,
    version: step.to_version,
    dueAt: dueAt ? dueAt.toISOString() : null,
    notes: rollout.notes,
    paused: rollout.status === "paused",
    canUpdateNow:
      kind === "own" &&
      rollout.status === "active" &&
      !step.requested_at &&
      !rolloutsHeld(deps.cfg),
  };
}

/** "Update now" (spec 7 step 3, 14.8): the holder's own instance is due at once (decision R4). */
export async function updateInstanceNow(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<HolderUpdateJson> {
  const inst = await getInstance(deps.db, instanceId);
  if (
    !inst ||
    inst.kind !== "own" ||
    inst.removed_at ||
    inst.holder_address !== caller.address.toLowerCase()
  )
    throw appsError("NOT_FOUND", "Instance not found");
  if (!rolloutsEnabled(deps.cfg))
    throw appsError(
      "BAD_USER_INPUT",
      "Plans and rollouts are not enabled on this Vetra",
    );
  if (rolloutsHeld(deps.cfg))
    throw appsError(
      "BAD_USER_INPUT",
      "Updates are on hold on this Vetra; try again later",
    );
  return withKeyLock(appInstancesLock(inst.app_id), async () => {
    const waiting = await pendingStepOfInstance(deps.db, inst.id);
    if (!waiting)
      throw appsError(
        "BAD_USER_INPUT",
        "No update of this instance is waiting",
      );
    if (waiting.rollout.status === "paused")
      throw appsError(
        "BAD_USER_INPUT",
        "This update is paused until the publisher resumes it",
      );
    if (!waiting.step.requested_at) {
      const nowIso = deps.now().toISOString();
      await deps.db.transaction().execute(async (trx) => {
        const done = await transitionStep(
          trx,
          waiting.step.id,
          ["pending"],
          { requested_at: nowIso },
          nowIso,
        );
        if (!done) return;
        await auditCaller(trx, caller, {
          appId: inst.app_id,
          at: nowIso,
          action: "instance.update_requested",
          subject: `instance:${inst.id}`,
          detail: {
            name: inst.name,
            version: waiting.step.to_version,
            rolloutId: waiting.rollout.id,
          },
        });
      });
    }
    const out = await holderUpdateOf(deps, inst.id, inst.kind);
    if (!out)
      throw appsError(
        "BAD_USER_INPUT",
        "No update of this instance is waiting",
      );
    return out;
  });
}
