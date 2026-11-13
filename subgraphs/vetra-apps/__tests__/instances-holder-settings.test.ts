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
import { fileKey } from "../settings/names.js";
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

// File settings need the chart support flag (E1).
process.env.FUSION_SECRET_FILES = "on";

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
    // An existing instance moves with its rollout step, not with the plan's target.
    await h.db
      .updateTable("instances")
      .set({ target_version: "1.4.1", target_digest: digest("c") })
      .where("id", "=", (await own()).id)
      .execute();
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

describe("file settings on the instance (plan 7 Task 9)", () => {
  const PATH = "/client_secret_sektar-web-app.json";
  const KEY = fileKey(PATH);
  const pubFile = (content: string) =>
    setAppSetting(h.deps, owner, {
      appId,
      value: content,
      secret: true,
      scope: "PLAN",
      mountPath: PATH,
    });
  const files = async () => {
    const v = (await envEntry("VETRA_FILES"))?.value;
    return v ? JSON.parse(v) : [];
  };

  it("a publisher file becomes a tenant secret and a VETRA_FILES entry, never an env var", async () => {
    await pubFile('{"web":1}');
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.get(KEY)).toBe('{"web":1}');
    expect(await files()).toEqual([{ key: KEY, mountPath: PATH }]);
    expect(await envEntry(KEY)).toBeUndefined();
    expect(JSON.stringify(await env())).not.toContain('{"web":1}');
  });

  it("a holder file at the same path replaces the publisher's", async () => {
    await pubFile("publisher");
    await setMyInstanceSetting(h.deps, holder, {
      instanceId: (await own()).id,
      kind: "FILE",
      value: "holder",
      mountPath: PATH,
    });
    await reconcileInstancesOnce(h.deps);
    expect(await files()).toEqual([{ key: KEY, mountPath: PATH }]);
    expect(h.secrets.store.get(await tenant())!.get(KEY)).toBe("holder");
  });

  it("deleting the file deletes the tenant secret and the entry", async () => {
    await setMyInstanceSetting(h.deps, holder, {
      instanceId: (await own()).id,
      kind: "FILE",
      value: "x",
      mountPath: PATH,
    });
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus((await own()).environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    await deleteMyInstanceSetting(h.deps, holder, (await own()).id, KEY);
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.has(KEY)).toBe(false);
    expect(await files()).toEqual([]);
  });

  it("refuses bad paths and at most 10 files", async () => {
    await expect(
      setMyInstanceSetting(h.deps, holder, {
        instanceId: (await own()).id,
        kind: "FILE",
        value: "x",
        mountPath: "/etc/passwd",
      }),
    ).rejects.toThrow(/cannot be mounted/);
    for (let i = 0; i < 10; i++)
      await setMyInstanceSetting(h.deps, holder, {
        instanceId: (await own()).id,
        kind: "FILE",
        value: "x",
        mountPath: `/f${i}.json`,
      });
    await expect(
      setMyInstanceSetting(h.deps, holder, {
        instanceId: (await own()).id,
        kind: "FILE",
        value: "x",
        mountPath: "/f11.json",
      }),
    ).rejects.toThrow(/at most 10 files/);
  });

  it("branch instances without files render exactly as before", async () => {
    const b = (await listInstances(h.db, appId)).find((r) => r.kind === "branch");
    if (!b?.environment_id) return;
    const e = (await h.envs.getState(b.environment_id))!;
    expect(e.fusion!.env.some((x) => x.name === "VETRA_FILES")).toBe(false);
  });
});

describe("files are refused without the chart flag (review I2)", () => {
  it("publisher and holder file settings fail until FUSION_SECRET_FILES is on", async () => {
    const prev = process.env.FUSION_SECRET_FILES;
    process.env.FUSION_SECRET_FILES = "";
    try {
      await expect(
        setAppSetting(h.deps, owner, {
          appId,
          value: "x",
          secret: true,
          scope: "PLAN",
          mountPath: "/f.json",
        }),
      ).rejects.toThrow(/not supported/);
      await expect(
        setMyInstanceSetting(h.deps, holder, {
          instanceId: (await own()).id,
          kind: "FILE",
          value: "x",
          mountPath: "/f.json",
        }),
      ).rejects.toThrow(/not supported/);
      process.env.FUSION_SECRET_FILES = "on";
      await expect(
        setMyInstanceSetting(h.deps, holder, {
          instanceId: (await own()).id,
          kind: "FILE",
          value: "x",
          mountPath: "/opt/app/f.json",
        }),
      ).rejects.toThrow(/cannot be mounted under \/opt/);
    } finally {
      process.env.FUSION_SECRET_FILES = prev;
    }
  });
});
