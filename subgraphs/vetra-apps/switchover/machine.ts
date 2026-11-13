import type { SwitchoverRow, SwitchoverState } from "./repo.js";

export const SWITCHOVER_STATES: readonly SwitchoverState[] = [
  "PLANNED",
  "PREPARING",
  "PREPARED",
  "HOLDING_OLD",
  "BACKING_UP",
  "RESTORING",
  "CHECKING_COPY",
  "STARTING",
  "VERIFYING",
  "LINKING",
  "AWAITING_CONFIRMATION",
  "DONE",
  "CLEANING",
  "CLEANED",
  "FAILED",
  "ROLLING_BACK",
  "ROLLED_BACK",
];

const MIN = 60_000;

/** How long a step may run before it counts as failed; null: the state waits on a clock or a person, not a step. */
export const STEP_TIMEOUT_MS: Record<SwitchoverState, number | null> = {
  PLANNED: null,
  PREPARING: 30 * MIN,
  PREPARED: null,
  HOLDING_OLD: 10 * MIN,
  BACKING_UP: 90 * MIN,
  RESTORING: 120 * MIN,
  CHECKING_COPY: 15 * MIN,
  STARTING: null,
  VERIFYING: 30 * MIN,
  LINKING: null,
  AWAITING_CONFIRMATION: null,
  DONE: null,
  CLEANING: 15 * MIN,
  CLEANED: null,
  FAILED: null,
  ROLLING_BACK: 15 * MIN,
  ROLLED_BACK: null,
};

/** The success path of a real switch-over. */
const REAL_NEXT: Partial<Record<SwitchoverState, SwitchoverState>> = {
  PLANNED: "PREPARING",
  PREPARING: "PREPARED",
  PREPARED: "HOLDING_OLD",
  HOLDING_OLD: "BACKING_UP",
  BACKING_UP: "RESTORING",
  RESTORING: "CHECKING_COPY",
  CHECKING_COPY: "STARTING",
  STARTING: "VERIFYING",
  VERIFYING: "LINKING",
  LINKING: "AWAITING_CONFIRMATION",
  AWAITING_CONFIRMATION: "DONE",
  ROLLING_BACK: "ROLLED_BACK",
};

/** The success path of a dry run: the old environment keeps running, nothing is held or linked. */
const DRY_NEXT: Partial<Record<SwitchoverState, SwitchoverState>> = {
  PLANNED: "PREPARING",
  PREPARING: "PREPARED",
  PREPARED: "BACKING_UP",
  BACKING_UP: "RESTORING",
  RESTORING: "CHECKING_COPY",
  CHECKING_COPY: "STARTING",
  STARTING: "VERIFYING",
  VERIFYING: "CLEANING",
  CLEANING: "CLEANED",
  ROLLING_BACK: "ROLLED_BACK",
};

export type Observation =
  /** Nothing to do yet. */
  | { kind: "wait" }
  | { kind: "advance"; patch?: Partial<SwitchoverRow> }
  | { kind: "fail"; error: string };

type Move = { state: SwitchoverState; patch: Partial<SwitchoverRow> };

/**
 * What one observation of the row's state moves it to: null when it stays.
 * `advance` goes to the successor of the row's mode (applying the
 * observation's patch, then the machine's own: a fresh step clock, no
 * attempts, `started_at` on entering STARTING, `done_at` on DONE, `rolled_back_at`
 * on ROLLED_BACK); `fail` goes to FAILED, remembering where and why. Terminal
 * and FAILED states move only through resumeMove / rollbackMove.
 */
export function nextState(
  row: SwitchoverRow,
  obs: Observation,
  nowIso: string,
): Move | null {
  if (obs.kind === "wait") return null;
  if (obs.kind === "fail") {
    if (!(row.state in REAL_NEXT) && !(row.state in DRY_NEXT)) return null;
    return {
      state: "FAILED",
      patch: {
        failed_state: row.state,
        error: obs.error.slice(0, 500),
        step_started_at: nowIso,
      },
    };
  }
  const next = (row.mode === "dry_run" ? DRY_NEXT : REAL_NEXT)[row.state];
  if (!next) return null;
  const patch: Partial<SwitchoverRow> = {
    ...(obs.patch ?? {}),
    step_started_at: nowIso,
    attempts: 0,
    error: null,
  };
  if (next === "STARTING" && !row.started_at && !patch.started_at)
    patch.started_at = nowIso;
  if (next === "DONE") patch.done_at = patch.done_at ?? nowIso;
  if (next === "ROLLED_BACK") patch.rolled_back_at = nowIso;
  return { state: next, patch };
}

/** Whether the step the row is in has run past its time. */
export function timedOut(row: SwitchoverRow, nowMs: number): boolean {
  const limit = STEP_TIMEOUT_MS[row.state];
  if (limit === null || !row.step_started_at) return false;
  const started = Date.parse(row.step_started_at);
  return !Number.isNaN(started) && nowMs - started > limit;
}

/** The observation of a step that timed out. */
export function timeoutObservation(row: SwitchoverRow): Observation {
  const minutes = Math.round((STEP_TIMEOUT_MS[row.state] ?? 0) / MIN);
  return { kind: "fail", error: `${row.state} timed out after ${minutes} min` };
}

/** `resumeSwitchover`: a FAILED row goes back to the state it failed in, one attempt later. */
export function resumeMove(row: SwitchoverRow, nowIso: string): Move | null {
  if (row.state !== "FAILED" || !row.failed_state) return null;
  return {
    state: row.failed_state,
    patch: {
      failed_state: null,
      error: null,
      attempts: row.attempts + 1,
      step_started_at: nowIso,
    },
  };
}

const BEFORE_HOLDER_IS_AFFECTED = new Set<SwitchoverState>([
  "PLANNED",
  "PREPARING",
  "PREPARED",
]);
/** The old database is never written by the switch-over until STARTING. */
const LOSSLESS = new Set<SwitchoverState>([
  ...BEFORE_HOLDER_IS_AFFECTED,
  "HOLDING_OLD",
  "BACKING_UP",
  "RESTORING",
  "CHECKING_COPY",
]);
/** The new instance runs (or may run): writes made on it are lost on a roll back (S11). */
const LOSES_WRITES = new Set<SwitchoverState>([
  "STARTING",
  "VERIFYING",
  "LINKING",
  "AWAITING_CONFIRMATION",
]);

/**
 * Whether `rollBackSwitchover` may run now, and whether it discards what was
 * written on the new instance (S11): lossless before STARTING; from STARTING
 * until the holder confirms or `confirmHours` after the start; refused in
 * DONE, CLEANING, CLEANED, ROLLING_BACK and ROLLED_BACK. A FAILED row follows
 * the state it failed in. A dry run is only ever cleaned up: its FAILED row
 * may be "rolled back" into CLEANING.
 */
export function canRollBack(
  row: SwitchoverRow,
  nowMs: number,
  confirmHours: number,
): { ok: boolean; losesWrites: boolean; reason: string | null } {
  const refuse = (reason: string) => ({
    ok: false,
    losesWrites: false,
    reason,
  });
  const state = row.state === "FAILED" ? row.failed_state : row.state;
  if (row.state === "FAILED" && !state)
    return refuse("the failed step is unknown");
  if (row.mode === "dry_run")
    return row.state === "FAILED"
      ? { ok: true, losesWrites: false, reason: null }
      : refuse("a dry run is cleaned up, not rolled back");
  if (state === "DONE") return refuse("the switch-over is done");
  if (state === "ROLLING_BACK" || state === "ROLLED_BACK")
    return refuse("the switch-over is already rolled back");
  if (state === "CLEANING" || state === "CLEANED")
    return refuse("a dry run is cleaned up, not rolled back");
  if (state && LOSSLESS.has(state))
    return { ok: true, losesWrites: false, reason: null };
  if (state && LOSES_WRITES.has(state)) {
    const started = Date.parse(row.started_at ?? "");
    if (
      state === "AWAITING_CONFIRMATION" &&
      !Number.isNaN(started) &&
      nowMs - started > confirmHours * 60 * MIN
    )
      return refuse(
        `the ${confirmHours} h rollback window after the start is over`,
      );
    return { ok: true, losesWrites: true, reason: null };
  }
  return refuse(`a switch-over in ${row.state} cannot be rolled back`);
}

/** `rollBackSwitchover`: to ROLLING_BACK (a dry run: to CLEANING); null when canRollBack refuses. */
export function rollbackMove(
  row: SwitchoverRow,
  nowMs: number,
  confirmHours: number,
  nowIso: string,
): Move | null {
  if (!canRollBack(row, nowMs, confirmHours).ok) return null;
  return {
    state: row.mode === "dry_run" ? "CLEANING" : "ROLLING_BACK",
    patch: {
      failed_state: row.state === "FAILED" ? row.failed_state : row.state,
      step_started_at: nowIso,
      attempts: 0,
    },
  };
}
