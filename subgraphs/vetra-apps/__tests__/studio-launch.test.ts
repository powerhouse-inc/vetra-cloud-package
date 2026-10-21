import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addPackage,
  approveChanges,
  setRuntimeConfig,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { Caller } from "../auth.js";
import { envUrls } from "../envs.js";
import { getApp, getDeployment, type AppRow } from "../repo.js";
import { createResolvers } from "../resolvers.js";
import {
  deployApp,
  ensureStudioProduct,
  launchStudioVersion,
  rollbackApp,
  rollbackStudioVersion,
  RESTORE_ACTOR,
  setStudioProductDrive,
  studioDeploymentFor,
  withDefaultDrive,
  type LaunchStudioVersionInput,
} from "../service.js";
import {
  hashLaunchSecret,
  STUDIO_SECRET_HEADER,
  storeLaunchSecretHash,
} from "../studio-binding.js";
import {
  runDeploymentWatcherOnce,
  runUnlaunchedStudioAppSweepOnce,
} from "../watcher.js";
import {
  APP_DID,
  claim,
  deployAsCi,
  makeHarness,
  OWNER,
  owner,
  seedActiveApp,
  STRANGER,
  type Harness,
} from "./harness.js";

const AGENT_KEY = "did:key:zDnaeStudioAgent";
const agent: Caller = { address: OWNER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
const FUTURE = "2027-10-02T12:00:00.000Z";
const DAY = 86_400_000;
const SHA1 = "1111111aaaaaaa";
const SHA2 = "2222222bbbbbbb";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  h.renown.delegation = { expiresAt: FUTURE };
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

interface Product {
  app: AppRow;
  studioId: string;
  secret: string;
  envId: string;
}

/** A claimed Studio with its launch secret and its product (made by its agent), live env READY. */
async function seedProduct(name = "My Shop", by: Caller = agent): Promise<Product> {
  const studioId = await h.envs.seedStandalone(OWNER);
  await h.envs.execute(studioId, [
    addPackage({
      packageName: "vetra",
      version: "0.0.1-dev.27",
      registry: "https://registry.dev.vetra.io",
    }),
    approveChanges({}),
  ]);
  const secret = randomBytes(32).toString("hex");
  await storeLaunchSecretHash(h.db, studioId, hashLaunchSecret(secret), "2026-10-20T00:00:00.000Z");
  const app = await ensureStudioProduct(
    h.deps,
    by,
    { studioEnvironmentId: studioId, name },
    { kind: "agent", secret },
  );
  h.envs.setStatus(app.production_environment_id, "READY");
  return { app, studioId, secret, envId: app.production_environment_id };
}

const launchInput = (
  p: Product,
  versionNumber: number,
  sha: string,
  packages = [{ name: "@vetra-apps/my-shop", version: `0.${versionNumber}.0` }],
): LaunchStudioVersionInput => ({
  appId: p.app.id,
  versionNumber,
  sha,
  gitTag: `v${versionNumber}`,
  packages,
});

const launch = (p: Product, input: LaunchStudioVersionInput, secret = p.secret, caller = agent) =>
  launchStudioVersion(h.deps, caller, input, secret);

const deploymentCount = async () =>
  (await h.db.selectFrom("app_deployments").select("id").execute()).length;

const envPackages = async (envId: string) =>
  (await h.envs.getState(envId))!.packages.map((p) => `${p.name}@${p.version}`).sort();

/** Launch, let the watcher apply it, the env settle READY, and the watcher mark it READY. */
async function launchToReady(p: Product, input: LaunchStudioVersionInput) {
  const d = await launch(p, input);
  await runDeploymentWatcherOnce(h.deps);
  h.envs.setStatus(p.envId, "READY");
  await runDeploymentWatcherOnce(h.deps);
  const ready = (await getDeployment(h.db, d.id))!;
  expect(ready.status).toBe("READY");
  return ready;
}

describe("launchStudioVersion (D20)", () => {
  it("agent launches its own Studio's App and the deployment records trigger and owner", async () => {
    const p = await seedProduct();
    const queued = vi.fn();
    h.deps.onDeploymentQueued = queued;
    const envActionsBefore = h.envs.executed.length;

    const d = await launch(p, launchInput(p, 1, SHA1.toUpperCase()));
    expect(d).toMatchObject({
      app_id: p.app.id,
      environment_id: p.envId,
      kind: "PRODUCTION",
      status: "PENDING",
      trigger: "STUDIO_LAUNCH",
      actor_did: AGENT_KEY,
      on_behalf_of: OWNER_DID,
      version_number: 1,
      git_ref: "refs/tags/v1",
      sha: SHA1,
      image_tag: null,
      error: null,
    });
    expect(JSON.parse(d.packages)).toStrictEqual([{ name: "@vetra-apps/my-shop", version: "0.1.0" }]);
    // Recorded only: the env is untouched until the watcher applies it.
    expect(h.envs.executed.length).toBe(envActionsBefore);
    expect(queued).toHaveBeenCalledWith(d.id);
    // The first launch marks the product launched.
    const launchedAt = (await getApp(h.db, p.app.id))!.launched_at;
    expect(launchedAt).toBeTruthy();

    // A retry of the same launch gets the same deployment.
    expect((await launch(p, launchInput(p, 1, SHA1))).id).toBe(d.id);
    expect(await deploymentCount()).toBe(1);

    // The watcher applies it (once), then follows it to READY.
    expect(await runDeploymentWatcherOnce(h.deps)).toStrictEqual([d.id]);
    expect((await getDeployment(h.db, d.id))!.status).toBe("DEPLOYING");
    expect(await envPackages(p.envId)).toStrictEqual(["@vetra-apps/my-shop@0.1.0"]);
    expect(h.envs.executed.slice(envActionsBefore).map((e) => e.types)).toStrictEqual([
      ["ADD_PACKAGE"],
      ["APPROVE_CHANGES"],
    ]);
    h.envs.setStatus(p.envId, "READY");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, d.id))!.status).toBe("READY");
    // A retry after it went live still answers with it.
    expect((await launch(p, launchInput(p, 1, SHA1))).id).toBe(d.id);

    // The agent reads its own deployment.
    expect(await studioDeploymentFor(h.deps, agent, d.id, p.secret)).toMatchObject({ id: d.id, status: "READY" });
    expect(await studioDeploymentFor(h.deps, agent, "nope", p.secret)).toBeNull();

    // A second launch keeps the first launch time.
    await launch(p, launchInput(p, 2, SHA2));
    expect((await getApp(h.db, p.app.id))!.launched_at).toBe(launchedAt);
  });

  it("concurrent retries record one deployment; after a FAILED one the launch is tried again", async () => {
    const p = await seedProduct();
    const input = launchInput(p, 1, SHA1);
    const made = await Promise.all([1, 2, 3].map(() => launch(p, input)));
    expect(new Set(made.map((d) => d.id)).size).toBe(1);
    expect(await deploymentCount()).toBe(1);

    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, made[0].id))!.status).toBe("FAILED");

    const again = await launch(p, input);
    expect(again.id).not.toBe(made[0].id);
    expect(again.status).toBe("PENDING");
  });

  it("agent cannot launch another App", async () => {
    const mine = await seedProduct("Mine");
    const otherAgent: Caller = { ...agent, appKey: "did:key:zDnaeOtherStudioAgent" };
    const other = await seedProduct("Other", otherAgent);
    const github = await seedActiveApp(h);
    const before = await deploymentCount();

    // Another Studio's product with this Studio's secret.
    expect(await code(launch(other, launchInput(other, 1, SHA1), mine.secret))).toBe("STUDIO_BINDING");
    // An App that is not a Studio's, and an unknown App.
    expect(await code(launch(mine, { ...launchInput(mine, 1, SHA1), appId: github.id }))).toBe("STUDIO_BINDING");
    expect(await code(launch(mine, { ...launchInput(mine, 1, SHA1), appId: "missing" }))).toBe("STUDIO_BINDING");
    // No secret, a wrong one, a stranger's agent, no agent key, an expired delegation.
    expect(await code(launch(mine, launchInput(mine, 1, SHA1), null as never))).toBe("STUDIO_BINDING");
    expect(await code(launch(mine, launchInput(mine, 1, SHA1), randomBytes(32).toString("hex")))).toBe("STUDIO_BINDING");
    expect(await code(launch(mine, launchInput(mine, 1, SHA1), mine.secret, { ...agent, address: STRANGER }))).toBe("STUDIO_BINDING");
    expect(await code(launch(mine, launchInput(mine, 1, SHA1), mine.secret, { ...agent, appKey: null }))).toBe("DELEGATION_MISSING");
    // Bad input.
    expect(await code(launch(mine, launchInput(mine, 1, SHA1, [{ name: "@acme/shop", version: "1.0.0" }])))).toBe("BAD_USER_INPUT");
    expect(await code(launch(mine, launchInput(mine, 1, SHA1, [])))).toBe("BAD_USER_INPUT");
    expect(await code(launch(mine, { ...launchInput(mine, 1, SHA1), versionNumber: 0 }))).toBe("BAD_USER_INPUT");
    expect(await code(launch(mine, { ...launchInput(mine, 1, SHA1), gitTag: "../x" }))).toBe("BAD_USER_INPUT");
    expect(await code(launch(mine, { ...launchInput(mine, 1, SHA1), sha: "main" }))).toBe("BAD_USER_INPUT");
    h.renown.delegation = null;
    expect(await code(launch(mine, launchInput(mine, 1, SHA1)))).toBe("DELEGATION_EXPIRED");
    h.renown.delegation = { expiresAt: FUTURE };

    // The other paths of the agent are bound the same way.
    const d = await launch(other, launchInput(other, 1, SHA1), other.secret, otherAgent);
    expect(await code(studioDeploymentFor(h.deps, agent, d.id, mine.secret))).toBe("STUDIO_BINDING");
    expect(await code(rollbackStudioVersion(h.deps, agent, d.id, mine.secret))).toBe("STUDIO_BINDING");
    expect(await code(setStudioProductDrive(h.deps, agent, other.app.id, "drive-1", mine.secret))).toBe("STUDIO_BINDING");
    // The owner-only paths keep refusing the agent's key (assertNotWorkload).
    expect(await code(rollbackApp(h.deps, agent, d.id))).toBe("FORBIDDEN");
    expect(await deploymentCount()).toBe(before + 1);

    // A deleted product is not launched.
    await h.db.updateTable("apps").set({ status: "DELETED" }).where("id", "=", mine.app.id).execute();
    expect(await code(launch(mine, launchInput(mine, 1, SHA1)))).toBe("STUDIO_BINDING");
  });

  it("first launch protects the App from the unlaunched-product sweep, even when it fails", async () => {
    const p = await seedProduct();
    const d = await launch(p, launchInput(p, 1, SHA1));
    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, d.id))!.status).toBe("FAILED");
    h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
    expect(await runUnlaunchedStudioAppSweepOnce(h.deps)).toBe(0);
    expect((await getApp(h.db, p.app.id))!.status).toBe("ACTIVE");
  });

  it("GraphQL: the agent launches, polls and rolls back with the secret header", async () => {
    const p = await seedProduct();
    const r = createResolvers(h.deps);
    const ctx = (headers: Record<string, string>) => ({
      user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: AGENT_KEY },
      headers,
    });
    const withSecret = ctx({ [STUDIO_SECRET_HEADER]: p.secret });
    const launched = await r.Mutation.launchStudioVersion(null, { input: launchInput(p, 1, SHA1) }, withSecret);
    expect(launched).toMatchObject({
      status: "PENDING",
      trigger: "STUDIO_LAUNCH",
      onBehalfOf: OWNER_DID,
      versionNumber: 1,
      actorDid: AGENT_KEY,
    });
    expect(await r.Query.studioDeployment(null, { id: launched.id }, withSecret)).toMatchObject({
      id: launched.id,
      status: "PENDING",
      error: null,
    });
    // Without the header the agent path refuses.
    await expect(r.Query.studioDeployment(null, { id: launched.id }, ctx({}))).rejects.toMatchObject({
      extensions: { code: "STUDIO_BINDING" },
    });
    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "READY");
    await runDeploymentWatcherOnce(h.deps);
    const back = await r.Mutation.rollbackStudioVersion(null, { deploymentId: launched.id }, withSecret);
    expect(back).toMatchObject({ status: "PENDING", trigger: "STUDIO_ROLLBACK", versionNumber: 1 });
    const app = await r.Mutation.setStudioProductDrive(null, { appId: p.app.id, driveId: "drive-1" }, withSecret);
    expect(app).toMatchObject({ productDriveId: "drive-1" });
  });
});

describe("rollbackStudioVersion (D20)", () => {
  it("agent cannot roll back to a FAILED deployment", async () => {
    const p = await seedProduct();
    const v1 = await launchToReady(p, launchInput(p, 1, SHA1));
    const v2 = await launch(p, launchInput(p, 2, SHA2));
    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, v2.id))!.status).toBe("FAILED");

    expect(await code(rollbackStudioVersion(h.deps, agent, v2.id, p.secret))).toBe("BAD_USER_INPUT");
    expect(await code(rollbackStudioVersion(h.deps, agent, "missing", p.secret))).toBe("NOT_FOUND");
    // A pending one is not a version that went live either.
    const pending = await launch(p, launchInput(p, 3, "3333333ccccccc"));
    expect(await code(rollbackStudioVersion(h.deps, agent, pending.id, p.secret))).toBe("BAD_USER_INPUT");

    // Version 1 went live: going back to it is a new deployment of its packages.
    const back = await rollbackStudioVersion(h.deps, agent, v1.id, p.secret);
    expect(back).toMatchObject({
      status: "PENDING",
      trigger: "STUDIO_ROLLBACK",
      actor_did: AGENT_KEY,
      on_behalf_of: OWNER_DID,
      version_number: 1,
      sha: SHA1,
      git_ref: "refs/tags/v1",
      packages: v1.packages,
    });
    // The newer pending launch gives way; nothing is deleted.
    expect((await getDeployment(h.db, pending.id))!.status).toBe("SUPERSEDED");
    expect((await getDeployment(h.db, v1.id))!.status).toBe("READY");
    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "READY");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, back.id))!.status).toBe("READY");
    expect(await envPackages(p.envId)).toStrictEqual(["@vetra-apps/my-shop@0.1.0"]);
  });
});

describe("a failed Studio launch puts the previous version back", () => {
  it("failed launch re-applies the previous versions", async () => {
    const p = await seedProduct();
    const v1 = await launchToReady(p, launchInput(p, 1, SHA1));
    const v2 = await launch(
      p,
      launchInput(p, 2, SHA2, [
        { name: "@vetra-apps/my-shop", version: "0.2.0" },
        { name: "@vetra-apps/my-shop-extra", version: "0.1.0" },
      ]),
    );
    await runDeploymentWatcherOnce(h.deps);
    expect(await envPackages(p.envId)).toStrictEqual([
      "@vetra-apps/my-shop-extra@0.1.0",
      "@vetra-apps/my-shop@0.2.0",
    ]);
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    const changed = await runDeploymentWatcherOnce(h.deps);

    const failed = (await getDeployment(h.db, v2.id))!;
    expect(failed).toMatchObject({ status: "FAILED", error: "environment deployment failed" });
    const restore = (await h.db
      .selectFrom("app_deployments")
      .selectAll()
      .where("actor_github", "=", RESTORE_ACTOR)
      .execute());
    expect(restore).toHaveLength(1);
    expect(changed).toStrictEqual([v2.id, restore[0].id]);
    expect(restore[0]).toMatchObject({
      status: "DEPLOYING",
      trigger: "STUDIO_ROLLBACK",
      version_number: 1,
      sha: SHA1,
      packages: v1.packages,
      on_behalf_of: OWNER_DID,
      actor_did: null,
    });
    // The env is back on version 1's packages; the one version 2 added is gone.
    expect(await envPackages(p.envId)).toStrictEqual(["@vetra-apps/my-shop@0.1.0"]);

    h.envs.setStatus(p.envId, "READY");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, restore[0].id))!.status).toBe("READY");
    // Once: the failed row keeps its reason and nothing more is restored.
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, v2.id))!.error).toBe("environment deployment failed");
    expect(await h.db.selectFrom("app_deployments").select("id").where("actor_github", "=", RESTORE_ACTOR).execute()).toHaveLength(1);
  });

  it("a launch the env rejects is put back at once; a failed first launch and a failed restore restore nothing", async () => {
    const p = await seedProduct();
    // First launch failing: there is no earlier version.
    const first = await launch(p, launchInput(p, 1, SHA1));
    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, first.id))!.status).toBe("FAILED");
    expect(await deploymentCount()).toBe(1);

    const v1 = await launchToReady(p, launchInput(p, 1, SHA1));
    // The reactor refuses the next launch's actions while they are applied.
    const execute = h.envs.execute.bind(h.envs);
    let refuse = true;
    h.envs.execute = async (id, actions) => {
      if (refuse && actions.some((a) => a.type === "ADD_PACKAGE")) {
        refuse = false;
        await execute(id, [actions[0]]);
        throw new Error("ADD_PACKAGE rejected: boom");
      }
      return execute(id, actions);
    };
    const v2 = await launch(p, launchInput(p, 2, SHA2));
    await runDeploymentWatcherOnce(h.deps);
    expect(await getDeployment(h.db, v2.id)).toMatchObject({ status: "FAILED", error: "ADD_PACKAGE rejected: boom" });
    const restores = await h.db.selectFrom("app_deployments").selectAll().where("actor_github", "=", RESTORE_ACTOR).execute();
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ version_number: 1, packages: v1.packages, status: "DEPLOYING" });
    expect(await envPackages(p.envId)).toStrictEqual(["@vetra-apps/my-shop@0.1.0"]);

    // The restore itself failing is left as it is (no restore of a restore).
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, restores[0].id))!.status).toBe("FAILED");
    expect(await h.db.selectFrom("app_deployments").select("id").where("actor_github", "=", RESTORE_ACTOR).execute()).toHaveLength(1);
  });

  it("a deployment superseded while the watcher looked stays SUPERSEDED", async () => {
    const p = await seedProduct();
    const v1 = await launch(p, launchInput(p, 1, SHA1));
    await runDeploymentWatcherOnce(h.deps);
    h.envs.setStatus(p.envId, "DEPLOYMENt_FAILED");
    // A newer deploy supersedes it between the watcher's read and its write.
    const getState = h.envs.getState.bind(h.envs);
    h.envs.getState = async (id) => {
      await h.db.updateTable("app_deployments").set({ status: "SUPERSEDED" }).where("id", "=", v1.id).execute();
      return getState(id);
    };
    expect(await runDeploymentWatcherOnce(h.deps)).toStrictEqual([]);
    expect((await getDeployment(h.db, v1.id))!.status).toBe("SUPERSEDED");
  });
});

describe("setStudioProductDrive (F7b)", () => {
  it("records the drive once and opens the live Connect on it", async () => {
    const p = await seedProduct();
    await h.envs.execute(p.envId, [
      setRuntimeConfig({ config: JSON.stringify({ connect: { branding: { appName: "Shop" } } }) }),
      approveChanges({}),
    ]);
    h.envs.setStatus(p.envId, "READY");
    const before = h.envs.executed.length;

    const app = await setStudioProductDrive(h.deps, agent, p.app.id, "drive-1", p.secret);
    expect(app.product_drive_id).toBe("drive-1");
    const state = (await h.envs.getState(p.envId))!;
    const switchboard = envUrls(state).switchboard!;
    expect(switchboard).toBe("https://my-shop-switchboard.vetra.io");
    expect(JSON.parse(state.runtimeConfig!)).toStrictEqual({
      connect: {
        branding: { appName: "Shop" },
        drives: { defaultDrives: [{ url: `${switchboard}/d/drive-1`, name: "My Shop" }] },
      },
    });
    expect(h.envs.executed.slice(before).map((e) => e.types)).toStrictEqual([
      ["SET_RUNTIME_CONFIG"],
      ["APPROVE_CHANGES"],
    ]);

    // The same drive again: nothing changes.
    expect((await setStudioProductDrive(h.deps, agent, p.app.id, "drive-1", p.secret)).product_drive_id).toBe("drive-1");
    expect(h.envs.executed.length).toBe(before + 2);
    // Another drive is refused.
    expect(await code(setStudioProductDrive(h.deps, agent, p.app.id, "drive-2", p.secret))).toBe("PRODUCT_DRIVE_SET");
    expect(await code(setStudioProductDrive(h.deps, agent, p.app.id, "bad id/x", p.secret))).toBe("BAD_USER_INPUT");
    expect((await getApp(h.db, p.app.id))!.product_drive_id).toBe("drive-1");
  });

  it("withDefaultDrive keeps other drives and replaces a corrupt config", () => {
    const drive = { url: "https://s/d/x", name: "X" };
    expect(withDefaultDrive(null, drive)).toBe(
      JSON.stringify({ connect: { drives: { defaultDrives: [drive] } } }),
    );
    expect(withDefaultDrive("{not json", drive)).toBe(
      JSON.stringify({ connect: { drives: { defaultDrives: [drive] } } }),
    );
    const other = { url: "https://s/d/y" };
    expect(
      JSON.parse(withDefaultDrive(JSON.stringify({ connect: { drives: { defaultDrives: [other] } } }), drive)!),
    ).toStrictEqual({ connect: { drives: { defaultDrives: [drive, other] } } });
    expect(withDefaultDrive(JSON.stringify({ connect: { drives: { defaultDrives: [drive] } } }), drive)).toBeNull();
  });
});

describe("owner and CI deployments record their trigger", () => {
  it("owner deployApp records trigger OWNER", async () => {
    const app = await seedActiveApp(h);
    const d = await deployApp(h.deps, owner, {
      appId: app.id,
      kind: "PRODUCTION",
      gitRef: "refs/heads/main",
      sha: "abcdef1234567",
      packages: [{ name: "@acme/shop", version: "1.0.0" }],
    });
    expect(d).toMatchObject({ trigger: "OWNER", on_behalf_of: OWNER_DID, actor_did: OWNER_DID, version_number: null });

    const ci = await deployAsCi(h.deps, claim("refs/heads/main"), {
      appId: app.id,
      kind: "PRODUCTION",
      gitRef: "refs/heads/main",
      sha: "abcdef1234567",
      packages: [{ name: "@acme/shop", version: "1.0.1" }],
    });
    expect(ci).toMatchObject({ trigger: "CI", actor_did: APP_DID, on_behalf_of: OWNER_DID });

    h.envs.setStatus(app.production_environment_id, "READY");
    await runDeploymentWatcherOnce(h.deps);
    const back = await rollbackApp(h.deps, owner, ci.id);
    expect(back).toMatchObject({ trigger: "OWNER", on_behalf_of: OWNER_DID, status: "DEPLOYING" });
  });

  it("the owner may roll a Studio product back in person; the version is kept", async () => {
    const p = await seedProduct();
    const v1 = await launchToReady(p, launchInput(p, 1, SHA1));
    const back = await rollbackApp(h.deps, owner, v1.id);
    expect(back).toMatchObject({ trigger: "OWNER", version_number: 1, on_behalf_of: OWNER_DID });
  });
});
