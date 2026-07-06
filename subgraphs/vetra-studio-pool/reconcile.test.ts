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
    expect(computePoolPlan([], target)).toEqual({
      toCreate: 5,
      toRecycle: [],
      toTerminate: [],
      toClear: [],
    });
  });

  it("counts live WARMING+AVAILABLE current-version toward the pool", () => {
    const rows = [
      row({ id: "a", poolState: "AVAILABLE", status: "READY" }),
      row({ id: "b", poolState: "WARMING", status: "DEPLOYING" }),
    ];
    expect(computePoolPlan(rows, target)).toEqual({
      toCreate: 3,
      toRecycle: [],
      toTerminate: [],
      toClear: [],
    });
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
      toTerminate: [],
      toClear: [],
    });
  });

  it("TERMINATES the keeper's own dead warm envs (WARMING/AVAILABLE), never merely clearing them", () => {
    // This is the leak fix: a dead unclaimed warm env must be DELETED (full
    // teardown), not just un-counted — otherwise its namespace/pod/row orphan
    // and the keeper endlessly recreates replacements.
    const rows = [
      row({ id: "z1", poolState: "AVAILABLE", status: "TERMINATING" }),
      row({ id: "z2", poolState: "WARMING", status: "DEPLOYMENt_FAILED" }),
      row({ id: "live", poolState: "AVAILABLE", status: "READY" }),
    ];
    const plan = computePoolPlan(rows, target);
    expect(plan.toTerminate.sort()).toEqual(["z1", "z2"]);
    expect(plan.toClear).toEqual([]);
    // only "live" counts → need 4 more; dead envs are terminated, not recycled
    expect(plan.toCreate).toBe(4);
    expect(plan.toRecycle).toEqual([]);
  });

  it("a stuck DEPLOYMENt_FAILED warming env is terminated (deleted), and the deficit recreated", () => {
    const rows = [row({ id: "f", poolState: "WARMING", status: "DEPLOYMENt_FAILED" })];
    const plan = computePoolPlan(rows, target);
    expect(plan.toTerminate).toEqual(["f"]);
    expect(plan.toClear).toEqual([]);
    expect(plan.toCreate).toBe(5);
  });

  it("a stale-version env that is already dead is terminated, not recycled again", () => {
    const rows = [row({ id: "sd", poolState: "AVAILABLE", pinnedVersion: "0.0.1-dev.18", status: "TERMINATING" })];
    const plan = computePoolPlan(rows, target);
    expect(plan.toTerminate).toEqual(["sd"]);
    expect(plan.toRecycle).toEqual([]);
    expect(plan.toClear).toEqual([]);
    expect(plan.toCreate).toBe(5);
  });

  it("CLEARS (never terminates) a dead CLAIMED env — its lifecycle belongs to the owner", () => {
    const rows = [row({ id: "c", poolState: "CLAIMED", status: "DESTROYED" })];
    const plan = computePoolPlan(rows, target);
    expect(plan.toClear).toEqual(["c"]);
    expect(plan.toTerminate).toEqual([]);
    expect(plan.toCreate).toBe(5);
  });

  it("terminates a legacy FAILED-marked pool row", () => {
    const rows = [row({ id: "leg", poolState: "FAILED", status: "READY" })];
    const plan = computePoolPlan(rows, target);
    expect(plan.toTerminate).toEqual(["leg"]);
    expect(plan.toClear).toEqual([]);
  });

  it("does not count or recycle live CLAIMED envs", () => {
    const rows = [row({ id: "c1", poolState: "CLAIMED", pinnedVersion: "0.0.1-dev.18", status: "READY" })];
    expect(computePoolPlan(rows, target)).toEqual({
      toCreate: 5,
      toRecycle: [],
      toTerminate: [],
      toClear: [],
    });
  });
});
