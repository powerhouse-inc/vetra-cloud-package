import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";
import {
  seedLicence,
  seedLicensedEnvironment,
  seedRelease,
} from "./instances-fixtures.js";
import {
  appPlansFor,
  createPlan,
  retirePlan,
  setPlanTarget,
  updatePlanFor,
} from "../plans/service.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
  await seedRelease(h, appId, { version: "1.5.0-main.3", run: 101 });
});
afterEach(async () => {
  await h.close();
});

const code = (c: string) => ({
  extensions: expect.objectContaining({ code: c }),
});

describe("plans API", () => {
  it("creates a plan from a term kind with defaults, and lists it", async () => {
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "Pro",
      access: "OWN",
    });
    expect(p).toMatchObject({
      appId,
      slug: "pro",
      name: "Pro",
      kind: "Pro",
      access: "own",
      size: "VETRA_AGENT_S",
      targetVersion: null,
      policy: "manual",
      noticeHours: 72,
      status: "active",
    });
    expect((await appPlansFor(h.deps, owner, appId)).map((x) => x.id)).toEqual([
      p.id,
    ]);
  });

  it("is for the App's operators only", async () => {
    await expect(
      createPlan(h.deps, stranger, { appId, kind: "pro", access: "own" }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
  });

  it("refuses a kind that already has holders, a second plan for a kind, and reserved slugs", async () => {
    await seedLicence(h, {
      appId,
      kind: "early",
      holder: HOLDER,
      licenseId: "l1",
    });
    await expect(
      createPlan(h.deps, owner, { appId, kind: "early", access: "own" }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await createPlan(h.deps, owner, { appId, kind: "pro", access: "own" });
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "pro",
        access: "shared",
        slug: "pro-2",
      }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "x",
        access: "own",
        slug: "main",
      }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
  });

  it("refuses an App that still has licensed environments (they move with the switch-over)", async () => {
    await seedLicensedEnvironment(h, { appId, root: "old" });
    await expect(
      createPlan(h.deps, owner, { appId, kind: "new", access: "own" }),
    ).rejects.toThrow(/switch-over/);
  });

  it("targets releases only, changes size and name, and retires", async () => {
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "pro",
      access: "shared",
      targetVersion: "1.4.0",
    });
    expect(p.targetVersion).toBe("1.4.0");
    await expect(
      setPlanTarget(h.deps, owner, p.id, "1.5.0-main.3"),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(
      setPlanTarget(h.deps, owner, p.id, "9.9.9"),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    expect(
      await updatePlanFor(h.deps, owner, {
        planId: p.id,
        size: "VETRA_AGENT_L",
        name: "Pro+",
      }),
    ).toMatchObject({
      size: "VETRA_AGENT_L",
      name: "Pro+",
    });
    expect((await retirePlan(h.deps, owner, p.id)).status).toBe("retired");
    await expect(
      setPlanTarget(h.deps, owner, p.id, "1.4.0"),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
  });

  it("says when a kind was taken by a retired plan (a kind is a plan once, for good)", async () => {
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "pro",
      access: "own",
    });
    await retirePlan(h.deps, owner, p.id);
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "pro",
        access: "own",
        slug: "pro-2",
      }),
    ).rejects.toThrow(/retired plan/);
  });
});
