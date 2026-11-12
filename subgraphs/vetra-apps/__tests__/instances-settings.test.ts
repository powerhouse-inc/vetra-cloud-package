import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { listInstances } from "../instances/repo.js";
import {
  reconcileInstancesOnce,
  RECREATING_FOR_SETTINGS,
  SECRETS_SETTLE_MS,
  NAMESPACE_TIMED_OUT,
  WAITING_FOR_NAMESPACE,
  WAITING_FOR_SECRETS,
} from "../instances/reconciler.js";
import { setAppSetting, deleteAppSetting } from "../settings/service.js";
import {
  approveChanges,
  setFusionConfig,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";

let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
});
afterEach(async () => {
  await h.close();
});

const one = async () => (await listInstances(h.db, appId))[0];
const env = async () => (await h.envs.getState((await one()).environment_id!))!;
const version = async () =>
  (await env()).services.find((s) => s.type === "FUSION")!.version ?? null;
const tenant = async () => {
  const r = await one();
  return getTenantId(r.host!, r.environment_id!);
};
const envValue = async (name: string) =>
  (await env()).fusion!.env.find((e) => e.name === name);
const set = (
  name: string,
  value: string,
  secret = false,
  scope?: "ALL" | "BRANCH" | "PREVIEW",
) => setAppSetting(h.deps, owner, { appId, name, value, secret, scope });

describe("instance settings", () => {
  it("gives a new instance Vetra's generated secrets and the publisher's before it starts", async () => {
    await set("RELAY", "https://relay");
    await set("API_TOKEN", "s3cret", true);
    await reconcileInstancesOnce(h.deps);
    const t = await tenant();
    const store = h.secrets.store.get(t)!;
    expect(store.get("PH_WORKFLOWS_SECRETS_MASTER_KEY")).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(store.get("PH_ATTACHMENT_URL_SIGNING_SECRET")).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(store.get("API_TOKEN")).toBe("s3cret");
    expect(h.secrets.notified).toContain(t);
    expect(await envValue("RELAY")).toMatchObject({
      value: "https://relay",
      isSecret: false,
    });
    expect(await envValue("API_TOKEN")).toMatchObject({
      value: null,
      isSecret: true,
    });
    expect(JSON.stringify(await env())).not.toContain("s3cret");
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`);
    const row = await one();
    expect(row.settings_delivered).toBe(row.target_settings);
  });

  it("never replaces the generated master key", async () => {
    await reconcileInstancesOnce(h.deps);
    const t = await tenant();
    const key = h.secrets.store.get(t)!.get("PH_WORKFLOWS_SECRETS_MASTER_KEY");
    await set("FOO", "1");
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(t)!.get("PH_WORKFLOWS_SECRETS_MASTER_KEY")).toBe(
      key,
    );
  });

  it("waits for the namespace, delivers, waits for the secrets to land, then starts", async () => {
    let live = false;
    h.deps.tenantLive = async () => live;
    await reconcileInstancesOnce(h.deps);
    expect(await version()).toBeNull();
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "updating",
      reason: WAITING_FOR_NAMESPACE,
    });
    expect(h.secrets.store.get(await tenant())).toBeUndefined();

    live = true;
    await reconcileInstancesOnce(h.deps);
    expect(
      h.secrets.store
        .get(await tenant())!
        .has("PH_WORKFLOWS_SECRETS_MASTER_KEY"),
    ).toBe(true);
    expect(await version()).toBeNull();
    expect((await one()).reason).toBe(WAITING_FOR_SECRETS);

    h.advance(SECRETS_SETTLE_MS);
    await reconcileInstancesOnce(h.deps);
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("rolls a settings change: new revision, secrets delivered, status updating; ready on the new revision", async () => {
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    const before = await one();
    expect(before).toMatchObject({
      status: "ready",
      running_settings: before.target_settings,
    });

    await set("API_TOKEN", "v2", true);
    await reconcileInstancesOnce(h.deps);
    const after = await one();
    expect(after.target_settings).not.toBe(before.target_settings);
    expect(after.status).toBe("updating");
    expect(h.secrets.store.get(await tenant())!.get("API_TOKEN")).toBe("v2");
    expect((await envValue("VETRA_SETTINGS_REVISION"))!.value).toBe(
      after.target_settings,
    );

    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "ready",
      running_settings: after.target_settings,
    });
  });

  it("fails an instance whose namespace never comes up, and heals once it does", async () => {
    let live = false;
    h.deps.tenantLive = async () => live;
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect((await one()).reason).toBe(WAITING_FOR_NAMESPACE);

    h.advance(21 * 60_000);
    await reconcileInstancesOnce(h.deps);
    const failed = await one();
    expect(failed).toMatchObject({
      status: "failed",
      reason: NAMESPACE_TIMED_OUT,
    });
    expect(failed.failed_digest).toBeNull(); // still retried
    await reconcileInstancesOnce(h.deps);
    expect((await one()).updated_at).toBe(failed.updated_at); // no churn

    live = true;
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "updating",
      reason: WAITING_FOR_SECRETS,
    });
    h.advance(SECRETS_SETTLE_MS);
    await reconcileInstancesOnce(h.deps);
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`);
  });

  it("delivers a settings change to a stopped instance (no pods, no live namespace) and wakes it", async () => {
    let live = true;
    h.deps.tenantLive = async () => live;
    await reconcileInstancesOnce(h.deps); // created
    await reconcileInstancesOnce(h.deps); // delivered
    h.advance(SECRETS_SETTLE_MS);
    await reconcileInstancesOnce(h.deps); // started
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await one()).status).toBe("ready");

    h.envs.setStatus(envId, "STOPPED");
    live = false; // a stopped environment has no pods
    await set("API_TOKEN", "v2", true);
    const ops = h.envs.executed.length;
    await reconcileInstancesOnce(h.deps);
    const row = await one();
    expect(row.reason).not.toBe(WAITING_FOR_NAMESPACE);
    expect(row.settings_delivered).toBe(row.target_settings);
    expect(h.secrets.store.get(await tenant())!.get("API_TOKEN")).toBe("v2");
    const sent = h.envs.executed.slice(ops).flatMap((e) => e.types);
    expect(sent[0]).toBe("WAKE_ENVIRONMENT");
    expect((await envValue("VETRA_SETTINGS_REVISION"))!.value).toBe(
      row.target_settings,
    );
  });

  it("removes a deleted secret from the tenant and the environment", async () => {
    await set("API_TOKEN", "x", true);
    await reconcileInstancesOnce(h.deps);
    await deleteAppSetting(h.deps, owner, appId, "API_TOKEN");
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.store.get(await tenant())!.has("API_TOKEN")).toBe(false);
    expect(await envValue("API_TOKEN")).toBeUndefined();
    expect(
      h.secrets.store
        .get(await tenant())!
        .has("PH_WORKFLOWS_SECRETS_MASTER_KEY"),
    ).toBe(true);
  });

  it("applies a scope to its kind only", async () => {
    await set("ONLY_PREVIEWS", "1", false, "PREVIEW");
    await reconcileInstancesOnce(h.deps);
    expect(await envValue("ONLY_PREVIEWS")).toBeUndefined();
  });

  it("recreates an instance made before Vetra's secrets (once)", async () => {
    await reconcileInstancesOnce(h.deps);
    const old = (await one()).environment_id!;
    // Strip the generated secrets, as an environment from slices 1-3 has them.
    const state = (await h.envs.getState(old))!;
    await h.envs.execute(old, [
      setFusionConfig({
        image: state.fusion!.image,
        env: [
          { name: "PH_HOST", value: "cli", isSecret: false },
          { name: "ADMINS", value: state.owner!, isSecret: false },
        ],
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
      approveChanges({}),
    ]);
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toContain(old);
    expect((await one()).reason).toBe(RECREATING_FOR_SETTINGS);
    await reconcileInstancesOnce(h.deps); // gone → start over
    await reconcileInstancesOnce(h.deps); // created again
    const row = await one();
    expect(row.environment_id).not.toBe(old);
    expect(h.secrets.purged).toContain(getTenantId(row.host!, old));
    expect((await envValue("PH_WORKFLOWS_SECRETS_MASTER_KEY"))!.isSecret).toBe(
      true,
    );
  });

  it("a failed settings-only update is not reverted or retried until the settings change", async () => {
    // testConfig leaves health out: report mode (DEFAULT_INSTANCE_HEALTH).
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    await set("BROKEN", "1");
    await reconcileInstancesOnce(h.deps);
    // The rolled pod never comes back: report mode fails it on the document after the 20-minute timeout.
    h.envs.setStatus(envId, "DEPLOYMENt_FAILED");
    h.advance(21 * 60_000);
    await reconcileInstancesOnce(h.deps);
    const failed = await one();
    expect(failed.status).toBe("failed");
    expect(failed.failed_digest).toBe(failed.target_digest);
    expect(failed.failed_settings).toBe(failed.target_settings);
    expect(await version()).toBe(`1.5.0-main.1@${digest("a")}`); // nothing to revert to
    const ops = h.envs.executed.length;
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.executed.length).toBe(ops); // not retried
    await deleteAppSetting(h.deps, owner, appId, "BROKEN");
    await reconcileInstancesOnce(h.deps);
    expect((await one()).status).toBe("updating"); // a new revision is tried
  });

  it("purges the tenant's secrets when the instance goes", async () => {
    await reconcileInstancesOnce(h.deps);
    const t = await tenant();
    await h.db
      .updateTable("apps")
      .set({ instances_enabled: false })
      .where("id", "=", appId)
      .execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(h.secrets.purged).toContain(t);
  });

  it("never purges the secrets of an environment that became licensed", async () => {
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.envs.manage(envId);
    await h.db
      .updateTable("apps")
      .set({ instances_enabled: false })
      .where("id", "=", appId)
      .execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).not.toContain(envId);
    expect(h.secrets.purged).toEqual([]);
  });

  it("never purges the secrets of a draft relinked to another App when starting over", async () => {
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.envs.link(envId, "another-app", "PREVIEW");
    h.envs.setStatus(envId, "DRAFT");
    await reconcileInstancesOnce(h.deps);
    expect((await one()).environment_id).toBeNull(); // started over
    expect(h.envs.deleted).not.toContain(envId);
    expect(h.secrets.purged).toEqual([]);
  });

  it("fails the instance (not the pass) without a tenant secrets store", async () => {
    h.deps.instanceSecrets = null;
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({ status: "failed" });
    expect((await one()).reason).toMatch(/not configured/);
  });
});
