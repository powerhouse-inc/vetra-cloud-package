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
import { reconcileInstancesOnce } from "../instances/reconciler.js";
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
