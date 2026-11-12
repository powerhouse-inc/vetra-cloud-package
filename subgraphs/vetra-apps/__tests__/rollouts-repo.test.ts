import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./harness.js";
import {
  getRollout,
  insertRollout,
  insertRolloutPlans,
  insertSteps,
  movingStep,
  openRolloutOfPlan,
  openRollouts,
  stepsOf,
  transitionStep,
  type RolloutRow,
  type RolloutStepRow,
} from "../rollouts/repo.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const T = "2026-11-12T00:00:00.000Z";
const rollout = (over: Partial<RolloutRow> = {}): RolloutRow => ({
  id: "r1",
  app_id: "app-1",
  version: "1.1.0",
  status: "active",
  direction: "forward",
  source: "api",
  started_by: "0xaa",
  started_at: T,
  notes: null,
  paused_at: null,
  paused_reason: null,
  finished_at: null,
  rolled_back_by: null,
  rolled_back_at: null,
  updated_at: T,
  ...over,
});
const step = (over: Partial<RolloutStepRow>): RolloutStepRow => ({
  id: "s1",
  rollout_id: "r1",
  app_id: "app-1",
  plan_id: "p1",
  instance_id: "i1",
  instance_kind: "own",
  instance_name: "own-1",
  position: 0,
  from_version: "1.0.0",
  to_version: "1.1.0",
  status: "pending",
  due_at: T,
  requested_at: null,
  started_at: null,
  finished_at: null,
  target_moved: false,
  attempts: 0,
  error: null,
  note: null,
  created_at: T,
  updated_at: T,
  ...over,
});

describe("rollouts repo", () => {
  it("finds open rollouts of a plan, steps in order, the moving step, and transitions steps only from the given statuses", async () => {
    await insertRollout(h.db, rollout());
    await insertRollout(
      h.db,
      rollout({
        id: "r0",
        status: "complete",
        started_at: "2026-11-11T00:00:00.000Z",
      }),
    );
    await insertRolloutPlans(h.db, [
      {
        rollout_id: "r1",
        plan_id: "p1",
        from_version: "1.0.0",
        notice_hours: 0,
      },
      { rollout_id: "r0", plan_id: "p2", from_version: null, notice_hours: 0 },
    ]);
    await insertSteps(h.db, [
      step({ id: "s2", instance_id: "i2", position: 1 }),
      step({ id: "s1", position: 0 }),
    ]);
    expect((await openRollouts(h.db, "app-1")).map((r) => r.id)).toEqual([
      "r1",
    ]);
    expect((await openRolloutOfPlan(h.db, "p1"))?.id).toBe("r1");
    expect(await openRolloutOfPlan(h.db, "p2")).toBeNull();
    expect((await stepsOf(h.db, "r1")).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(await movingStep(h.db, "app-1")).toBeNull();
    const moved = await transitionStep(
      h.db,
      "s1",
      ["pending"],
      { status: "applying" },
      T,
    );
    expect(moved?.status).toBe("applying");
    expect(
      await transitionStep(h.db, "s1", ["pending"], { status: "skipped" }, T),
    ).toBeNull();
    expect((await movingStep(h.db, "app-1"))?.id).toBe("s1");
    expect((await getRollout(h.db, "r1"))?.direction).toBe("forward");
  });

  it("transitions nothing from no statuses (no empty IN list)", async () => {
    await insertRollout(h.db, rollout());
    await insertSteps(h.db, [step({ id: "s1", position: 0 })]);
    expect(
      await transitionStep(h.db, "s1", [], { status: "skipped" }, T),
    ).toBeNull();
    expect((await stepsOf(h.db, "r1"))[0].status).toBe("pending");
  });
});
