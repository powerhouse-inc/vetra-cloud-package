import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  stranger,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { insertPlan } from "../plans/repo.js";
import { myInstancesFor } from "../plans/holder-view.js";
import type { Caller } from "../auth.js";
import { instanceJson } from "../instances/service.js";
import { listInstances } from "../instances/repo.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const holder: Caller = {
  address: HOLDER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};
let h: Harness;
let appId: string;

const base = {
  policy: "manual",
  notice_hours: 72,
  status: "active" as const,
  size: "VETRA_AGENT_S",
  target_version: "1.4.0",
  created_by: OWNER,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

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
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    digest: digest("b"),
  });
  await insertPlan(h.db, {
    ...base,
    id: "p-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
  });
  await insertPlan(h.db, {
    ...base,
    id: "p-sh",
    app_id: appId,
    slug: "starter",
    name: "Starter",
    kind: "starter",
    access: "shared",
  });
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await seedLicence(h, {
    appId,
    kind: "starter",
    holder: HOLDER,
    licenseId: "l2",
  });
  await reconcileInstancesOnce(h.deps);
});
afterEach(async () => {
  await h.close();
});

describe("myInstances", () => {
  it("lists the holder's own instance and the shared instances of their plans", async () => {
    const mine = await myInstancesFor(h.deps, holder);
    expect(mine.map((m) => [m.planName, m.access])).toEqual([
      ["Pro", "own"],
      ["Starter", "shared"],
    ]);
    expect(mine[0].url).toMatch(/^https:\/\/.+\.vetra\.io$/);
  });
  it("lists nothing for someone without licences", async () => {
    expect(await myInstancesFor(h.deps, stranger)).toEqual([]);
  });
});

describe("AppInstance", () => {
  it("carries the plan and, for an own instance, the holder", async () => {
    const json = (await listInstances(h.db, appId)).map(instanceJson);
    expect(json.find((j) => j.kind === "own")).toMatchObject({
      planId: "p-own",
      holder: HOLDER,
    });
    expect(json.find((j) => j.kind === "shared")).toMatchObject({
      planId: "p-sh",
      holder: null,
    });
    expect(json.find((j) => j.kind === "branch")).toMatchObject({
      planId: null,
      holder: null,
    });
  });
});
