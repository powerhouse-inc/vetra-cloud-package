import { describe, expect, it, vi } from "vitest";
import { HousekeepingKeeper, loadKeeperConfig, studioHost, type KeeperConfig } from "./keeper.js";
import { buildProperRequestCountQuery } from "./loki.js";
import type { StudioRow } from "./db.js";

const silent = { info: () => {}, warn: () => {} };

const cfg = (over: Partial<KeeperConfig> = {}): KeeperConfig => ({
  enabled: true,
  dryRun: false,
  idleThresholdSeconds: 86400,
  scanIntervalMs: 900000,
  baseDomain: "vetra.io",
  allowlist: [],
  ...over,
});

function studio(over: Partial<StudioRow> = {}): StudioRow {
  return {
    envId: "doc-1",
    subdomain: "tall-duck-ab12",
    status: "READY",
    owner: "0xabc",
    poolState: null,
    tenantId: "tall-duck-ab12-9f8e",
    ...over,
  };
}

describe("loadKeeperConfig", () => {
  it("is disabled and dry-run by default (safe)", () => {
    const c = loadKeeperConfig({});
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(true);
    expect(c.idleThresholdSeconds).toBe(86400);
  });
  it("enables + leaves dry-run only when explicitly set", () => {
    const c = loadKeeperConfig({ HOUSEKEEPING_DETECTOR_ENABLED: "true", HOUSEKEEPING_DRY_RUN: "false" });
    expect(c.enabled).toBe(true);
    expect(c.dryRun).toBe(false);
  });
});

describe("buildProperRequestCountQuery", () => {
  it("selects the host and excludes automation paths + user-agents", () => {
    const q = buildProperRequestCountQuery('{namespace="traefik"}', "x.vetra.io", 86400);
    expect(q).toContain("x.vetra.io");
    expect(q).toContain("[86400s]");
    expect(q).toContain("_proxy/routes");
    expect(q).toContain("vetra-observability-pull");
    expect(q).toMatch(/count_over_time/);
  });
});

describe("HousekeepingKeeper.reconcileOnce", () => {
  it("sleeps an eligible idle studio (system dispatch, by envId)", async () => {
    const sleepEnv = vi.fn(async () => {});
    const slept = await new HousekeepingKeeper({
      listStudios: async () => [studio()],
      loki: { hasRecentProperRequest: async () => false }, // idle
      sleepEnv,
      config: cfg(),
      logger: silent,
    }).reconcileOnce();
    expect(sleepEnv).toHaveBeenCalledWith("doc-1");
    expect(slept).toEqual(["tall-duck-ab12.vetra.io"]);
  });

  it("does not sleep when there is recent proper traffic", async () => {
    const sleepEnv = vi.fn(async () => {});
    await new HousekeepingKeeper({
      listStudios: async () => [studio()],
      loki: { hasRecentProperRequest: async () => true }, // active
      sleepEnv,
      config: cfg(),
      logger: silent,
    }).reconcileOnce();
    expect(sleepEnv).not.toHaveBeenCalled();
  });

  it("dry-run never dispatches but reports candidates", async () => {
    const sleepEnv = vi.fn(async () => {});
    const slept = await new HousekeepingKeeper({
      listStudios: async () => [studio()],
      loki: { hasRecentProperRequest: async () => false },
      sleepEnv,
      config: cfg({ dryRun: true }),
      logger: silent,
    }).reconcileOnce();
    expect(sleepEnv).not.toHaveBeenCalled();
    expect(slept).toEqual(["tall-duck-ab12.vetra.io"]);
  });

  it("skips ineligible studios (warm-pool + allowlist)", async () => {
    const sleepEnv = vi.fn(async () => {});
    await new HousekeepingKeeper({
      listStudios: async () => [
        studio({ poolState: "AVAILABLE" }),
        studio({ subdomain: "vip-studio", tenantId: "vip-studio-1" }),
      ],
      loki: { hasRecentProperRequest: async () => false },
      sleepEnv,
      config: cfg({ allowlist: ["vip-studio"] }),
      logger: silent,
    }).reconcileOnce();
    expect(sleepEnv).not.toHaveBeenCalled();
  });

  it("studioHost builds the apex host", () => {
    expect(studioHost("cozy-bat-09", "vetra.io")).toBe("cozy-bat-09.vetra.io");
  });
});
