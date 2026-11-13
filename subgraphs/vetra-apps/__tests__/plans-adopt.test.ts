import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  makeHarness,
  owner,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { listAudit } from "../audit/repo.js";
import { getApp } from "../repo.js";
import { listInstances } from "../instances/repo.js";
import { listPlans } from "../plans/repo.js";
import { syncPlanInstances } from "../plans/sync.js";
import { adoptLicensedKind, createPlan } from "../plans/service.js";
import {
  seedLicence,
  seedLicensedEnvironment,
  seedRelease,
} from "./instances-fixtures.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, { version: "1.4.0", run: 100, kind: "release" });
  await seedRelease(h, appId, {
    version: "1.5.0-beta.1",
    run: 101,
    kind: "release",
  });
  await seedRelease(h, appId, { version: "1.5.0-main.3", run: 102 });
  // The App document's terms: one dedicated, one shared.
  const state = {
    templates: [
      { id: "t-ded", mode: "DEDICATED" },
      { id: "t-sh", mode: "SHARED" },
    ],
    terms: [
      { kind: "sektar-cloud", templateId: "t-ded" },
      { kind: "sektar-cloud-1y", templateId: "t-ded" },
      { kind: "free", templateId: "t-sh" },
    ],
  };
  h.deps.docs = {
    exists: async () => true,
    getState: async () => state,
  } as never;
});
afterEach(async () => {
  await h.close();
});

const input = (over: Record<string, unknown> = {}) => ({
  appId,
  kind: "sektar-cloud",
  slug: "cloud",
  name: "Sektar cloud",
  size: "VETRA_AGENT_M",
  targetVersion: "1.4.0",
  ...over,
});
const code = (c: string) => ({
  extensions: expect.objectContaining({ code: c }),
});

describe("adoptLicensedKind", () => {
  it("adopts a kind that has licences and a licensed environment as an own plan, audited", async () => {
    await seedLicence(h, {
      appId,
      kind: "sektar-cloud",
      holder: HOLDER,
      licenseId: "l1",
    });
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    const p = await adoptLicensedKind(h.deps, admin, input());
    expect(p).toMatchObject({
      appId,
      kind: "sektar-cloud",
      slug: "cloud",
      name: "Sektar cloud",
      access: "own",
      size: "VETRA_AGENT_M",
      targetVersion: "1.4.0",
      policy: "manual",
      status: "active",
    });
    const actions = (await listAudit(h.db, appId, { limit: 20 })).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(["plan.created", "switchover.kind_adopted"]),
    );
  });

  it("refuses a non-admin, even the App's owner", async () => {
    await expect(
      adoptLicensedKind(h.deps, owner, input()),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    expect(await listPlans(h.db, appId)).toEqual([]);
  });

  it("refuses a kind whose term is not DEDICATED, or is no term", async () => {
    await expect(
      adoptLicensedKind(h.deps, admin, input({ kind: "free", slug: "free" })),
    ).rejects.toThrow(/not a DEDICATED term/);
    await expect(
      adoptLicensedKind(h.deps, admin, input({ kind: "nope", slug: "nope" })),
    ).rejects.toThrow(/not a DEDICATED term/);
  });

  it("refuses a kind that is already adopted", async () => {
    await adoptLicensedKind(h.deps, admin, input());
    await expect(
      adoptLicensedKind(h.deps, admin, input({ slug: "cloud-2" })),
    ).rejects.toThrow(/already a plan/);
  });

  it.each(["1.5.0-beta.1", "1.5.0-main.3", "9.9.9"])(
    "refuses a target that is not a stable release of the App (%s)",
    async (targetVersion) => {
      await expect(
        adoptLicensedKind(h.deps, admin, input({ targetVersion })),
      ).rejects.toThrow(/not a stable release/);
    },
  );

  it("createPlan still refuses what adopt accepts", async () => {
    await seedLicence(h, {
      appId,
      kind: "sektar-cloud",
      holder: HOLDER,
      licenseId: "l1",
    });
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await expect(
      createPlan(h.deps, admin, { appId, kind: "sektar-cloud", access: "own" }),
    ).rejects.toThrow(/switch-over/);
  });

  it("after adoption: a chain with a licensed environment gets no instance, one without gets its own", async () => {
    await seedLicence(h, {
      appId,
      kind: "sektar-cloud",
      holder: HOLDER,
      licenseId: "l1",
    });
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await seedLicence(h, {
      appId,
      kind: "sektar-cloud",
      holder: OTHER,
      licenseId: "l2",
    });
    await adoptLicensedKind(h.deps, admin, input());
    await syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
    const own = await listInstances(h.db, appId, "own");
    expect(own.map((r) => r.licence_root_id)).toEqual(["l2"]);
    expect(own[0]).toMatchObject({
      holder_address: OTHER,
      target_version: "1.4.0",
    });
  });
});
