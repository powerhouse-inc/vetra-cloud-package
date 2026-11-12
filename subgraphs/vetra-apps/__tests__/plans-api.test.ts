import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  appIdentity,
  makeHarness,
  member,
  ORG,
  owner,
  seedActiveApp,
  stranger,
  testConfig,
  type Harness,
} from "./harness.js";
import { appForOwner } from "../service.js";
import { getApp } from "../repo.js";
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
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
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

  it("refuses while plans are off on this Vetra", async () => {
    h.deps.cfg = {
      ...h.deps.cfg,
      plans: { enabled: false, stopAfterDays: 14 },
    };
    await expect(
      createPlan(h.deps, owner, { appId, kind: "pro", access: "own" }),
    ).rejects.toMatchObject({
      message: "Plans are not enabled on this Vetra",
      ...code("BAD_USER_INPUT"),
    });
  });

  it("refuses a kind any licence of the App was ever issued with, whatever its lifecycle", async () => {
    await seedLicence(h, {
      appId,
      kind: "issued",
      holder: HOLDER,
      licenseId: "l1",
      status: "ISSUED",
    });
    // A chain once of "was", now of "now": "was" had holders.
    await seedLicence(h, {
      appId,
      kind: "was",
      holder: HOLDER,
      licenseId: "l2",
      status: "REPLACED",
    });
    await seedLicence(h, {
      appId,
      kind: "now",
      holder: HOLDER,
      licenseId: "l3",
      root: "l2",
    });
    for (const kind of ["issued", "was", "now"])
      await expect(
        createPlan(h.deps, owner, { appId, kind, access: "own" }),
      ).rejects.toThrow(/already has holders/);
    await expect(
      createPlan(h.deps, owner, { appId, kind: "fresh", access: "own" }),
    ).resolves.toMatchObject({ kind: "fresh" });
  });

  it("refuses every kind while the App has a licence of unknown kind, even an ended one", async () => {
    await seedLicence(h, {
      appId,
      kind: null,
      holder: HOLDER,
      licenseId: "l1",
      status: "REVOKED",
    });
    await expect(
      createPlan(h.deps, owner, { appId, kind: "pro", access: "own" }),
    ).rejects.toThrow(/unknown kind/);
  });

  it("refuses a kind that differs only in case from a licence's kind", async () => {
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
      status: "EXPIRED",
    });
    await expect(
      createPlan(h.deps, owner, { appId, kind: "PRO", access: "own" }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/differs only in case/),
      ...code("BAD_USER_INPUT"),
    });
  });

  it("says a kind is already a plan before saying it has holders", async () => {
    await createPlan(h.deps, owner, { appId, kind: "pro", access: "own" });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "pro",
        access: "own",
        slug: "pro-2",
      }),
    ).rejects.toThrow(/already a plan/);
  });

  it("answers a lost race for a slug or kind with BAD_USER_INPUT", async () => {
    const results = await Promise.allSettled([
      createPlan(h.deps, owner, { appId, kind: "pro", access: "own" }),
      createPlan(h.deps, owner, { appId, kind: "pro", access: "own" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const lost = results.find((r) => r.status === "rejected");
    expect((lost as PromiseRejectedResult).reason).toMatchObject(
      code("BAD_USER_INPUT"),
    );
  });

  it("caps kind and name at 64 characters and refuses a blank new name", async () => {
    const long = "x".repeat(65);
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: long,
        access: "own",
        slug: "long",
      }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(
      createPlan(h.deps, owner, {
        appId,
        kind: "pro",
        access: "own",
        name: long,
      }),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "x".repeat(64),
      access: "own",
      slug: "max",
      name: "y".repeat(64),
    });
    for (const name of ["", "   ", long])
      await expect(
        updatePlanFor(h.deps, owner, { planId: p.id, name }),
      ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    expect(
      (
        await updatePlanFor(h.deps, owner, {
          planId: p.id,
          size: "VETRA_AGENT_M",
        })
      ).name,
    ).toBe("y".repeat(64));
  });

  it("lets a viewer list plans but not change them; App identities (CI) can do neither", async () => {
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "pro",
      access: "own",
    });
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, appId); // adopts the transfer into ORG
    h.orgs.join(ORG, member.address, "MEMBER");
    expect((await appPlansFor(h.deps, member, appId)).map((x) => x.id)).toEqual(
      [p.id],
    );
    const forbidden = code("FORBIDDEN");
    await expect(
      createPlan(h.deps, member, { appId, kind: "max", access: "own" }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      updatePlanFor(h.deps, member, { planId: p.id, name: "No" }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      setPlanTarget(h.deps, member, p.id, "1.4.0"),
    ).rejects.toMatchObject(forbidden);
    await expect(retirePlan(h.deps, member, p.id)).rejects.toMatchObject(
      forbidden,
    );
    await expect(appPlansFor(h.deps, appIdentity, appId)).rejects.toMatchObject(
      forbidden,
    );
    await expect(
      createPlan(h.deps, appIdentity, { appId, kind: "max", access: "own" }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      setPlanTarget(h.deps, appIdentity, p.id, "1.4.0"),
    ).rejects.toMatchObject(forbidden);
  });

  it("moves a plan only to its own App's releases, and only for its operators", async () => {
    // Another App's release (a row copied from this App's, under another id).
    const mine = (await getApp(h.db, appId))!;
    const other = "other-app";
    await h.db
      .insertInto("apps")
      .values({
        ...mine,
        id: other,
        slug: "other",
        repository_id: "999",
        production_environment_id: "env-other",
      })
      .execute();
    await seedRelease(h, other, {
      version: "2.0.0",
      run: 200,
      kind: "release",
    });
    const p = await createPlan(h.deps, owner, {
      appId,
      kind: "pro",
      access: "own",
    });
    await expect(
      setPlanTarget(h.deps, owner, p.id, "2.0.0"),
    ).rejects.toMatchObject(code("BAD_USER_INPUT"));
    await expect(
      setPlanTarget(h.deps, stranger, p.id, "1.4.0"),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(
      setPlanTarget(h.deps, owner, "no-such-plan", "1.4.0"),
    ).rejects.toMatchObject(code("NOT_FOUND"));
  });
});
