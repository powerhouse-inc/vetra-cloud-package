import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { insertPlan } from "../plans/repo.js";
import { deleteApp } from "../service.js";
import { getApp } from "../repo.js";
import { upsertAppSetting } from "../settings/repo.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
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
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    digest: digest("b"),
  });
});
afterEach(async () => {
  await h.close();
});

const plan = () =>
  insertPlan(h.db, {
    id: "plan-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });

describe("deleteApp guard for customer instances (plan 7 Task 13)", () => {
  it("refuses an App with a customer instance and changes nothing", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await reconcileInstancesOnce(h.deps);
    await upsertAppSetting(h.db, {
      app_id: appId,
      scope: "all",
      name: "KEEP",
      secret: false,
      value: "1",
      ciphertext: null,
      write_id: "w",
      updated_at: "2026-10-02T00:00:00.000Z",
      updated_by: OWNER,
    });
    await expect(deleteApp(h.deps, owner, appId, false)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
      message: expect.stringMatching(/runs 1 customer instance/),
    });
    expect((await getApp(h.db, appId))!.status).not.toBe("DELETED");
    expect(
      await h.db.selectFrom("app_settings").select("name").execute(),
    ).toHaveLength(1);
  });

  it("refuses an App with a live licence of a plan's kind and no instance yet", async () => {
    await plan();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    await expect(deleteApp(h.deps, owner, appId, false)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("a retired plan's waiting licence does not block deleting the App", async () => {
    await plan();
    await h.db.updateTable("plans").set({ status: "retired" }).execute();
    await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
    expect(await deleteApp(h.deps, owner, appId, false)).toBe(true);
  });

  it("deletes an App with plans but no holders, as today", async () => {
    await plan();
    expect(await deleteApp(h.deps, owner, appId, false)).toBe(true);
  });
});
