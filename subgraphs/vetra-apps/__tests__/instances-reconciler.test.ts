import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  REPO_ID,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { instanceLabel } from "../instances/host.js";
import { listInstances } from "../instances/repo.js";
import {
  markBranchDeleted,
  reconcileInstancesOnce,
} from "../instances/reconciler.js";
import { UPDATE_TIMEOUT_MS } from "../instances/status.js";

let h: Harness;
let appId: string;
let slug: string;
/** Environments the app had before any instance (its production one). */
let baseDocs: number;

async function setup(harness: Promise<Harness>) {
  h = await harness;
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({
      instances_enabled: true,
      registry_namespace: "acme",
      release_branches: '["next"]',
    })
    .where("id", "=", appId)
    .execute();
  baseDocs = h.envs.docs.size;
}

beforeEach(async () => {
  await setup(makeHarness());
});
afterEach(async () => {
  await h.close();
});

const instances = () => listInstances(h.db, appId);
const one = async () => (await instances())[0];
const fusionVersion = async (envId: string) =>
  (await h.envs.getState(envId))!.services.find((s) => s.type === "FUSION")!
    .version;
const label = (branch: string, suffix = "") =>
  instanceLabel(appId, slug, branch, suffix);

describe("reconcileInstancesOnce — branch instances", () => {
  it("does nothing for an app that has not opted in", async () => {
    await h.db
      .updateTable("apps")
      .set({ instances_enabled: false })
      .where("id", "=", appId)
      .execute();
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect(await instances()).toEqual([]);
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("does nothing while the kill switch is off", async () => {
    await h.close();
    await setup(
      makeHarness(
        testConfig({ instances: { enabled: false, labelSuffix: "" } }),
      ),
    );
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect(await instances()).toEqual([]);
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("creates one instance per release branch, pinned by digest, then reports ready", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const row = await one();
    expect(row).toMatchObject({
      kind: "branch",
      name: "main",
      host: label("main"),
      status: "updating",
      target_version: "1.5.0-main.1",
    });
    expect(row.update_started_at).not.toBeNull();
    const state = (await h.envs.getState(row.environment_id!))!;
    expect(state.status).toBe("CHANGES_APPROVED");
    expect(state.genericSubdomain).toBe(label("main"));
    expect(state.app).toMatchObject({
      appId,
      role: "PREVIEW",
      gitRef: "refs/heads/main",
    });
    expect(await fusionVersion(row.environment_id!)).toBe(
      `1.5.0-main.1@${digest("a")}`,
    );
    expect(state.fusion!.image).toBe(`cr.vetra.io/acme/${slug}`);

    h.envs.setStatus(row.environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "ready",
      running_version: "1.5.0-main.1",
      running_digest: digest("a"),
    });
  });

  it("ends the host in the staging suffix when one is configured", async () => {
    await h.close();
    await setup(
      makeHarness(
        testConfig({ instances: { enabled: true, labelSuffix: "-stg" } }),
      ),
    );
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect((await one()).host).toBe(label("main", "-stg"));
  });

  it("follows the branch's newest build", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus((await one()).environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    const firstStart = Date.parse((await one()).update_started_at!);

    await seedRelease(h, appId, {
      version: "1.5.0-main.2",
      run: 200,
      digest: digest("b"),
    });
    h.advance(60_000);
    await reconcileInstancesOnce(h.deps);
    const row = await one();
    expect(row).toMatchObject({
      status: "updating",
      target_version: "1.5.0-main.2",
    });
    expect(Date.parse(row.update_started_at!)).toBeGreaterThan(
      firstStart + 60_000,
    );
    expect(await fusionVersion(row.environment_id!)).toBe(
      `1.5.0-main.2@${digest("b")}`,
    );
  });

  it("goes back to the running digest when an update fails, and does not retry it", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);

    await seedRelease(h, appId, {
      version: "1.5.0-main.2",
      run: 200,
      digest: digest("b"),
    });
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus(envId, "DEPLOYMENt_FAILED");
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "failed",
      reason: "the deployment failed",
      failed_digest: digest("b"),
      running_digest: digest("a"),
    });
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);

    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    expect(await fusionVersion(envId)).toBe(`1.5.0-main.1@${digest("a")}`);
    expect((await one()).status).toBe("failed");

    // A newer build is tried again.
    await seedRelease(h, appId, {
      version: "1.5.0-main.3",
      run: 300,
      digest: digest("c"),
    });
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "updating",
      target_version: "1.5.0-main.3",
    });
  });

  it("fails an update that never gets ready", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    h.advance(UPDATE_TIMEOUT_MS + 1000);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "failed",
      reason: "not ready after 20 minutes",
    });
  });

  it("shows a slept environment as stopped and wakes it for a new target", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    h.envs.setStatus(envId, "STOPPED");
    await reconcileInstancesOnce(h.deps);
    expect((await one()).status).toBe("stopped");
    await seedRelease(h, appId, {
      version: "1.5.0-main.2",
      run: 200,
      digest: digest("b"),
    });
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("CHANGES_APPROVED");
  });

  it("recreates an environment that was deleted out of band", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const first = (await one()).environment_id!;
    await h.envs.delete(first);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      environment_id: null,
      status: "pending",
    });
    await reconcileInstancesOnce(h.deps);
    const second = (await one()).environment_id!;
    expect(second).not.toBe(first);
    expect((await one()).host).toBe(label("main"));
  });

  it("never writes to an environment a licence manages", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.envs.manage(envId);
    const before = h.envs.executed.length;
    await seedRelease(h, appId, {
      version: "1.5.0-main.2",
      run: 200,
      digest: digest("b"),
    });
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.executed.length).toBe(before);
    expect((await one()).status).toBe("failed");
  });

  it("never deletes a licensed environment when its instance is removed", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.envs.manage(envId);
    await h.db
      .updateTable("apps")
      .set({ instances_enabled: false })
      .where("id", "=", appId)
      .execute();
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toEqual([]);
    expect(await h.envs.getState(envId)).not.toBeNull();
  });

  it("keeps going when one instance fails, and logs it", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await seedRelease(h, appId, {
      version: "2.0.0-beta.0-next.1",
      run: 101,
      branch: "next",
    });
    await reconcileInstancesOnce(h.deps);
    const [main, next] = await instances();
    // The main environment stops being a PREVIEW: its update throws.
    await h.envs.link(main.environment_id!, appId, "PRODUCTION");
    await seedRelease(h, appId, {
      version: "1.5.0-main.2",
      run: 200,
      digest: digest("b"),
    });
    h.envs.setStatus(next.environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    const rows = await instances();
    expect(rows.find((r) => r.name === "next")!.status).toBe("ready");
    expect(rows.find((r) => r.name === "main")!.reason).toMatch(
      /not .*instance/,
    );
    expect(h.deps.logger.warn).toHaveBeenCalled();
  });

  it("removes the instance when its branch stops being a release branch", async () => {
    await seedRelease(h, appId, {
      version: "2.0.0-beta.0-next.1",
      run: 100,
      branch: "next",
    });
    await reconcileInstancesOnce(h.deps);
    const envId = (await one()).environment_id!;
    await h.db
      .updateTable("apps")
      .set({ release_branches: "[]" })
      .where("id", "=", appId)
      .execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toContain(envId);
    expect(await instances()).toEqual([]);
  });

  it("removes every instance when the app opts out", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    await h.db
      .updateTable("apps")
      .set({ instances_enabled: false })
      .where("id", "=", appId)
      .execute();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await instances()).toEqual([]);
    expect(h.envs.deleted).toHaveLength(1);
  });

  it("keeps a deleted branch removed until a newer build comes from it", async () => {
    await seedRelease(h, appId, {
      version: "2.0.0-beta.0-next.1",
      run: 100,
      branch: "next",
    });
    await reconcileInstancesOnce(h.deps);
    expect(await markBranchDeleted(h.deps, REPO_ID, "next")).toBe(1);
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "removed",
      environment_id: null,
    });
    expect(h.envs.docs.size).toBe(baseDocs);

    await seedRelease(h, appId, {
      version: "2.0.0-beta.0-next.2",
      run: 200,
      branch: "next",
      digest: digest("b"),
    });
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "updating",
      host: label("next"),
    });
  });

  it("fails the instance, creating nothing, when its host is taken", async () => {
    h.deps.subdomainTaken = async (s) => s === label("main");
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "failed",
      host: null,
      environment_id: null,
    });
    expect((await one()).reason).toContain(label("main"));
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("records a lost race for the host on the instance", async () => {
    // Another row claims the label between the check and the write.
    h.deps.subdomainTaken = async (s) => {
      await h.db
        .insertInto("instances")
        .values({
          id: "other",
          app_id: "other-app",
          kind: "branch",
          name: "main",
          host: s,
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        })
        .execute();
      return false;
    };
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    expect(await one()).toMatchObject({
      status: "failed",
      host: null,
      environment_id: null,
    });
    expect((await one()).reason).toContain("taken");
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("owns the environment as the app's owner, with the owner as ADMINS", async () => {
    await seedRelease(h, appId, { version: "1.5.0-main.1", run: 100 });
    await reconcileInstancesOnce(h.deps);
    const s = (await h.envs.getState((await one()).environment_id!))!;
    expect(s.owner).toBe(OWNER);
    expect(s.fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(OWNER);
  });
});
