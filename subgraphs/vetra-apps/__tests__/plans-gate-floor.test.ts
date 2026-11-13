import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateFloorError } from "../gate/service.js";
import { createPlan, setPlanTarget } from "../plans/service.js";
import { GATE_ON, PLANS_ON } from "./gate-fixtures.js";
import {
  makeHarness,
  owner,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";

let h: Harness;
let appId: string;

const start = async (gate = true) => {
  h = await makeHarness(
    testConfig({ plans: PLANS_ON, ...(gate ? { gate: GATE_ON } : {}) }),
  );
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    powerhouse: "6.2.3-dev.101",
  });
  await seedRelease(h, appId, {
    version: "1.5.0",
    run: 101,
    kind: "release",
    powerhouse: "6.2.3-dev.102",
  });
};
beforeEach(() => start());
afterEach(async () => {
  await h.close();
});

const BELOW =
  /1\.4\.0 was built on Powerhouse 6\.2\.3-dev\.101.*6\.2\.3-dev\.102/;

describe("the Powerhouse floor of shared plans (D9)", () => {
  it("refuses a shared plan on a release built below the floor", async () => {
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "starter",
        access: "shared",
        targetVersion: "1.4.0",
      }),
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
      message: expect.stringMatching(BELOW),
    });
  });

  it("accepts one at the floor, then refuses moving it below", async () => {
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "starter",
      access: "shared",
      targetVersion: "1.5.0",
    });
    expect(p.targetVersion).toBe("1.5.0");
    await expect(
      setPlanTarget(h.deps, owner, p.id, "1.4.0"),
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
      message: expect.stringMatching(BELOW),
    });
  });

  it("leaves own plans alone", async () => {
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "pro",
      access: "own",
      targetVersion: "1.4.0",
    });
    expect(p.targetVersion).toBe("1.4.0");
  });

  it("does nothing with the gate off", async () => {
    await h.close();
    await start(false);
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "starter",
      access: "shared",
      targetVersion: "1.4.0",
    });
    expect(p.targetVersion).toBe("1.4.0");
  });

  it("treats an unknown Powerhouse version as below the floor", () => {
    const cfg = testConfig({ gate: GATE_ON });
    expect(
      gateFloorError(cfg, { version: "1.0.0", powerhouse_version: "" }),
    ).toMatch(/built on Powerhouse \(unknown\)/);
    expect(
      gateFloorError(cfg, {
        version: "1.0.0",
        powerhouse_version: "6.2.3-dev.102",
      }),
    ).toBeNull();
    expect(
      gateFloorError(testConfig(), {
        version: "1.0.0",
        powerhouse_version: "",
      }),
    ).toBeNull();
  });
});
