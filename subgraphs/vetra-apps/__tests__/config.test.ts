import { describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE_HEALTH, loadAppsConfig } from "../config.js";

describe("Studio Apps config", () => {
  it("reads no Vetra-managed GitHub org: Studio App repos live in the user's own GitHub", () => {
    const cfg = loadAppsConfig({
      VETRA_APPS_MANAGED_GITHUB_ORG: "vetra-apps",
      VETRA_APPS_MANAGED_INSTALLATION_ID: "123",
    });
    expect("managedGithub" in cfg).toBe(false);
  });
});

describe("instances config", () => {
  it("is on with no suffix by default", () => {
    expect(loadAppsConfig({}).instances).toEqual({
      enabled: true,
      labelSuffix: "",
      health: DEFAULT_INSTANCE_HEALTH,
    });
  });
  it.each(["off", "false", "0", "no", " OFF ", "No"])(
    "turns off with VETRA_APPS_INSTANCES=%j",
    (v) => {
      expect(
        loadAppsConfig({ VETRA_APPS_INSTANCES: v }).instances.enabled,
      ).toBe(false);
    },
  );
  it.each(["on", "true", "1", "yes", "TRUE", ""])(
    "stays on with VETRA_APPS_INSTANCES=%j",
    (v) => {
      expect(
        loadAppsConfig({ VETRA_APPS_INSTANCES: v }).instances.enabled,
      ).toBe(true);
    },
  );
  it("refuses an unknown VETRA_APPS_INSTANCES value at startup", () => {
    expect(() => loadAppsConfig({ VETRA_APPS_INSTANCES: "maybe" })).toThrow(
      /VETRA_APPS_INSTANCES.*maybe/,
    );
  });
  it("takes a label suffix such as -stg", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg" }).instances,
    ).toEqual({
      enabled: true,
      labelSuffix: "-stg",
      health: DEFAULT_INSTANCE_HEALTH,
    });
  });
  it("accepts dashes inside the suffix", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-s-1" }).instances
        .labelSuffix,
    ).toBe("-s-1");
  });
  it("accepts at most 8 characters including the dash", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-abcdefg" }).instances
        .labelSuffix,
    ).toBe("-abcdefg");
    expect(() =>
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-abcdefgh" }),
    ).toThrow(/VETRA_APPS_INSTANCE_LABEL_SUFFIX.*-abcdefgh/);
  });
  it.each(["-", "-stg-", "-STG", "stg", "--", ".staging"])(
    "throws at startup on suffix %j",
    (bad) => {
      expect(() =>
        loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: bad }),
      ).toThrow(/VETRA_APPS_INSTANCE_LABEL_SUFFIX/);
    },
  );
});

describe("instance health config", () => {
  it("reports by default", () => {
    expect(loadAppsConfig({}).instances.health).toEqual({
      mode: "report",
      unhealthyWindowMs: 300_000,
      probesPerPass: 10,
      probesPerApp: 3,
    });
  });
  it("takes enforce, a window and probe budgets", () => {
    expect(
      loadAppsConfig({
        VETRA_APPS_INSTANCE_HEALTH: "ENFORCE",
        VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S: "180",
        VETRA_APPS_INSTANCE_PROBES_PER_PASS: "20",
        VETRA_APPS_INSTANCE_PROBES_PER_APP: "5",
      }).instances.health,
    ).toEqual({
      mode: "enforce",
      unhealthyWindowMs: 180_000,
      probesPerPass: 20,
      probesPerApp: 5,
    });
  });
  it.each([
    ["VETRA_APPS_INSTANCE_HEALTH", "strict"],
    ["VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S", "30"],
    ["VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S", "5m"],
    ["VETRA_APPS_INSTANCE_PROBES_PER_PASS", "0"],
    ["VETRA_APPS_INSTANCE_PROBES_PER_APP", "21"],
  ])("throws at startup on %s=%j", (name, value) => {
    expect(() => loadAppsConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});
