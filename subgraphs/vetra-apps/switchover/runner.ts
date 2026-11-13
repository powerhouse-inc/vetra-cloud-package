import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { switchoverConfigOf } from "../config.js";
import { appInstancesLock } from "../rollouts/repo.js";
import type { AppsDeps } from "../service.js";
import { withKeyLock } from "../../../shared/key-lock.js";
import {
  nextState,
  timedOut,
  timeoutObservation,
  type Observation,
} from "./machine.js";
import {
  CLOSED_STATES,
  getSwitchover,
  listActiveSwitchovers,
  SwitchoverRaceError,
  updateSwitchover,
  type SwitchoverRow,
} from "./repo.js";
import { STEPS, type StepCtx } from "./steps.js";

/** Long hex runs (keys, fingerprints, digests of secrets) never reach a table, an audit row or a log. */
export const scrub = (text: string): string =>
  text.replace(/[0-9a-fA-F]{32,}/g, "[redacted]").replace(/\s+/g, " ");

const messageOf = (err: unknown) =>
  scrub(err instanceof Error ? err.message : String(err)).slice(0, 500);

const seconds = (fromIso: string | null, nowIso: string): number | null => {
  if (!fromIso) return null;
  const ms = Date.parse(nowIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
};

/** One step of one switch-over, by its stored state. Returns the row after. */
export async function advanceSwitchover(
  deps: AppsDeps,
  id: string,
): Promise<SwitchoverRow | null> {
  const cfg = switchoverConfigOf(deps.cfg);
  const ports = deps.switchover;
  if (!cfg.enabled || !ports) return null;
  const row = await getSwitchover(deps.db, id);
  if (!row || CLOSED_STATES.includes(row.state) || row.state === "FAILED")
    return row;
  const now = deps.now();
  const nowIso = now.toISOString();
  const ctx: StepCtx = { deps, ports, cfg, nowIso };

  let obs: Observation;
  if (timedOut(row, now.getTime())) obs = timeoutObservation(row);
  else {
    try {
      obs = await STEPS[row.state](ctx, row);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] switch-over ${row.id} (${row.state}): ${messageOf(err)}`,
      );
      obs = { kind: "fail", error: messageOf(err) };
    }
  }
  // Re-read: a step saves job ids on the row as it goes.
  const current = (await getSwitchover(deps.db, id)) ?? row;
  const move = nextState(
    current,
    obs.kind === "fail" ? { ...obs, error: scrub(obs.error) } : obs,
    nowIso,
  );
  if (!move) return current;
  const patch = { ...move.patch };
  if (obs.kind === "advance") {
    const took = seconds(current.step_started_at, nowIso);
    if (took !== null)
      patch.timings = JSON.stringify({
        ...(current.timings ? JSON.parse(current.timings) : {}),
        [current.state.toLowerCase()]: took,
      });
  }
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const next = await updateSwitchover(
        trx,
        current.id,
        { ...patch, state: move.state },
        nowIso,
        current.state,
      );
      await recordAudit(trx, {
        appId: current.app_id,
        at: nowIso,
        actor: AUDIT_SYSTEM_ACTOR,
        source: "system",
        action:
          move.state === "FAILED" ? "switchover.failed" : "switchover.state",
        subject: `switchover:${current.id}`,
        detail: {
          from: current.state,
          to: move.state,
          mode: current.mode,
          ...(move.state === "FAILED" ? { error: next.error } : {}),
        },
      });
      return next;
    });
  } catch (err) {
    if (err instanceof SwitchoverRaceError) return current;
    throw err;
  }
}

/**
 * One pass of the runner: at most one step for each open switch-over (a
 * FAILED one waits for resume or roll back). Off unless VETRA_APPS_SWITCHOVER
 * is on (with plans and instances) and the ports are configured. Steps of one
 * App run under its instances lock, the lock the reconciler takes.
 */
export async function advanceSwitchoversOnce(deps: AppsDeps): Promise<number> {
  if (!switchoverConfigOf(deps.cfg).enabled || !deps.switchover) return 0;
  let moved = 0;
  for (const row of await listActiveSwitchovers(deps.db)) {
    try {
      const after = await withKeyLock(appInstancesLock(row.app_id), () =>
        advanceSwitchover(deps, row.id),
      );
      if (after && after.state !== row.state) moved++;
    } catch (err) {
      deps.logger.warn(`[vetra-apps] switch-over ${row.id}: ${messageOf(err)}`);
    }
  }
  return moved;
}
