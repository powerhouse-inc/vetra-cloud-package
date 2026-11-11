import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, owner, seedActiveApp, type Harness } from "./harness.js";
import { digest, seedRelease } from "./instances-fixtures.js";
import { instanceLabel } from "../instances/host.js";
import { listInstances, type InstanceRow } from "../instances/repo.js";
import {
  PR_CLOSED,
  PR_FORK,
  reconcileInstancesOnce,
} from "../instances/reconciler.js";
import { listPreviews } from "../repo.js";
import { deployApp } from "../service.js";

let h: Harness;
let appId: string;
let slug: string;
let baseDocs: number;

beforeEach(async () => {
  h = await makeHarness();
  const app = await seedActiveApp(h);
  appId = app.id;
  slug = app.slug;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  baseDocs = h.envs.docs.size;
});
afterEach(async () => {
  await h.close();
});

const DAY = 86_400_000;
const previews = async () =>
  (await listInstances(h.db, appId)).filter((r) => r.kind === "preview");
const live = async () => (await previews()).filter((r) => !r.removed_at);
const byPr = async (pr: number) =>
  (await previews()).find((r) => r.pr === pr) as InstanceRow;
const fusionVersion = async (envId: string) =>
  (await h.envs.getState(envId))!.services.find((s) => s.type === "FUSION")!
    .version;
const prBuild = (pr: number, n: number, run: number, c = "a") =>
  seedRelease(h, appId, {
    version: `1.5.0-pr.${pr}.${n}`,
    run,
    pr,
    digest: digest(c),
    createdAt: h.clock.now.toISOString(),
  });
const setApp = (patch: Record<string, unknown>) =>
  h.db.updateTable("apps").set(patch).where("id", "=", appId).execute();

describe("preview instances", () => {
  it("creates a preview for a PR's build, pinned by digest, linked to the PR", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const row = await byPr(12);
    expect(row).toMatchObject({
      kind: "preview",
      name: "pr-12",
      branch: null,
      host: instanceLabel(appId, slug, "pr-12"),
      status: "updating",
      target_version: "1.5.0-pr.12.1",
    });
    const state = (await h.envs.getState(row.environment_id!))!;
    expect(state.app).toMatchObject({
      appId,
      role: "PREVIEW",
      prNumber: 12,
      gitRef: "refs/pull/12/head",
    });
    expect(await fusionVersion(row.environment_id!)).toBe(
      `1.5.0-pr.12.1@${digest("a")}`,
    );
    h.envs.setStatus(row.environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(12)).status).toBe("ready");
    // A PR build is never a branch instance.
    expect((await listInstances(h.db, appId, "branch")).length).toBe(0);
  });

  it("follows the PR's newest build by run, not by arrival", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await prBuild(12, 3, 300, "c");
    await prBuild(12, 2, 200, "b");
    await reconcileInstancesOnce(h.deps);
    const row = await byPr(12);
    expect(row.target_version).toBe("1.5.0-pr.12.3");
    expect(await fusionVersion(row.environment_id!)).toBe(
      `1.5.0-pr.12.3@${digest("c")}`,
    );
  });

  it("keeps at most preview_limit previews, removing the oldest-updated first", async () => {
    await setApp({ preview_limit: 2 });
    await prBuild(1, 1, 100);
    await prBuild(2, 1, 200);
    await prBuild(3, 1, 300);
    await reconcileInstancesOnce(h.deps);
    expect((await live()).map((r) => r.pr).sort()).toEqual([2, 3]);
    expect(h.envs.docs.size - baseDocs).toBe(2);

    // PR 1 gets a new build: it is now among the newest two; PR 2 goes, before PR 1 is created.
    const pr2Env = (await byPr(2)).environment_id!;
    const create = h.envs.create.bind(h.envs);
    let liveAtCreate = -1;
    h.envs.create = async () => {
      liveAtCreate = h.envs.docs.size - baseDocs;
      return create();
    };
    await prBuild(1, 2, 400, "d");
    await reconcileInstancesOnce(h.deps);
    expect(liveAtCreate).toBe(1);
    expect(h.envs.deleted).toContain(pr2Env);
    expect((await live()).map((r) => r.pr).sort()).toEqual([1, 3]);
    expect(await byPr(2)).toMatchObject({
      status: "removed",
      environment_id: null,
    });
  });

  it("removes a preview after preview_ttl_days without a build, and brings it back on a new one", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const host = (await byPr(12)).host;
    h.advance(7 * DAY + 60_000);
    await reconcileInstancesOnce(h.deps); // removed: tombstone
    expect(await byPr(12)).toMatchObject({ status: "removed" });
    expect(h.envs.docs.size).toBe(baseDocs);
    await reconcileInstancesOnce(h.deps); // no candidate any more: purged
    expect(await previews()).toEqual([]);

    await prBuild(12, 2, 200, "b");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(12)).toMatchObject({ status: "updating", host });
  });

  it("brings an evicted preview back on its old host", async () => {
    await setApp({ preview_limit: 1 });
    await prBuild(1, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const host = (await byPr(1)).host;
    await prBuild(2, 1, 200);
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(1)).status).toBe("removed");
    await prBuild(1, 2, 300, "c");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(1)).toMatchObject({
      status: "updating",
      host,
      removed_at: null,
    });
  });

  it("makes no previews when previews are off, and removes the ones there are", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await setApp({ previews_enabled: false });
    await reconcileInstancesOnce(h.deps);
    expect(await live()).toEqual([]);
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("removes previews when the app opts out", async () => {
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await setApp({ instances_enabled: false });
    await reconcileInstancesOnce(h.deps);
    expect(await live()).toEqual([]);
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("does nothing for an app that has not opted in", async () => {
    await setApp({ instances_enabled: false });
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect(await previews()).toEqual([]);
    expect(h.github.calls.getPullRequest).toBeUndefined();
  });
});

describe("preview instances — the PR on GitHub", () => {
  it("creates nothing for a closed PR, and does not ask GitHub again", async () => {
    h.github.prStates.set(12, "closed");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await prBuild(12, 2, 200, "b");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(12)).toMatchObject({
      status: "removed",
      removed_reason: PR_CLOSED,
      environment_id: null,
    });
    expect(h.envs.docs.size).toBe(baseDocs);
    expect(h.github.calls.getPullRequest).toHaveLength(1);
  });

  it("treats a PR GitHub does not know (404) as closed", async () => {
    h.github.prStates.set(12, "missing");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(12)).removed_reason).toBe(PR_CLOSED);
  });

  it("creates nothing for a PR from a fork", async () => {
    h.github.prHeadRepos.set(12, "999");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(12)).toMatchObject({
      status: "removed",
      removed_reason: PR_FORK,
    });
    expect(h.envs.docs.size).toBe(baseDocs);
  });

  it("waits while GitHub is unreachable, then creates the preview", async () => {
    h.github.prStates.set(12, "error");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    expect(await previews()).toEqual([]);
    h.github.prStates.set(12, "open");
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(12)).status).toBe("updating");
  });

  it("does not count a closed PR against the limit", async () => {
    await setApp({ preview_limit: 1 });
    h.github.prStates.set(2, "closed");
    await prBuild(1, 1, 100);
    await prBuild(2, 1, 200);
    await reconcileInstancesOnce(h.deps);
    expect((await live()).map((r) => r.pr)).toEqual([1]);
  });

  it("forgets a closed PR's tombstone once its builds are past the TTL", async () => {
    h.github.prStates.set(12, "closed");
    await prBuild(12, 1, 100);
    await reconcileInstancesOnce(h.deps);
    h.advance(7 * DAY + 60_000);
    await reconcileInstancesOnce(h.deps);
    expect(await previews()).toEqual([]);
  });
});

describe("preview instances — when GitHub cannot say", () => {
  it("keeps a running preview while a newer PR's check fails", async () => {
    await setApp({ preview_limit: 1 });
    await prBuild(1, 1, 100);
    await reconcileInstancesOnce(h.deps);
    const env = (await byPr(1)).environment_id!;
    h.envs.setStatus(env, "READY");
    h.github.prStates.set(2, "error");
    await prBuild(2, 1, 200);
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(1)).toMatchObject({
      status: "ready",
      removed_at: null,
      environment_id: env,
    });
    expect(h.envs.deleted).not.toContain(env);
    expect(await byPr(2)).toBeUndefined();
  });

  it("asks GitHub once per pass while it is down", async () => {
    await setApp({ preview_limit: 3 });
    for (const pr of [1, 2, 3, 4, 5]) {
      h.github.prStates.set(pr, "error");
      await prBuild(pr, 1, pr * 100);
    }
    await reconcileInstancesOnce(h.deps);
    expect(h.github.calls.getPullRequest).toHaveLength(1);
    await reconcileInstancesOnce(h.deps);
    expect(h.github.calls.getPullRequest).toHaveLength(2);
    expect(await previews()).toEqual([]);
  });

  it("asks GitHub at most twice the limit per pass", async () => {
    await setApp({ preview_limit: 1 });
    for (const pr of [1, 2, 3, 4, 5]) {
      h.github.prStates.set(pr, "closed");
      await prBuild(pr, 1, pr * 100);
    }
    await reconcileInstancesOnce(h.deps);
    expect(h.github.calls.getPullRequest).toHaveLength(2);
  });

  it("marks an evicted preview's tombstone closed, reason and all", async () => {
    await setApp({ preview_limit: 1 });
    await prBuild(1, 1, 100);
    await reconcileInstancesOnce(h.deps);
    await prBuild(2, 1, 200);
    await reconcileInstancesOnce(h.deps);
    expect((await byPr(1)).status).toBe("removed");
    await setApp({ preview_limit: 2 });
    h.github.prStates.set(1, "closed");
    await reconcileInstancesOnce(h.deps);
    expect(await byPr(1)).toMatchObject({
      status: "removed",
      reason: PR_CLOSED,
      removed_reason: PR_CLOSED,
    });
  });
});

describe("old previews", () => {
  const oldPreview = (pr: number) =>
    deployApp(h.deps, owner, {
      appId,
      kind: "PREVIEW",
      prNumber: pr,
      gitRef: `refs/pull/${pr}/merge`,
      sha: "abcdef1234567890abcdef1234567890abcdef12",
      packages: [{ name: "@acme/shop", version: `1.2.0-pr.${pr}.abcdef1` }],
    });
  const productionReady = async () => {
    const app = await h.db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", appId)
      .executeTakeFirstOrThrow();
    h.envs.setStatus(app.production_environment_id, "READY");
  };

  it("are deleted once the app is on instances", async () => {
    await setApp({ instances_enabled: false });
    await productionReady();
    const d = await oldPreview(7);
    await setApp({ instances_enabled: true });
    await reconcileInstancesOnce(h.deps);
    expect(await listPreviews(h.db, appId)).toEqual([]);
    expect(h.envs.deleted).toContain(d.environment_id);
  });

  it("stay for an app that is not on instances", async () => {
    await setApp({ instances_enabled: false });
    await productionReady();
    await oldPreview(7);
    await reconcileInstancesOnce(h.deps);
    expect(await listPreviews(h.db, appId)).toHaveLength(1);
  });
});
