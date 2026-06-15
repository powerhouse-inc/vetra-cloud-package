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
    expect(computePoolPlan([], target)).toEqual({ toCreate: 5, toRecycle: [] });
  });

  it("counts WARMING+AVAILABLE current-version toward the pool", () => {
    expect(
      computePoolPlan(
        [row({ id: "a" }), row({ id: "b", poolState: "WARMING", status: "DEPLOYING" })],
        target,
      ),
    ).toEqual({ toCreate: 3, toRecycle: [] });
  });

  it("never over-creates", () => {
    expect(
      computePoolPlan(Array.from({ length: 6 }, (_, i) => row({ id: `a${i}` })), target),
    ).toEqual({ toCreate: 0, toRecycle: [] });
  });

  it("recycles unclaimed stale-version envs and excludes them from the count", () => {
    expect(
      computePoolPlan(
        [row({ id: "old", pinnedVersion: "0.0.1-dev.18" }), row({ id: "cur" })],
        target,
      ),
    ).toEqual({ toCreate: 4, toRecycle: ["old"] });
  });

  it("never counts or recycles CLAIMED envs", () => {
    expect(
      computePoolPlan(
        [row({ id: "c1", poolState: "CLAIMED", pinnedVersion: "0.0.1-dev.18" })],
        target,
      ),
    ).toEqual({ toCreate: 5, toRecycle: [] });
  });

  it("ignores FAILED envs", () => {
    expect(
      computePoolPlan([row({ id: "f", poolState: "FAILED" }), row({ id: "a" })], target),
    ).toEqual({ toCreate: 4, toRecycle: [] });
  });
});
