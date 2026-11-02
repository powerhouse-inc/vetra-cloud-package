import { describe, it, expect } from "vitest";
import { computeAppPoolPlan, MAX_WARMING_MS, type PoolTarget } from "../warm-pool-plan.js";
import type { WarmRow, WarmState } from "../warm-pool-db.js";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
/** Ten minutes after the first row: nothing in the older tests has timed out. */
const NOW = at(10);

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
  env_deleted_at: null,
  pool_size: null,
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
    expect(computeAppPoolPlan([], target(3), {}, 10, NOW)).toEqual({
      create: 3,
      promote: [],
      remove: [],
      timedOut: [],
    });
  });

  it("promotes a WARMING row whose environment is READY", () => {
    const rows = [row("w1", "WARMING", 0), row("w2", "WARMING", 1)];
    const plan = computeAppPoolPlan(
      rows,
      target(2),
      { w1: "READY", w2: "DEPLOYING" },
      10,
      NOW,
    );
    expect(plan).toEqual({ create: 0, promote: ["w1"], remove: [], timedOut: [] });
  });

  it("never re-promotes an AVAILABLE row", () => {
    const plan = computeAppPoolPlan(
      [row("a1", "AVAILABLE", 0)],
      target(1),
      { a1: "READY" },
      10,
      NOW,
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
      NOW,
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
      NOW,
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
    const plan = computeAppPoolPlan(rows, target(1), status, 10, NOW);
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
      NOW,
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
      NOW,
    );
    expect(plan).toEqual({ create: 0, promote: [], remove: ["w"], timedOut: [] });
  });

  it("drains every unclaimed row for a null target", () => {
    const rows = [
      row("claimed", "CLAIMED", 0),
      row("a", "AVAILABLE", 1),
      row("w", "WARMING", 2),
    ];
    const plan = computeAppPoolPlan(rows, null, { a: "READY", w: "READY" }, 10, NOW);
    expect(plan.remove.sort()).toEqual(["a", "w"]);
    expect(plan.promote).toEqual([]);
    expect(plan.create).toBe(0);
  });

  it("caps a size of 5 at maxPerTemplate 2", () => {
    expect(computeAppPoolPlan([], target(5), {}, 2, NOW).create).toBe(2);
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
      NOW,
    );
    expect(plan).toEqual({ create: 0, promote: [], remove: ["a"], timedOut: [] });
  });

  it("never lists a CLAIMED row, whatever its hash or status", () => {
    const rows = [row("c1", "CLAIMED", 0, "h0"), row("c2", "CLAIMED", 1)];
    for (const t of [target(0), target(1), null]) {
      const plan = computeAppPoolPlan(rows, t, { c1: null, c2: "READY" }, 10, NOW);
      expect(plan.remove).toEqual([]);
      expect(plan.promote).toEqual([]);
    }
  });

  describe("a WARMING row that never becomes READY", () => {
    it("is retired after MAX_WARMING_MS, whatever its status (a DRAFT a crash left included), and replaced", () => {
      expect(MAX_WARMING_MS).toBe(30 * 60_000);
      const rows = [row("slow", "WARMING", 0), row("draft", "WARMING", 0), row("young", "WARMING", 20)];
      const plan = computeAppPoolPlan(
        rows,
        target(3),
        { slow: "DEPLOYING", draft: "DRAFT", young: "DEPLOYING" },
        10,
        at(31),
      );
      expect(plan).toEqual({ create: 2, promote: [], remove: ["slow", "draft"], timedOut: ["slow", "draft"] });
    });

    it("is kept up to the limit itself", () => {
      const plan = computeAppPoolPlan([row("w", "WARMING", 0)], target(1), { w: "DEPLOYING" }, 10, at(30));
      expect(plan).toEqual({ create: 0, promote: [], remove: [], timedOut: [] });
    });

    it("is promoted, not retired, when it is READY by the time it is looked at", () => {
      const plan = computeAppPoolPlan([row("w", "WARMING", 0)], target(1), { w: "READY" }, 10, at(120));
      expect(plan).toEqual({ create: 0, promote: ["w"], remove: [], timedOut: [] });
    });

    it("never times out an AVAILABLE row, and lists a timed-out row once when it is also on an old hash", () => {
      const rows = [row("a", "AVAILABLE", 0), row("old", "WARMING", 0, "h0")];
      const plan = computeAppPoolPlan(rows, target(1), { a: "READY", old: "DEPLOYING" }, 10, at(120));
      expect(plan).toEqual({ create: 0, promote: [], remove: ["old"], timedOut: ["old"] });
    });
  });
});
