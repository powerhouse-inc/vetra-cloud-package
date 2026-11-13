import { appsError } from "../errors.js";
import type { Caller } from "../auth.js";
import { auditCaller } from "../audit/service.js";
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { switchoverConfigOf } from "../config.js";
import { deleteHold, getHold } from "../holds/repo.js";
import { appPodGone, holdEnvironment, releaseHold } from "../holds/service.js";
import { deleteInstance, updateInstance } from "../instances/repo.js";
import { appInstancesLock } from "../rollouts/repo.js";
import type { AppsDeps } from "../service.js";
import { withKeyLock } from "../../../shared/key-lock.js";
import { canRollBack, rollbackMove } from "./machine.js";
import { getSwitchover, updateSwitchover, type SwitchoverRow } from "./repo.js";
import {
  advance,
  fail,
  newInstance,
  newTenant,
  wait,
  type StepCtx,
  type Step,
} from "./steps.js";

export const ROLLED_BACK_REASON = "switch-over rolled back";

/** Before the holder was touched and before anything was copied: the prepared instance holds nothing of theirs. */
const early = (row: SwitchoverRow) =>
  (row.failed_state === "PLANNED" ||
    row.failed_state === "PREPARING" ||
    row.failed_state === "PREPARED") &&
  !row.restore_db_id &&
  !row.restore_data_id &&
  !row.started_at;

/**
 * `rollBackSwitchover` (admin): to ROLLING_BACK, recording why. Refuses what
 * canRollBack refuses (DONE, closed rows, a dry run), and refuses to discard
 * writes made on the new instance (STARTING until confirmed or confirmHours
 * after the start) unless `acceptDataLoss` is true (S11).
 */
export async function rollBackSwitchover(
  deps: AppsDeps,
  caller: Caller,
  id: string,
  o: { acceptDataLoss?: boolean } = {},
): Promise<SwitchoverRow> {
  if (!caller.isAdmin) throw appsError("FORBIDDEN", "Admins only");
  const cfg = switchoverConfigOf(deps.cfg);
  if (!cfg.enabled) throw appsError("BAD_USER_INPUT", "The switch-over is off");
  const first = await getSwitchover(deps.db, id);
  if (!first) throw appsError("NOT_FOUND", "Switch-over not found");
  return withKeyLock(appInstancesLock(first.app_id), async () => {
    const row = (await getSwitchover(deps.db, id))!;
    const now = deps.now();
    const verdict = canRollBack(row, now.getTime(), cfg.confirmHours);
    if (!verdict.ok)
      throw appsError(
        "BAD_USER_INPUT",
        `This switch-over cannot be rolled back: ${verdict.reason}`,
      );
    if (verdict.losesWrites && o.acceptDataLoss !== true)
      throw appsError(
        "BAD_USER_INPUT",
        "Rolling back discards what was written on the new instance since it started; pass acceptDataLoss to confirm",
      );
    const nowIso = now.toISOString();
    const move = rollbackMove(row, now.getTime(), cfg.confirmHours, nowIso);
    if (!move)
      throw appsError(
        "BAD_USER_INPUT",
        "This switch-over cannot be rolled back",
      );
    return deps.db.transaction().execute(async (trx) => {
      const next = await updateSwitchover(
        trx,
        row.id,
        { ...move.patch, state: move.state },
        nowIso,
        row.state,
      );
      await auditCaller(trx, caller, {
        appId: row.app_id,
        at: nowIso,
        action: "switchover.rolled_back",
        subject: `switchover:${row.id}`,
        detail: {
          from: row.state === "FAILED" ? row.failed_state : row.state,
          losesWrites: verdict.losesWrites,
          acceptDataLoss: o.acceptDataLoss === true,
        },
      });
      return next;
    });
  });
}

/**
 * Every secret Vetra wrote for a deleted clone's (or prepared instance's)
 * tenant goes, the copied workflows master key and attachment secret
 * included: its database is deleted with it, so nothing needs the key. Never
 * the old environment's tenant.
 */
async function forgetCloneTenant(
  c: StepCtx,
  row: SwitchoverRow,
  tenant: string | null,
): Promise<void> {
  if (!tenant || !c.deps.instanceSecrets) return;
  if (tenant === row.old_tenant) return;
  await c.deps.instanceSecrets.purgeTenant(tenant, { includeMasterKey: true });
}

/**
 * ROLLING_BACK, one idempotent step per pass: hold the new instance (it
 * stays, data kept; only a never-used prepared one is removed); unlink the
 * licensed row; once the new app pod is gone, release the old environment's
 * hold (its own, never another's) and wait until the old app is ready. The
 * old environment's data was never written by the switch-over.
 */
export const rollingBack: Step = async (c, row) => {
  const inst = await newInstance(c, row);
  let newGone = true;
  if (inst?.environment_id) {
    const tenant = await newTenant(c, inst);
    // A prepared instance nothing was copied into goes (the document, its row and its hold).
    if (early(row)) {
      const state = await c.deps.envs.getState(inst.environment_id);
      if (
        state &&
        !state.managedBy &&
        state.app?.appId === row.app_id &&
        state.app.role === "PLAN" &&
        inst.switchover_id === row.id
      ) {
        await c.deps.envs.delete(inst.environment_id);
        await forgetCloneTenant(c, row, tenant);
      }
      await deleteHold(c.deps.db, inst.environment_id);
      await deleteInstance(c.deps.db, inst.id);
    } else {
      await holdEnvironment(c.deps, {
        environmentId: inst.environment_id,
        reason: ROLLED_BACK_REASON,
        switchoverId: row.id,
        by: AUDIT_SYSTEM_ACTOR,
      });
      newGone = tenant ? await appPodGone(c.deps, tenant) : false;
    }
  }
  if (inst && !early(row)) {
    // The chain is licensed again: sync must leave the stopped instance alone (switchover_id back), and it never restarts.
    if (
      inst.switchover_id !== row.id ||
      inst.stop_reason !== ROLLED_BACK_REASON
    )
      await updateInstance(
        c.deps.db,
        inst.id,
        {
          switchover_id: row.id,
          stop_reason: ROLLED_BACK_REASON,
          stopped_by_vetra: true,
        },
        c.nowIso,
      );
  }
  if (c.deps.licensingDb)
    await c.deps.licensingDb
      .updateTable("license_environments")
      .set({ switched_over_at: null, switched_over_instance_id: null })
      .where("environment_id", "=", row.environment_id)
      .execute();
  // Two apps never answer on the host at once.
  if (!newGone) return wait;
  const hold = await getHold(c.deps.db, row.environment_id);
  if (hold) {
    if (hold.switchover_id !== row.id)
      return fail(
        "the old environment's hold is not this switch-over's; left in place",
      );
    await releaseHold(c.deps, row.environment_id);
  }
  // Never stopped (rolled back before HOLDING_OLD): nothing to wait for.
  const wasHeld = hold !== null || !early(row);
  if (wasHeld && !(await c.ports.appPodReady(row.old_tenant))) return wait;
  const state = await c.deps.envs.getState(row.environment_id);
  if (wasHeld && state?.status !== "READY") return wait;
  return advance();
};

/**
 * CLEANING (a dry run's end): deletes the clone's environment document, its
 * hold and its instance row (spec 14.12), nothing else. Only ever what this
 * dry run created: the instance belongs to it (switchover_id), has no holder
 * and a rehearsal host, and the document is an unlicensed PLAN environment of
 * the App. The processor removes the clone's namespace (database, volume)
 * with its document. The dump and archive stay under switchover/ (180 days).
 */
export const cleaning: Step = async (c, row) => {
  if (row.mode !== "dry_run")
    return fail("only a dry run's clone is cleaned up");
  const inst = await newInstance(c, row);
  if (!inst) return advance();
  if (
    inst.switchover_id !== row.id ||
    inst.holder_address !== null ||
    !inst.host?.startsWith("rehearsal-")
  )
    return fail("the instance is not this dry run's clone; left alone");
  if (inst.environment_id) {
    const state = await c.deps.envs.getState(inst.environment_id);
    if (state) {
      if (
        state.managedBy ||
        state.app?.appId !== row.app_id ||
        state.app.role !== "PLAN"
      )
        return fail(
          "the clone's environment is not a plan environment of this App; left alone",
        );
      const tenant = await newTenant(c, inst);
      await c.deps.envs.delete(inst.environment_id);
      await forgetCloneTenant(c, row, tenant);
    }
    await deleteHold(c.deps.db, inst.environment_id);
  }
  await deleteInstance(c.deps.db, inst.id);
  return advance();
};
