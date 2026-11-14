import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEnvironmentIds } from "../repo.js";
import { mapApp } from "../resolvers.js";
import { deleteApp, deployApp, NO_DEPLOY_ENV, rollbackApp } from "../service.js";
import { makeHarness, owner, seedActiveApp, type Harness } from "./harness.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(() => h.close());

/** A publish-only App (spec 2026-11-14): no production environment. */
async function makePublishOnly(h: Harness, appId: string) {
  await h.db
    .updateTable("apps")
    .set({ production_environment_id: null })
    .where("id", "=", appId)
    .execute();
}

const sha = "a".repeat(40);
const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: { message: string; extensions: { code: string } }) => e,
  );

describe("an app without a production environment (publish-only)", () => {
  it("refuses deploys with NO_DEPLOY_ENV", async () => {
    const app = await seedActiveApp(h);
    await makePublishOnly(h, app.id);
    const err = await failure(
      deployApp(h.deps, owner, {
        appId: app.id,
        kind: "PRODUCTION",
        sha,
        gitRef: "refs/heads/main",
        packages: [],
      }),
    );
    expect(err.extensions.code).toBe("BAD_USER_INPUT");
    expect(err.message).toBe(NO_DEPLOY_ENV);
    expect(NO_DEPLOY_ENV).toBe(
      "This app publishes releases; it has no deploy environment",
    );
  });

  it("refuses rollbacks with NO_DEPLOY_ENV", async () => {
    const app = await seedActiveApp(h);
    const now = new Date().toISOString();
    await h.db
      .insertInto("app_deployments")
      .values({
        id: "dep-1",
        app_id: app.id,
        environment_id: "gone",
        kind: "PRODUCTION",
        pr_number: null,
        git_ref: "refs/heads/main",
        sha,
        packages: "[]",
        image_tag: null,
        status: "READY",
        actor_did: null,
        actor_github: null,
        run_url: null,
        error: null,
        github_deployment_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await makePublishOnly(h, app.id);
    const err = await failure(rollbackApp(h.deps, owner, "dep-1"));
    expect(err.message).toBe(NO_DEPLOY_ENV);
  });

  it("deletes the app without touching any environment", async () => {
    const app = await seedActiveApp(h);
    await makePublishOnly(h, app.id);
    const before = h.envs.deleted.length;
    expect(await deleteApp(h.deps, owner, app.id, true)).toBe(true);
    expect(h.envs.deleted.length).toBe(before);
  });

  it("resolves no production URLs", async () => {
    const app = await seedActiveApp(h);
    await makePublishOnly(h, app.id);
    const row = await h.db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", app.id)
      .executeTakeFirstOrThrow();
    const json = mapApp(h.deps, row);
    expect(json.productionEnvironmentId).toBeNull();
    expect(await json.productionUrls()).toStrictEqual({
      app: null,
      connect: null,
      switchboard: null,
    });
  });
});

describe("appEnvironmentIds", () => {
  it("lists the production env, and nothing for a publish-only app", async () => {
    const app = await seedActiveApp(h);
    expect(await appEnvironmentIds(h.db, app.id)).toStrictEqual([
      app.production_environment_id,
    ]);
    await makePublishOnly(h, app.id);
    expect(await appEnvironmentIds(h.db, app.id)).toStrictEqual([]);
  });
});
