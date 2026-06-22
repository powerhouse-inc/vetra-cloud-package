import { describe, it, expect } from "vitest";
import { computePoolPlan, type PoolRow } from "./reconcile.js";

const row = (o: Partial<PoolRow>): PoolRow => ({
  id: "x",
  poolState: "AVAILABLE",
  pinnedVersion: "0.0.1-dev.19",
  status: "READY",
  ...o,
});

describe("computePoolPlan", () => {
  const target = { size: 5, version: "0.0.1-dev.19" };

  it("creates the full pool when empty", () => {
    expect(computePoolPlan([], target)).toEqual({ toCreate: 5, toRecycle: [], toClear: [] });
  });

  it("counts live WARMING+AVAILABLE current-version toward the pool", () => {
    const rows = [
      row({ id: "a", poolState: "AVAILABLE", status: "READY" }),
      row({ id: "b", poolState: "WARMING", status: "DEPLOYING" }),
    ];
    expect(computePoolPlan(rows, target)).toEqual({ toCreate: 3, toRecycle: [], toClear: [] });
  });

  it("never over-creates", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ id: `a${i}` }));
    expect(computePoolPlan(rows, target).toCreate).toBe(0);
  });

  it("recycles unclaimed live stale-version envs (excluded from count)", () => {
    const rows = [
      row({ id: "old", pinnedVersion: "0.0.1-dev.18" }),
      row({ id: "cur" }),
    ];
    expect(computePoolPlan(rows, target)).toEqual({
      toCreate: 4,
      toRecycle: ["old"],
      toClear: [],
    });
  });

  it("clears zombies (pool row with dead status) and does not count them", () => {
    const rows = [
      row({ id: "z1", poolState: "AVAILABLE", status: "TERMINATING" }),
      row({ id: "z2", poolState: "WARMING", status: "DEPLOYMENt_FAILED" }),
      row({ id: "z3", poolState: "CLAIMED", status: "DESTROYED" }),
      row({ id: "live", poolState: "AVAILABLE", status: "READY" }),
    ];
    const plan = computePoolPlan(rows, target);
    expect(plan.toClear.sort()).toEqual(["z1", "z2", "z3"]);
    // only "live" counts → need 4 more; zombies are NOT recycled (already dead)
    expect(plan.toCreate).toBe(4);
    expect(plan.toRecycle).toEqual([]);
  });

  it("does not count or recycle CLAIMED envs", () => {
    const rows = [row({ id: "c1", poolState: "CLAIMED", pinnedVersion: "0.0.1-dev.18", status: "READY" })];
    expect(computePoolPlan(rows, target)).toEqual({ toCreate: 5, toRecycle: [], toClear: [] });
  });

  it("a stuck DEPLOYMENt_FAILED warming env is cleared, not counted (deficit recreated)", () => {
    const rows = [row({ id: "f", poolState: "WARMING", status: "DEPLOYMENt_FAILED" })];
    const plan = computePoolPlan(rows, target);
    expect(plan.toClear).toEqual(["f"]);
    expect(plan.toCreate).toBe(5);
  });

  it("a stale-version env that is already dead is cleared, not recycled again", () => {
    const rows = [row({ id: "sd", poolState: "AVAILABLE", pinnedVersion: "0.0.1-dev.18", status: "TERMINATING" })];
    const plan = computePoolPlan(rows, target);
    expect(plan.toClear).toEqual(["sd"]);
    expect(plan.toRecycle).toEqual([]);
    expect(plan.toCreate).toBe(5);
  });
});
