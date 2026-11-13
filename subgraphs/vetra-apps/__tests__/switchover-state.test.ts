import { describe, expect, it } from "vitest";
import {
  canRollBack,
  nextState,
  resumeMove,
  rollbackMove,
  STEP_TIMEOUT_MS,
  SWITCHOVER_STATES,
  timedOut,
  timeoutObservation,
} from "../switchover/machine.js";
import type { SwitchoverState } from "../switchover/repo.js";
import { switchoverRow } from "./switchover-fixtures.js";

const NOW = "2026-11-20T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 3_600_000;
const row = (state: SwitchoverState, over = {}) =>
  switchoverRow({ state, ...over });
const advance = { kind: "advance" } as const;

describe("the success path", () => {
  it.each<[SwitchoverState, SwitchoverState]>([
    ["PLANNED", "PREPARING"],
    ["PREPARING", "PREPARED"],
    ["PREPARED", "HOLDING_OLD"],
    ["HOLDING_OLD", "BACKING_UP"],
    ["BACKING_UP", "RESTORING"],
    ["RESTORING", "CHECKING_COPY"],
    ["CHECKING_COPY", "STARTING"],
    ["STARTING", "VERIFYING"],
    ["VERIFYING", "LINKING"],
    ["LINKING", "AWAITING_CONFIRMATION"],
    ["AWAITING_CONFIRMATION", "DONE"],
    ["ROLLING_BACK", "ROLLED_BACK"],
  ])("real: %s -> %s", (from, to) => {
    expect(nextState(row(from), advance, NOW)?.state).toBe(to);
  });

  it.each<[SwitchoverState, SwitchoverState]>([
    ["PLANNED", "PREPARING"],
    ["PREPARING", "PREPARED"],
    ["PREPARED", "BACKING_UP"],
    ["BACKING_UP", "RESTORING"],
    ["RESTORING", "CHECKING_COPY"],
    ["CHECKING_COPY", "STARTING"],
    ["STARTING", "VERIFYING"],
    ["VERIFYING", "CLEANING"],
    ["CLEANING", "CLEANED"],
  ])("dry run: %s -> %s", (from, to) => {
    expect(nextState(row(from, { mode: "dry_run" }), advance, NOW)?.state).toBe(
      to,
    );
  });

  it("a dry run never holds, links or awaits confirmation", () => {
    const seen = new Set<SwitchoverState>();
    let s: SwitchoverState = "PLANNED";
    while (s !== "CLEANED") {
      seen.add(s);
      s = nextState(row(s, { mode: "dry_run" }), advance, NOW)!.state;
    }
    for (const never of [
      "HOLDING_OLD",
      "LINKING",
      "AWAITING_CONFIRMATION",
      "DONE",
    ] as const)
      expect(seen.has(never)).toBe(false);
  });

  it("a wait, or an advance from a state with no successor, stays", () => {
    expect(nextState(row("RESTORING"), { kind: "wait" }, NOW)).toBeNull();
    for (const s of ["DONE", "CLEANED", "ROLLED_BACK", "FAILED"] as const)
      expect(nextState(row(s), advance, NOW)).toBeNull();
  });

  it("applies the observation's patch, a fresh step clock and no attempts", () => {
    const m = nextState(
      row("BACKING_UP", { attempts: 2, error: "old", step_started_at: "x" }),
      { kind: "advance", patch: { dump_id: "d1" } },
      NOW,
    )!;
    expect(m.patch).toMatchObject({
      dump_id: "d1",
      step_started_at: NOW,
      attempts: 0,
      error: null,
    });
  });

  it("stamps started_at entering STARTING (once), done_at entering DONE, rolled_back_at entering ROLLED_BACK", () => {
    expect(
      nextState(row("CHECKING_COPY"), advance, NOW)!.patch.started_at,
    ).toBe(NOW);
    expect(
      nextState(row("CHECKING_COPY", { started_at: "earlier" }), advance, NOW)!
        .patch.started_at,
    ).toBeUndefined();
    expect(
      nextState(row("AWAITING_CONFIRMATION"), advance, NOW)!.patch.done_at,
    ).toBe(NOW);
    expect(
      nextState(row("ROLLING_BACK"), advance, NOW)!.patch.rolled_back_at,
    ).toBe(NOW);
  });
});

describe("failure, timeout and resume", () => {
  it("a failure goes to FAILED, remembering the state and the reason (cut to 500)", () => {
    const m = nextState(
      row("RESTORING"),
      { kind: "fail", error: "x".repeat(900) },
      NOW,
    )!;
    expect(m.state).toBe("FAILED");
    expect(m.patch.failed_state).toBe("RESTORING");
    expect(m.patch.error).toHaveLength(500);
  });

  it("terminal states and FAILED do not fail again", () => {
    for (const s of ["DONE", "CLEANED", "ROLLED_BACK", "FAILED"] as const)
      expect(nextState(row(s), { kind: "fail", error: "e" }, NOW)).toBeNull();
  });

  it("times out past its step limit only, naming the minutes", () => {
    const r = row("RESTORING", {
      step_started_at: new Date(NOW_MS - 121 * 60_000).toISOString(),
    });
    expect(timedOut(r, NOW_MS)).toBe(true);
    expect(timeoutObservation(r)).toEqual({
      kind: "fail",
      error: "RESTORING timed out after 120 min",
    });
    expect(
      timedOut(
        row("RESTORING", {
          step_started_at: new Date(NOW_MS - 119 * 60_000).toISOString(),
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(timedOut(row("RESTORING", { step_started_at: null }), NOW_MS)).toBe(
      false,
    );
  });

  it("states that wait on a clock or a person never time out", () => {
    for (const s of SWITCHOVER_STATES.filter(
      (x) => STEP_TIMEOUT_MS[x] === null,
    ))
      expect(
        timedOut(
          row(s, { step_started_at: "2020-01-01T00:00:00.000Z" }),
          NOW_MS,
        ),
      ).toBe(false);
    expect(STEP_TIMEOUT_MS.PREPARING).toBe(30 * 60_000);
    expect(STEP_TIMEOUT_MS.BACKING_UP).toBe(90 * 60_000);
    expect(STEP_TIMEOUT_MS.HOLDING_OLD).toBe(10 * 60_000);
  });

  it("resume returns to the failed state with one more attempt and a fresh clock", () => {
    const failed = row("FAILED", {
      failed_state: "RESTORING",
      error: "boom",
      attempts: 1,
    });
    expect(resumeMove(failed, NOW)).toEqual({
      state: "RESTORING",
      patch: {
        failed_state: null,
        error: null,
        attempts: 2,
        step_started_at: NOW,
      },
    });
    expect(resumeMove(row("RESTORING"), NOW)).toBeNull();
    expect(resumeMove(row("FAILED", { failed_state: null }), NOW)).toBeNull();
  });
});

describe("canRollBack", () => {
  const started = (h: number) => new Date(NOW_MS - h * HOUR).toISOString();
  it.each<SwitchoverState>([
    "PLANNED",
    "PREPARING",
    "PREPARED",
    "HOLDING_OLD",
    "BACKING_UP",
    "RESTORING",
    "CHECKING_COPY",
  ])("%s: allowed and lossless", (s) => {
    expect(canRollBack(row(s), NOW_MS, 72)).toEqual({
      ok: true,
      losesWrites: false,
      reason: null,
    });
  });

  it.each<SwitchoverState>(["STARTING", "VERIFYING", "LINKING"])(
    "%s: allowed, loses writes",
    (s) => {
      expect(
        canRollBack(row(s, { started_at: started(1) }), NOW_MS, 72),
      ).toEqual({
        ok: true,
        losesWrites: true,
        reason: null,
      });
    },
  );

  it("AWAITING_CONFIRMATION: loses writes until confirmHours after the start, then refused", () => {
    expect(
      canRollBack(
        row("AWAITING_CONFIRMATION", { started_at: started(71) }),
        NOW_MS,
        72,
      ),
    ).toMatchObject({
      ok: true,
      losesWrites: true,
    });
    const late = canRollBack(
      row("AWAITING_CONFIRMATION", { started_at: started(73) }),
      NOW_MS,
      72,
    );
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/72 h/);
  });

  it.each<SwitchoverState>([
    "DONE",
    "CLEANING",
    "CLEANED",
    "ROLLING_BACK",
    "ROLLED_BACK",
  ])("%s: refused", (s) => {
    expect(canRollBack(row(s), NOW_MS, 72).ok).toBe(false);
  });

  it("FAILED follows the state it failed in", () => {
    expect(
      canRollBack(row("FAILED", { failed_state: "RESTORING" }), NOW_MS, 72),
    ).toMatchObject({
      ok: true,
      losesWrites: false,
    });
    expect(
      canRollBack(
        row("FAILED", { failed_state: "VERIFYING", started_at: started(1) }),
        NOW_MS,
        72,
      ),
    ).toMatchObject({ ok: true, losesWrites: true });
    expect(
      canRollBack(row("FAILED", { failed_state: null }), NOW_MS, 72).ok,
    ).toBe(false);
  });

  it("a dry run is not rolled back, except a failed one, which is cleaned up", () => {
    expect(
      canRollBack(row("RESTORING", { mode: "dry_run" }), NOW_MS, 72).ok,
    ).toBe(false);
    expect(
      canRollBack(
        row("FAILED", { mode: "dry_run", failed_state: "RESTORING" }),
        NOW_MS,
        72,
      ).ok,
    ).toBe(true);
    expect(
      rollbackMove(
        row("FAILED", { mode: "dry_run", failed_state: "RESTORING" }),
        NOW_MS,
        72,
        NOW,
      )?.state,
    ).toBe("CLEANING");
  });

  it("rollbackMove goes to ROLLING_BACK, or nowhere when refused", () => {
    const m = rollbackMove(row("RESTORING"), NOW_MS, 72, NOW)!;
    expect(m.state).toBe("ROLLING_BACK");
    expect(m.patch).toMatchObject({
      failed_state: "RESTORING",
      step_started_at: NOW,
      attempts: 0,
    });
    expect(rollbackMove(row("DONE"), NOW_MS, 72, NOW)).toBeNull();
  });
});
