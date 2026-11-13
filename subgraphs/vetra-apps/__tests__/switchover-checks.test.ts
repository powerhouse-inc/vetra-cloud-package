import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import {
  seedLicence,
  seedLicensedEnvironment,
  seedRelease,
} from "./instances-fixtures.js";
import { insertPlan } from "../plans/repo.js";
import {
  checkSwitchover,
  gatherSwitchoverFacts,
  type SwitchoverFacts,
} from "../switchover/checks.js";
import { insertSwitchover } from "../switchover/repo.js";
import { freezeAppReleases } from "../../vetra-licensing/release-service.js";
import { createRolloutStore } from "../../vetra-licensing/rollout-db.js";
import { switchoverRow } from "./switchover-fixtures.js";

const HOLDER = "0x1111111111111111111111111111111111111111";

const OK: SwitchoverFacts = {
  mode: "real",
  row: {
    appId: "a1",
    endedAt: null,
    switchedOverAt: null,
    rootLicenseId: "l1",
    templateId: "t",
  },
  env: {
    status: "READY",
    owner: HOLDER,
    customDomain: null,
    fusionEnvNames: ["ADMINS", "PH_HOST"],
    admins: [HOLDER],
    fusionHost: true,
  },
  template: { mode: "DEDICATED" },
  appHasSharedTerm: false,
  gateActive: false,
  chainLive: true,
  holder: HOLDER,
  kind: "sektar-cloud",
  plan: { id: "p1", access: "own", status: "active", targetVersion: "1.4.0" },
  release: { version: "1.4.0", digest: "sha256:x", stable: true },
  openSwitchoverOnApp: false,
  frozen: true,
  switches: {
    instances: true,
    plans: true,
    rollouts: true,
    healthEnforce: true,
  },
};
const with_ = (over: Partial<SwitchoverFacts>): SwitchoverFacts => ({
  ...OK,
  ...over,
});

describe("checkSwitchover", () => {
  it("passes a Sektar-shaped environment", () => {
    expect(checkSwitchover(OK)).toEqual([]);
  });

  it.each<[string, Partial<SwitchoverFacts>, RegExp]>([
    ["no licensed row", { row: null }, /not a licensed environment/],
    [
      "already switched over",
      { row: { ...OK.row!, switchedOverAt: "t" } },
      /already switched over/,
    ],
    [
      "licence ended (row)",
      { row: { ...OK.row!, endedAt: "t" } },
      /licence ended/,
    ],
    ["licence ended (chain not live)", { chainLive: false }, /licence ended/],
    [
      "environment not READY",
      { env: { ...OK.env!, status: "STOPPED" } },
      /STOPPED, not READY/,
    ],
    ["environment unreadable", { env: null }, /document cannot be read/],
    [
      "not a FUSION host",
      { env: { ...OK.env!, fusionHost: false } },
      /not a FUSION host/,
    ],
    [
      "template not DEDICATED",
      { template: { mode: "SHARED" } },
      /not DEDICATED/,
    ],
    [
      "holder not the only admin",
      { env: { ...OK.env!, admins: [HOLDER, "0x2"] } },
      /admins are not exactly its owner/,
    ],
    [
      "holder not the owner",
      {
        env: {
          ...OK.env!,
          owner: "0x2222222222222222222222222222222222222222",
        },
      },
      /admins are not exactly its owner/,
    ],
    [
      "custom domain",
      { env: { ...OK.env!, customDomain: "shop.example.com" } },
      /custom domain/,
    ],
    [
      "FUSION env beyond ADMINS and PH_HOST",
      {
        env: {
          ...OK.env!,
          fusionEnvNames: ["ADMINS", "PH_HOST", "OPENROUTER_API_KEY"],
        },
      },
      /OPENROUTER_API_KEY/,
    ],
    [
      "SHARED term without the gate",
      { appHasSharedTerm: true, gateActive: false },
      /SHARED term and the licence gate/,
    ],
    ["no own plan for the kind", { plan: null }, /no own plan/],
    [
      "plan retired",
      { plan: { ...OK.plan!, status: "retired" } },
      /plan is retired/,
    ],
    [
      "plan not own",
      { plan: { ...OK.plan!, access: "shared" } },
      /not an own plan/,
    ],
    [
      "target not stable",
      { release: { ...OK.release!, stable: false } },
      /not a stable release/,
    ],
    ["no target", { release: null }, /not a stable release/],
    [
      "target without digest",
      { release: { ...OK.release!, digest: null } },
      /no image digest/,
    ],
    [
      "another switch-over running",
      { openSwitchoverOnApp: true },
      /another switch-over/,
    ],
    ["releases not frozen (real)", { frozen: false }, /not frozen/],
    [
      "instances off",
      { switches: { ...OK.switches, instances: false } },
      /VETRA_APPS_INSTANCES is off/,
    ],
    [
      "plans off",
      { switches: { ...OK.switches, plans: false } },
      /VETRA_APPS_PLANS is off/,
    ],
    [
      "rollouts off",
      { switches: { ...OK.switches, rollouts: false } },
      /rollouts is off/,
    ],
    [
      "health not enforced",
      { switches: { ...OK.switches, healthEnforce: false } },
      /INSTANCE_HEALTH=enforce\) is off/,
    ],
  ])("refuses: %s", (_name, over, text) => {
    expect(checkSwitchover(with_(over)).join("\n")).toMatch(text);
  });

  it("a dry run needs no freeze and a SHARED term is fine with the gate on", () => {
    expect(checkSwitchover(with_({ mode: "dry_run", frozen: false }))).toEqual(
      [],
    );
    expect(
      checkSwitchover(with_({ appHasSharedTerm: true, gateActive: true })),
    ).toEqual([]);
  });

  it("reports every reason at once", () => {
    const why = checkSwitchover(
      with_({ plan: null, frozen: false, openSwitchoverOnApp: true }),
    );
    expect(why).toHaveLength(3);
  });
});

describe("gatherSwitchoverFacts", () => {
  let h: Harness;
  let appId: string;
  beforeEach(async () => {
    h = await makeHarness(
      testConfig({
        plans: { enabled: true, stopAfterDays: 14 },
        instances: {
          enabled: true,
          health: { mode: "enforce", unhealthyWindowMs: 300_000 },
        },
      } as never),
    );
    appId = (await seedActiveApp(h)).id;
    await seedRelease(h, appId, {
      version: "1.4.0",
      run: 100,
      kind: "release",
    });
    await seedLicence(h, {
      appId,
      kind: "sektar-cloud",
      holder: HOLDER,
      licenseId: "l1",
    });
    await seedLicensedEnvironment(h, {
      appId,
      root: "l1",
      environmentId: "env-old",
    });
    await insertPlan(h.db, {
      id: "p1",
      app_id: appId,
      slug: "cloud",
      name: "Cloud",
      kind: "sektar-cloud",
      access: "own",
      size: "VETRA_AGENT_M",
      target_version: "1.4.0",
      policy: "manual",
      notice_hours: 72,
      status: "active",
      created_by: "0xa",
      created_at: "t",
      updated_at: "t",
    });
    h.deps.docs = {
      exists: async () => true,
      getState: async () => ({
        templates: [{ id: "template-1", mode: "DEDICATED" }],
        terms: [{ kind: "sektar-cloud", templateId: "template-1" }],
      }),
    } as never;
  });
  afterEach(async () => {
    await h.close();
  });

  it("reads the plan, release, chain, freeze and switches", async () => {
    const f = await gatherSwitchoverFacts(h.deps, "env-old");
    expect(f).toMatchObject({
      mode: "real",
      row: { appId, rootLicenseId: "l1", switchedOverAt: null },
      template: { mode: "DEDICATED" },
      appHasSharedTerm: false,
      gateActive: false,
      chainLive: true,
      holder: HOLDER,
      kind: "sektar-cloud",
      plan: {
        id: "p1",
        access: "own",
        status: "active",
        targetVersion: "1.4.0",
      },
      release: { version: "1.4.0", stable: true },
      openSwitchoverOnApp: false,
      frozen: false,
      switches: {
        instances: true,
        plans: true,
        rollouts: true,
        healthEnforce: true,
      },
    });
    expect(f.release?.digest).toMatch(/^sha256:/);
  });

  it("returns an empty fact set for an environment that is not licensed", async () => {
    const f = await gatherSwitchoverFacts(h.deps, "nope");
    expect(f.row).toBeNull();
    expect(checkSwitchover(f)).toEqual(["this is not a licensed environment"]);
  });

  it("sees the freeze and another switch-over past PREPARED, but not an earlier or a closed one", async () => {
    await freezeAppReleases(
      { store: createRolloutStore(h.deps.licensingDb!), now: () => "t" },
      appId,
      "switch-over",
    );
    expect((await gatherSwitchoverFacts(h.deps, "env-old")).frozen).toBe(true);
    const other = (state: never, id: string, extra: object = {}) =>
      insertSwitchover(
        h.db,
        switchoverRow({
          id,
          app_id: appId,
          environment_id: `e-${id}`,
          state,
          ...extra,
        }),
      );
    await other("PREPARED" as never, "s1");
    await other("DONE" as never, "s2");
    expect(
      (await gatherSwitchoverFacts(h.deps, "env-old")).openSwitchoverOnApp,
    ).toBe(false);
    await other("RESTORING" as never, "s3");
    expect(
      (await gatherSwitchoverFacts(h.deps, "env-old")).openSwitchoverOnApp,
    ).toBe(true);
  });
});
