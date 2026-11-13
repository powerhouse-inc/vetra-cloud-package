import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import { switchoverConfigOf } from "../config.js";
import { appsError } from "../errors.js";
import { appInstancesLock } from "../rollouts/repo.js";
import type { AppsDeps } from "../service.js";
import { withKeyLock } from "../../../shared/key-lock.js";
import { checkSwitchover, gatherSwitchoverFacts } from "./checks.js";
import { rollbackMove, resumeMove } from "./machine.js";
import {
  CLOSED_STATES,
  getSwitchover,
  insertSwitchover,
  listSwitchovers,
  openSwitchoverOfEnvironment,
  updateSwitchover,
  type SwitchoverMode,
  type SwitchoverRow,
} from "./repo.js";
import { NOT_FROZEN } from "./steps.js";

/** A real window starts at least this long from now (D11: holders are told 72 h ahead). */
export const MIN_NOTICE_HOURS = 72;

function requireAdmin(caller: Caller) {
  if (!caller.isAdmin) throw appsError("FORBIDDEN", "Admins only");
}
function requireOn(deps: AppsDeps) {
  if (!switchoverConfigOf(deps.cfg).enabled)
    throw appsError("BAD_USER_INPUT", "The switch-over is off");
}

/** Why an environment cannot be switched over; real runs do not need the freeze yet (checked when the old environment is held). */
export async function switchoverReasons(
  deps: AppsDeps,
  environmentId: string,
  mode: SwitchoverMode,
): Promise<string[]> {
  return checkSwitchover(
    await gatherSwitchoverFacts(deps, environmentId, mode),
  ).filter((r) => r !== NOT_FROZEN);
}

async function create(
  deps: AppsDeps,
  caller: Caller,
  environmentId: string,
  mode: SwitchoverMode,
  window: { start: string; end: string } | null,
): Promise<SwitchoverRow> {
  requireAdmin(caller);
  requireOn(deps);
  const facts = await gatherSwitchoverFacts(deps, environmentId, mode);
  const why = checkSwitchover(facts).filter((r) => r !== NOT_FROZEN);
  if (why.length > 0 || !facts.row || !facts.plan || !facts.release)
    throw appsError(
      "BAD_USER_INPUT",
      `This environment cannot be switched over: ${why.join("; ")}`,
    );
  const old = await deps.envs.getState(environmentId);
  const tenant = deps.envTenant ? await deps.envTenant(environmentId) : null;
  if (!old?.genericSubdomain || !tenant)
    throw appsError(
      "BAD_USER_INPUT",
      "The old environment's host or namespace is not known yet",
    );
  const appId = facts.row.appId;
  return withKeyLock(appInstancesLock(appId), async () => {
    const existing = (await listSwitchovers(deps.db, appId)).filter(
      (s) => s.environment_id === environmentId,
    );
    if (mode === "real") {
      if (await openSwitchoverOfEnvironment(deps.db, environmentId))
        throw appsError(
          "BAD_USER_INPUT",
          "This environment already has a switch-over",
        );
      const w = window!;
      for (const s of (await listSwitchovers(deps.db, appId)).filter(
        (s) => s.mode === "real" && s.window_start && s.window_end,
      ))
        if (
          s.state !== "ROLLED_BACK" &&
          Date.parse(w.start) < Date.parse(s.window_end!) &&
          Date.parse(w.end) > Date.parse(s.window_start!)
        )
          throw appsError(
            "BAD_USER_INPUT",
            "The window overlaps another switch-over window of this App",
          );
    } else if (
      existing.some(
        (s) =>
          s.mode === "dry_run" &&
          s.state !== "CLEANED" &&
          !CLOSED_STATES.includes(s.state),
      )
    )
      throw appsError(
        "BAD_USER_INPUT",
        "A dry run of this environment is running, or failed and is not cleaned up",
      );
    const nowIso = deps.now().toISOString();
    const row = await deps.db.transaction().execute(async (trx) => {
      const stored = await insertSwitchover(trx, {
        id: deps.newId(),
        app_id: appId,
        environment_id: environmentId,
        old_tenant: tenant,
        old_host: old.genericSubdomain!,
        licence_root_id: facts.row!.rootLicenseId,
        holder_address: (facts.holder ?? "").toLowerCase(),
        kind: facts.kind ?? "",
        plan_id: facts.plan!.id,
        instance_id: null,
        release_version: facts.release!.version,
        release_digest: facts.release!.digest!,
        mode,
        state: "PLANNED",
        failed_state: null,
        error: null,
        window_start: window?.start ?? null,
        window_end: window?.end ?? null,
        step_started_at: nowIso,
        attempts: 0,
        prepare_archive_id: null,
        dump_id: null,
        archive_id: null,
        restore_db_id: null,
        restore_data_id: null,
        key_fingerprints: null,
        source_counts: null,
        copy_counts: null,
        started_counts: null,
        timings: null,
        downtime_started_at: null,
        started_at: null,
        confirmed_at: null,
        done_at: null,
        hold_until: null,
        rolled_back_at: null,
        created_by: caller.address,
        created_at: nowIso,
        updated_at: nowIso,
      });
      await auditCaller(trx, caller, {
        appId,
        at: nowIso,
        action: "switchover.planned",
        subject: `switchover:${stored.id}`,
        detail: {
          mode,
          kind: stored.kind,
          releaseVersion: stored.release_version,
          windowStart: stored.window_start,
          windowEnd: stored.window_end,
        },
      });
      return stored;
    });
    return row;
  });
}

/**
 * Plans a real switch-over of a licensed environment (admin). The window
 * starts at least MIN_NOTICE_HOURS from now, ends after it, and overlaps no
 * other window of the App; the checks must pass (the freeze is checked when
 * the old environment is held).
 */
export async function planSwitchover(
  deps: AppsDeps,
  caller: Caller,
  environmentId: string,
  window: { windowStart: string; windowEnd: string },
): Promise<SwitchoverRow> {
  const start = Date.parse(window.windowStart);
  const end = Date.parse(window.windowEnd);
  if (Number.isNaN(start) || Number.isNaN(end))
    throw appsError("BAD_USER_INPUT", "The window must be ISO times");
  if (end <= start)
    throw appsError("BAD_USER_INPUT", "The window must end after it starts");
  if (start < deps.now().getTime() + MIN_NOTICE_HOURS * 3_600_000)
    throw appsError(
      "BAD_USER_INPUT",
      `The window must start at least ${MIN_NOTICE_HOURS} hours from now (holders are told ahead)`,
    );
  return create(deps, caller, environmentId, "real", {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
}

/**
 * A dry run (admin): copies the environment while it keeps running into a
 * throwaway clone, restores, starts the target release on it, verifies,
 * records durations and removes the clone. The old environment is never held,
 * stopped or written.
 */
export async function dryRunSwitchover(
  deps: AppsDeps,
  caller: Caller,
  environmentId: string,
): Promise<SwitchoverRow> {
  return create(deps, caller, environmentId, "dry_run", null);
}

async function load(deps: AppsDeps, id: string): Promise<SwitchoverRow> {
  const row = await getSwitchover(deps.db, id);
  if (!row) throw appsError("NOT_FOUND", "Switch-over not found");
  return row;
}

/** A FAILED switch-over goes back to the state it failed in, one attempt later (admin). */
export async function resumeSwitchover(
  deps: AppsDeps,
  caller: Caller,
  id: string,
): Promise<SwitchoverRow> {
  requireAdmin(caller);
  requireOn(deps);
  const first = await load(deps, id);
  return withKeyLock(appInstancesLock(first.app_id), async () => {
    const row = await load(deps, id);
    const nowIso = deps.now().toISOString();
    const move = resumeMove(row, nowIso);
    if (!move)
      throw appsError("BAD_USER_INPUT", "Only a failed switch-over is resumed");
    return deps.db.transaction().execute(async (trx) => {
      const next = await updateSwitchover(
        trx,
        row.id,
        { ...move.patch, state: move.state },
        nowIso,
        "FAILED",
      );
      await auditCaller(trx, caller, {
        appId: row.app_id,
        at: nowIso,
        action: "switchover.state",
        subject: `switchover:${row.id}`,
        detail: {
          from: "FAILED",
          to: move.state,
          resumed: true,
          attempt: next.attempts,
        },
      });
      return next;
    });
  });
}

/**
 * Removes the clone of a failed dry run (admin): the failed row goes to
 * CLEANING, whose step deletes the clone's environment, instance and hold
 * (and nothing else).
 */
export async function cleanUpDryRun(
  deps: AppsDeps,
  caller: Caller,
  id: string,
): Promise<SwitchoverRow> {
  requireAdmin(caller);
  requireOn(deps);
  const first = await load(deps, id);
  if (first.mode !== "dry_run")
    throw appsError("BAD_USER_INPUT", "Only a dry run is cleaned up");
  return withKeyLock(appInstancesLock(first.app_id), async () => {
    const row = await load(deps, id);
    const now = deps.now();
    const move = rollbackMove(
      row,
      now.getTime(),
      switchoverConfigOf(deps.cfg).confirmHours,
      now.toISOString(),
    );
    if (!move)
      throw appsError(
        "BAD_USER_INPUT",
        "Only a failed dry run is cleaned up; a running one cleans up itself",
      );
    return deps.db.transaction().execute(async (trx) => {
      const next = await updateSwitchover(
        trx,
        row.id,
        { ...move.patch, state: move.state },
        now.toISOString(),
        "FAILED",
      );
      await auditCaller(trx, caller, {
        appId: row.app_id,
        at: now.toISOString(),
        action: "switchover.state",
        subject: `switchover:${row.id}`,
        detail: { from: "FAILED", to: move.state, cleanUp: true },
      });
      return next;
    });
  });
}

export { AUDIT_SYSTEM_ACTOR };
