import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTANCE_HEALTH,
  DEFAULT_PLANS,
  gateConfigOf,
  loadAppsConfig,
  plansConfigOf,
  rolloutsEnabled,
  rolloutsHeld,
  switchoverConfigOf,
} from "../config.js";

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

describe("plans config", () => {
  it("is off with a 14-day stop by default", () => {
    expect(loadAppsConfig({}).plans).toEqual({
      enabled: false,
      stopAfterDays: 14,
    });
    expect(DEFAULT_PLANS).toEqual({ enabled: false, stopAfterDays: 14 });
  });
  it("turns on with VETRA_APPS_PLANS=on and takes the stop window", () => {
    expect(
      loadAppsConfig({
        VETRA_APPS_PLANS: " On ",
        VETRA_APPS_PLAN_STOP_AFTER_DAYS: "7",
      }).plans,
    ).toEqual({ enabled: true, stopAfterDays: 7 });
  });
  it("refuses unknown values at startup", () => {
    expect(() => loadAppsConfig({ VETRA_APPS_PLANS: "maybe" })).toThrow(
      /VETRA_APPS_PLANS.*maybe/,
    );
    expect(() =>
      loadAppsConfig({ VETRA_APPS_PLAN_STOP_AFTER_DAYS: "0" }),
    ).toThrow(/VETRA_APPS_PLAN_STOP_AFTER_DAYS/);
  });
  it("reads a config without plans as off", () => {
    const { plans: _drop, ...rest } = loadAppsConfig({
      VETRA_APPS_PLANS: "on",
    });
    expect(plansConfigOf(rest)).toEqual(DEFAULT_PLANS);
  });
  it("runs rollouts with plans, and holds them with VETRA_APPS_ROLLOUTS_HOLD", () => {
    expect(rolloutsEnabled(loadAppsConfig({}))).toBe(false);
    const on = loadAppsConfig({ VETRA_APPS_PLANS: "on" });
    expect(rolloutsEnabled(on)).toBe(true);
    expect(rolloutsHeld(on)).toBe(false);
    expect(on.plans).toEqual({ enabled: true, stopAfterDays: 14 });
    expect(
      rolloutsEnabled(
        loadAppsConfig({ VETRA_APPS_PLANS: "on", VETRA_APPS_INSTANCES: "off" }),
      ),
    ).toBe(false);
    const held = loadAppsConfig({
      VETRA_APPS_PLANS: "on",
      VETRA_APPS_ROLLOUTS_HOLD: " Yes ",
    });
    expect(rolloutsHeld(held)).toBe(true);
    expect(held.plans).toEqual({
      enabled: true,
      stopAfterDays: 14,
      rolloutsHold: true,
    });
    expect(() => loadAppsConfig({ VETRA_APPS_ROLLOUTS_HOLD: "later" })).toThrow(
      /VETRA_APPS_ROLLOUTS_HOLD.*later/,
    );
  });
});

describe("switch-over config", () => {
  it("is off by default, with the plan's defaults", () => {
    expect(loadAppsConfig({}).switchover).toStrictEqual({
      enabled: false,
      leadHours: 24,
      holdDays: 30,
      confirmHours: 72,
      restoreJobs: 4,
    });
  });
  it("reads the switch and the numbers", () => {
    const c = loadAppsConfig({
      VETRA_APPS_SWITCHOVER: "on",
      VETRA_APPS_SWITCHOVER_LEAD_HOURS: "6",
      VETRA_APPS_SWITCHOVER_HOLD_DAYS: "45",
      VETRA_APPS_SWITCHOVER_CONFIRM_HOURS: "48",
      VETRA_APPS_SWITCHOVER_RESTORE_JOBS: "2",
    }).switchover;
    expect(c).toStrictEqual({
      enabled: true,
      leadHours: 6,
      holdDays: 45,
      confirmHours: 48,
      restoreJobs: 2,
    });
  });
  it("refuses a bad switch value and non-positive numbers", () => {
    expect(() => loadAppsConfig({ VETRA_APPS_SWITCHOVER: "maybe" })).toThrow(
      /VETRA_APPS_SWITCHOVER/,
    );
    expect(() =>
      loadAppsConfig({ VETRA_APPS_SWITCHOVER_HOLD_DAYS: "0" }),
    ).toThrow(/HOLD_DAYS/);
  });
  it("is off whenever plans are off", () => {
    expect(
      switchoverConfigOf(loadAppsConfig({ VETRA_APPS_SWITCHOVER: "on" })).enabled,
    ).toBe(false);
    expect(
      switchoverConfigOf(
        loadAppsConfig({ VETRA_APPS_SWITCHOVER: "on", VETRA_APPS_PLANS: "on" }),
      ).enabled,
    ).toBe(true);
  });
  it("reads a config without a switch-over block as off", () => {
    const { switchover: _drop, ...rest } = loadAppsConfig({
      VETRA_APPS_SWITCHOVER: "on",
      VETRA_APPS_PLANS: "on",
    });
    expect(switchoverConfigOf(rest).enabled).toBe(false);
  });
});

describe("gate config", () => {
  const base = {
    VETRA_APPS_GATE_URL:
      "https://switchboard.staging.vetra.io/api/@powerhousedao/vetra-cloud-package/apps/gate/check",
    VETRA_APPS_GATE_MIN_POWERHOUSE: "6.2.3-dev.102",
    OPENBAO_ADDR: "http://openbao:8200",
  };
  it("is off by default and needs nothing then", () => {
    expect(gateConfigOf(loadAppsConfig({}))).toEqual({
      enabled: false,
      url: null,
      minPowerhouse: null,
    });
    expect(
      gateConfigOf(loadAppsConfig({ VETRA_APPS_GATE: "off", ...base })),
    ).toEqual({ enabled: false, url: null, minPowerhouse: null });
  });
  it("reads the URL and the Powerhouse floor when on", () => {
    expect(loadAppsConfig({ VETRA_APPS_GATE: "on", ...base }).gate).toEqual({
      enabled: true,
      url: base.VETRA_APPS_GATE_URL,
      minPowerhouse: "6.2.3-dev.102",
    });
  });
  it("refuses to start when on without the settings vault (OPENBAO_ADDR)", () => {
    const { OPENBAO_ADDR: _drop, ...noVault } = base;
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "on", ...noVault })).toThrow(
      /OPENBAO_ADDR/,
    );
    expect(() =>
      loadAppsConfig({ VETRA_APPS_GATE: "on", ...noVault, OPENBAO_ADDR: " " }),
    ).toThrow(/OPENBAO_ADDR/);
    expect(
      gateConfigOf(loadAppsConfig({ VETRA_APPS_GATE: "off", ...noVault })),
    ).toEqual({ enabled: false, url: null, minPowerhouse: null });
  });
  it("refuses to start when on without a URL or floor, or with bad values", () => {
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "on" })).toThrow(
      /VETRA_APPS_GATE_URL/,
    );
    expect(() =>
      loadAppsConfig({
        VETRA_APPS_GATE: "on",
        VETRA_APPS_GATE_URL: base.VETRA_APPS_GATE_URL,
      }),
    ).toThrow(/VETRA_APPS_GATE_MIN_POWERHOUSE/);
    expect(() =>
      loadAppsConfig({
        VETRA_APPS_GATE: "on",
        ...base,
        VETRA_APPS_GATE_URL: "http://x/gate/check",
      }),
    ).toThrow(/https/);
    expect(() =>
      loadAppsConfig({
        VETRA_APPS_GATE: "on",
        ...base,
        VETRA_APPS_GATE_URL: "https://x/somewhere/else",
      }),
    ).toThrow(/apps\/gate\/check/);
    expect(() =>
      loadAppsConfig({
        VETRA_APPS_GATE: "on",
        ...base,
        VETRA_APPS_GATE_MIN_POWERHOUSE: "six",
      }),
    ).toThrow(/semver/);
    expect(() => loadAppsConfig({ VETRA_APPS_GATE: "maybe" })).toThrow(
      /on\/off/,
    );
  });
});
