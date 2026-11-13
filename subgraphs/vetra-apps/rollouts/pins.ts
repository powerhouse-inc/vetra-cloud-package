import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { recordAudit } from "../audit/repo.js";
import { appsError } from "../errors.js";
import { getInstance, updateInstance } from "../instances/repo.js";
import { instanceJson, type InstanceJson } from "../instances/service.js";
import { targetOf } from "../instances/targets.js";
import { getPlan } from "../plans/repo.js";
import { releaseByVersion } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { planFitProblem, releaseProblem } from "./check.js";
import {
  appInstancesLock,
  movingStep,
  pendingStepOfInstance,
  transitionStep,
} from "./repo.js";
import { stepEntry } from "./runner.js";
import { callerActor } from "./service.js";

async function loadOwnInstance(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
) {
  const inst = await getInstance(deps.db, instanceId);
  if (!inst || inst.removed_at)
    throw appsError("NOT_FOUND", "Instance not found");
  const app = await loadAppForOwner(deps, caller, inst.app_id, {
    need: "release",
  });
  if (inst.kind !== "own")
    throw appsError(
      "BAD_USER_INPUT",
      "Only own instances are pinned (spec section 7); a shared instance follows its plan",
    );
  return { inst, app };
}

/** Pins an own instance to a release (decision R11): rollouts skip it; another release is applied at once. */
export async function pinInstance(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
  version: string,
): Promise<InstanceJson> {
  const { inst, app } = await loadOwnInstance(deps, caller, instanceId);
  const v = version.trim();
  const release = await releaseByVersion(deps.db, app.id, v);
  const plan = inst.plan_id ? await getPlan(deps.db, inst.plan_id) : null;
  const problem =
    releaseProblem(v, release) ??
    (plan ? planFitProblem(release!, plan) : null);
  if (problem)
    throw appsError("BAD_USER_INPUT", `Cannot pin to ${v}: ${problem}`);
  const target = targetOf(release!);
  return withKeyLock(appInstancesLock(app.id), async () => {
    const nowIso = deps.now().toISOString();
    const row = await deps.db.transaction().execute(async (trx) => {
      const moving = await movingStep(trx, app.id);
      if (moving?.instance_id === inst.id)
        throw appsError(
          "BAD_USER_INPUT",
          `Its update to ${moving.to_version} is in progress; pin it once that settles`,
        );
      const cur = (await getInstance(trx, inst.id))!;
      if (cur.pinned_version === v && cur.target_version === v) return cur;
      const waiting = await pendingStepOfInstance(trx, inst.id);
      if (waiting) {
        const note = `pinned at ${v}`;
        await transitionStep(
          trx,
          waiting.step.id,
          ["pending"],
          { status: "skipped", note, finished_at: nowIso },
          nowIso,
        );
        await recordAudit(
          trx,
          stepEntry(
            waiting.step,
            "skipped",
            nowIso,
            { note },
            callerActor(caller),
          ),
        );
      }
      const moved = cur.target_version !== v;
      const updated = await updateInstance(
        trx,
        inst.id,
        {
          pinned_version: v,
          ...(moved
            ? { ...target, failed_digest: null, failed_settings: null }
            : {}),
        },
        nowIso,
      );
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "instance.pinned",
        subject: `instance:${inst.id}`,
        detail: {
          name: inst.name,
          version: v,
          previous: cur.target_version,
          moved,
        },
      });
      return updated;
    });
    return instanceJson(row);
  });
}

/** Unpins: the instance stays where it is; a rollout of its plan's target catches it up (decision R8). */
export async function unpinInstance(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<InstanceJson> {
  const { inst, app } = await loadOwnInstance(deps, caller, instanceId);
  return withKeyLock(appInstancesLock(app.id), async () => {
    const nowIso = deps.now().toISOString();
    const row = await deps.db.transaction().execute(async (trx) => {
      const cur = (await getInstance(trx, inst.id))!;
      if (!cur.pinned_version) return cur;
      const updated = await updateInstance(
        trx,
        inst.id,
        { pinned_version: null },
        nowIso,
      );
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "instance.unpinned",
        subject: `instance:${inst.id}`,
        detail: { name: inst.name, was: cur.pinned_version },
      });
      return updated;
    });
    return instanceJson(row);
  });
}
