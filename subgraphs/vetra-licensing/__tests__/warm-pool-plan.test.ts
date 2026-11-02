import { describe, it, expect } from "vitest";
import { computeAppPoolPlan, type PoolTarget } from "../warm-pool-plan.js";
import type { WarmRow, WarmState } from "../warm-pool-db.js";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const row = (
  id: string,
  state: WarmState,
  minute: number,
  hash = "h1",
): WarmRow => ({
  environment_id: id,
  app_id: "app",
  template_id: "t",
  template_hash: hash,
  state,
  created_at: at(minute),
  ready_at: state === "AVAILABLE" ? at(minute + 5) : null,
  claimed_at: state === "CLAIMED" ? at(minute + 10) : null,
  deleted_at: null,
  root_license_id: state === "CLAIMED" ? "root" : null,
});

const target = (size: number, hash = "h1"): PoolTarget => ({
  appId: "app",
  appName: "Sektar",
  templateId: "t",
  templateHash: hash,
  size,
  template: {
    services: [],
    packages: [],
    size: null,
    baseDomain: null,
    packageRegistry: null,
  },
});

describe("computeAppPoolPlan", () => {
  it("fills an empty pool from 0 to 3", () => {
    expect(computeAppPoolPlan([], target(3), {}, 10)).toEqual({
      create: 3,
      promote: [],
      remove: [],
    });
  });

  it("promotes a WARMING row whose environment is READY", () => {
    const rows = [row("w1", "WARMING", 0), row("w2", "WARMING", 1)];
    const plan = computeAppPoolPlan(
      rows,
      target(2),
      { w1: "READY", w2: "DEPLOYING" },
      10,
    );
    expect(plan).toEqual({ create: 0, promote: ["w1"], remove: [] });
  });

  it("never re-promotes an AVAILABLE row", () => {
    const plan = computeAppPoolPlan(
      [row("a1", "AVAILABLE", 0)],
      target(1),
      { a1: "READY" },
      10,
    );
    expect(plan.promote).toEqual([]);
  });

  it("recycles rows on an old hash and replaces them", () => {
    const rows = [
      row("old-a", "AVAILABLE", 0, "h0"),
      row("old-w", "WARMING", 1, "h0"),
      row("cur", "AVAILABLE", 2),
    ];
    const plan = computeAppPoolPlan(
      rows,
      target(3),
      { "old-a": "READY", "old-w": "READY", cur: "READY" },
      10,
    );
    expect(plan.remove.sort()).toEqual(["old-a", "old-w"]);
    expect(plan.promote).toEqual([]);
    expect(plan.create).toBe(2);
  });

  it("heals dead and missing environments", () => {
    const rows = [
      row("failed", "WARMING", 0),
      row("gone", "AVAILABLE", 1),
      row("ok", "AVAILABLE", 2),
    ];
    const plan = computeAppPoolPlan(
      rows,
      target(3),
      { failed: "DEPLOYMENt_FAILED", gone: null, ok: "READY" },
      10,
    );
    expect(plan.remove.sort()).toEqual(["failed", "gone"]);
    expect(plan.promote).toEqual([]);
    expect(plan.create).toBe(2);
  });

  it("shrinks 3 to 1 removing WARMING first and never a CLAIMED row", () => {
    const rows = [
      row("claimed", "CLAIMED", 0),
      row("avail", "AVAILABLE", 1),
      row("warm-old", "WARMING", 2),
      row("warm-new", "WARMING", 3),
    ];
    const status = {
      claimed: "DEPLOYMENt_FAILED",
      avail: "READY",
      "warm-old": "DEPLOYING",
      "warm-new": "DEPLOYING",
    };
    const plan = computeAppPoolPlan(rows, target(1), status, 10);
    expect(plan.remove).toEqual(["warm-new", "warm-old"]);
    expect(plan.remove).not.toContain("claimed");
    expect(plan.promote).toEqual([]);
    expect(plan.create).toBe(0);
  });

  it("shrinks AVAILABLE oldest first once no WARMING is left", () => {
    const rows = [
      row("a-old", "AVAILABLE", 0),
      row("a-mid", "AVAILABLE", 1),
      row("a-new", "AVAILABLE", 2),
    ];
    const plan = computeAppPoolPlan(
      rows,
      target(1),
      { "a-old": "READY", "a-mid": "READY", "a-new": "READY" },
      10,
    );
    expect(plan.remove).toEqual(["a-old", "a-mid"]);
  });

  it("does not promote a row it removes as surplus", () => {
    const rows = [row("a", "AVAILABLE", 0), row("w", "WARMING", 1)];
    const plan = computeAppPoolPlan(
      rows,
      target(1),
      { a: "READY", w: "DEPLOYING" },
      10,
    );
    expect(plan).toEqual({ create: 0, promote: [], remove: ["w"] });
  });

  it("drains every unclaimed row for a null target", () => {
    const rows = [
      row("claimed", "CLAIMED", 0),
      row("a", "AVAILABLE", 1),
      row("w", "WARMING", 2),
    ];
    const plan = computeAppPoolPlan(rows, null, { a: "READY", w: "READY" }, 10);
    expect(plan.remove.sort()).toEqual(["a", "w"]);
    expect(plan.promote).toEqual([]);
    expect(plan.create).toBe(0);
  });

  it("caps a size of 5 at maxPerTemplate 2", () => {
    expect(computeAppPoolPlan([], target(5), {}, 2).create).toBe(2);
    const rows = [
      row("a", "AVAILABLE", 0),
      row("b", "AVAILABLE", 1),
      row("c", "AVAILABLE", 2),
    ];
    const plan = computeAppPoolPlan(
      rows,
      target(5),
      { a: "READY", b: "READY", c: "READY" },
      2,
    );
    expect(plan).toEqual({ create: 0, promote: [], remove: ["a"] });
  });

  it("never lists a CLAIMED row, whatever its hash or status", () => {
    const rows = [row("c1", "CLAIMED", 0, "h0"), row("c2", "CLAIMED", 1)];
    for (const t of [target(0), target(1), null]) {
      const plan = computeAppPoolPlan(rows, t, { c1: null, c2: "READY" }, 10);
      expect(plan.remove).toEqual([]);
      expect(plan.promote).toEqual([]);
    }
  });
});
