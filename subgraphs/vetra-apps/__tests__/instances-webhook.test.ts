import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSTALLATION,
  makeHarness,
  REPO_ID,
  seedActiveApp,
  type Harness,
} from "./harness.js";
import { seedRelease } from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { PR_CLOSED, reconcileInstancesOnce } from "../instances/reconciler.js";
import { handleGithubWebhook } from "../webhook.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({
      instances_enabled: true,
      registry_namespace: "acme",
      release_branches: '["next"]',
    })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, {
    version: "2.0.0-beta.0-next.1",
    run: 100,
    branch: "next",
  });
  await reconcileInstancesOnce(h.deps);
});
afterEach(async () => {
  await h.close();
});

const push = (ref: string, deleted: boolean) => {
  const body = JSON.stringify({
    ref,
    before: "1".repeat(40),
    after: deleted ? "0".repeat(40) : "2".repeat(40),
    deleted,
    commits: [],
    repository: { id: Number(REPO_ID), full_name: "acme/shop" },
    installation: { id: Number(INSTALLATION) },
  });
  return handleGithubWebhook(h.deps, {
    rawBody: Buffer.from(body),
    signature: `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`,
    event: "push",
  });
};

describe("push webhook — deleted branch", () => {
  it("marks the branch instance for removal", async () => {
    const res = await push("refs/heads/next", true);
    expect(res).toStrictEqual({
      status: 200,
      body: { flaggedApps: 0, removedInstances: 1 },
    });
    expect((await listInstances(h.db, appId))[0].removed_reason).toBe(
      "branch deleted",
    );
  });

  it("leaves instances alone for an ordinary push, a tag, or another branch", async () => {
    expect((await push("refs/heads/next", false)).body).toStrictEqual({
      flaggedApps: 0,
    });
    expect((await push("refs/tags/next", true)).body).toStrictEqual({
      flaggedApps: 0,
    });
    expect((await push("refs/heads/other", true)).body).toStrictEqual({
      flaggedApps: 0,
    });
    expect((await listInstances(h.db, appId))[0].removed_at).toBeNull();
  });

  it("never acts for an app with instances disabled", async () => {
    await h.db
      .updateTable("apps")
      .set({ instances_enabled: false })
      .where("id", "=", appId)
      .execute();
    expect((await push("refs/heads/next", true)).body).toStrictEqual({
      flaggedApps: 0,
    });
    expect((await listInstances(h.db, appId))[0].removed_at).toBeNull();
  });
});

const pullRequest = (action: string, pr: number, repoId = REPO_ID) => {
  const body = JSON.stringify({
    action,
    number: pr,
    pull_request: { number: pr },
    repository: { id: Number(repoId) },
    installation: { id: Number(INSTALLATION) },
  });
  return handleGithubWebhook(h.deps, {
    rawBody: Buffer.from(body),
    signature: `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`,
    event: "pull_request",
  });
};

describe("pull_request webhook — preview instances", () => {
  const preview = async () =>
    (await listInstances(h.db, appId)).find((r) => r.kind === "preview")!;

  beforeEach(async () => {
    await seedRelease(h, appId, { version: "1.5.0-pr.12.1", run: 200, pr: 12 });
    await reconcileInstancesOnce(h.deps);
  });

  it("removes a closed PR's preview, and a late build does not bring it back", async () => {
    const envId = (await preview()).environment_id!;
    expect(await pullRequest("closed", 12)).toStrictEqual({
      status: 200,
      body: { removedPreviews: 0, removedInstances: 1 },
    });
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toContain(envId);
    expect(await preview()).toMatchObject({
      status: "removed",
      removed_reason: PR_CLOSED,
    });
    await seedRelease(h, appId, { version: "1.5.0-pr.12.2", run: 300, pr: 12 });
    await reconcileInstancesOnce(h.deps);
    expect((await preview()).status).toBe("removed");
  });

  it("brings the preview back when the PR is reopened", async () => {
    await pullRequest("closed", 12);
    await reconcileInstancesOnce(h.deps);
    expect(await pullRequest("reopened", 12)).toStrictEqual({
      status: 200,
      body: { reopenedInstances: 1 },
    });
    await reconcileInstancesOnce(h.deps);
    expect((await preview()).status).toBe("updating");
  });

  it("leaves previews alone for another repository or PR", async () => {
    expect((await pullRequest("closed", 12, "999")).body).toStrictEqual({
      removedPreviews: 0,
    });
    expect((await pullRequest("closed", 13)).body).toStrictEqual({
      removedPreviews: 0,
    });
    expect((await pullRequest("reopened", 13)).status).toBe(204);
    expect((await preview()).removed_at).toBeNull();
  });

  it("refuses an unsigned delivery without touching the preview", async () => {
    const body = JSON.stringify({
      action: "closed",
      number: 12,
      repository: { id: Number(REPO_ID) },
    });
    const res = await handleGithubWebhook(h.deps, {
      rawBody: Buffer.from(body),
      signature: "sha256=00",
      event: "pull_request",
    });
    expect(res.status).toBe(401);
    expect((await preview()).removed_at).toBeNull();
  });
});
