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
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { listInstances } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { appInstancesFor } from "../instances/service.js";
import { insertPlan, updatePlan } from "../plans/repo.js";
import { setAppSetting } from "../settings/service.js";
import {
  deleteMyInstanceSetting,
  setMyInstanceSetting,
} from "../settings/holder-service.js";
import { deliverSettings } from "../settings/deliver.js";
import { settingsForInstance } from "../settings/resolve.js";
import type { Caller } from "../auth.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const SERVICE = "0x9999999999999999999999999999999999999999";
const holder: Caller = {
  address: HOLDER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};

let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  h.deps.serviceOwner = SERVICE;
  h.deps.holderVault = {
    encrypt: async (p) => `holder:${Buffer.from(p).toString("base64")}`,
    decrypt: async (c) =>
      Buffer.from(c.slice("holder:".length), "base64").toString(),
  };
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
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await reconcileInstancesOnce(h.deps);
  h.envs.setStatus((await own()).environment_id!, "READY");
  await reconcileInstancesOnce(h.deps);
  expect((await own()).status).toBe("ready");
});
afterEach(async () => {
  await h.close();
});

const own = async () =>
  (await listInstances(h.db, appId)).find((r) => r.kind === "own")!;
const env = async () => (await h.envs.getState((await own()).environment_id!))!;
const envEntry = async (name: string) =>
  (await env()).fusion!.env.find((e) => e.name === name);
const tenant = async () => {
  const r = await own();
  return getTenantId(r.host!, r.environment_id!);
};
const hset = async (name: string, value: string, kind: "PLAIN" | "SECRET") =>
  setMyInstanceSetting(h.deps, holder, {
    instanceId: (await own()).id,
    name,
    value,
    kind,
  });

describe("holder settings on the instance", () => {
  it("delivers a holder secret, declares it, rolls the revision, then ready", async () => {
    const before = await own();
    await hset("GOOGLE_CLIENT_SECRET", "s3cret", "SECRET");
    await reconcileInstancesOnce(h.deps);
    const after = await own();
    expect(after.target_settings).not.toBe(before.target_settings);
    expect(after.status).toBe("updating");
    expect(
      h.secrets.store.get(await tenant())!.get("GOOGLE_CLIENT_SECRET"),
    ).toBe("s3cret");
    expect(await envEntry("GOOGLE_CLIENT_SECRET")).toMatchObject({
      value: null,
      isSecret: true,
    });
    expect((await envEntry("VETRA_SETTINGS_REVISION"))!.value).toBe(
      after.target_settings,
    );
    expect(JSON.stringify(await env())).not.toContain("s3cret");
    h.envs.setStatus(after.environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await own()).toMatchObject({
      status: "ready",
      running_settings: after.target_settings,
    });
  });

  it("keeps the holder's override when the publisher changes the PLAN setting", async () => {
    const plan = (value: string) =>
      setAppSetting(h.deps, owner, {
        appId,
        name: "MODE",
        value,
        secret: false,
        scope: "PLAN",
      });
    await plan("p1");
    await hset("MODE", "mine", "PLAIN");
    await reconcileInstancesOnce(h.deps);
    expect((await envEntry("MODE"))!.value).toBe("mine");
    await plan("p2");
    await reconcileInstancesOnce(h.deps);
    expect((await envEntry("MODE"))!.value).toBe("mine");
  });

  it("removes a deleted holder secret from the tenant and the document", async () => {
    await hset("TOKEN", "t", "SECRET");
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus((await own()).environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.has("TOKEN")).toBe(true);
    await deleteMyInstanceSetting(h.deps, holder, (await own()).id, "TOKEN");
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.has("TOKEN")).toBe(false);
    expect(await envEntry("TOKEN")).toBeUndefined();
  });

  it("a rollback keeps the holder's settings", async () => {
    await hset("MODE", "mine", "PLAIN");
    await reconcileInstancesOnce(h.deps);
    const envId = (await own()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    await seedRelease(h, appId, {
      version: "1.4.1",
      run: 110,
      kind: "release",
      digest: digest("c"),
    });
    await updatePlan(
      h.db,
      "plan-own",
      { target_version: "1.4.1" },
      "2026-10-04T00:00:00.000Z",
    );
    await reconcileInstancesOnce(h.deps);
    expect(
      (await env()).services.find((s) => s.type === "FUSION")!.version,
    ).toBe(`1.4.1@${digest("c")}`);
    h.envs.setStatus(envId, "DEPLOYMENt_FAILED");
    await reconcileInstancesOnce(h.deps);
    expect(await own()).toMatchObject({
      status: "failed",
      failed_digest: digest("c"),
    });
    expect(
      (await env()).services.find((s) => s.type === "FUSION")!.version,
    ).toBe(`1.4.0@${digest("b")}`);
    expect((await envEntry("MODE"))!.value).toBe("mine");
  });

  it("shows the publisher how many holder settings an instance has, not their names", async () => {
    await hset("MODE", "mine", "PLAIN");
    await hset("TOKEN", "t", "SECRET");
    const list = await appInstancesFor(h.deps, owner, appId);
    expect(list.find((i) => i.kind === "own")!.holderSettingsCount).toBe(2);
    expect(list.find((i) => i.kind === "branch")!.holderSettingsCount).toBe(0);
    expect(JSON.stringify(list)).not.toContain("TOKEN");
  });

  it("leaves a branch instance's document as before: generated secrets, then the publisher's", async () => {
    await setAppSetting(h.deps, owner, {
      appId,
      name: "API_TOKEN",
      value: "x",
      secret: true,
    });
    await reconcileInstancesOnce(h.deps);
    const branch = (await listInstances(h.db, appId)).find(
      (r) => r.kind === "branch",
    )!;
    const state = (await h.envs.getState(branch.environment_id!))!;
    expect(
      state.fusion!.env.filter((e) => e.isSecret).map((e) => e.name),
    ).toEqual([
      "PH_WORKFLOWS_SECRETS_MASTER_KEY",
      "PH_ATTACHMENT_URL_SIGNING_SECRET",
      "API_TOKEN",
    ]);
  });
});

describe("deliverSettings and Vetra's own secrets", () => {
  it("never deletes nor writes a declared Vetra secret", async () => {
    const t = "tenant-x";
    await h.secrets.setSecrets(t, [
      { key: "OPENROUTER_API_KEY", value: "broker-key" },
      { key: "STALE", value: "x" },
    ]);
    const settings = settingsForInstance([], [], "own", ["OPENROUTER_API_KEY"]);
    await deliverSettings(h.deps, t, settings, [
      "PH_WORKFLOWS_SECRETS_MASTER_KEY",
      "OPENROUTER_API_KEY",
      "STALE",
    ]);
    const store = h.secrets.store.get(t)!;
    expect(store.get("OPENROUTER_API_KEY")).toBe("broker-key");
    expect(store.has("STALE")).toBe(false);
  });
});
