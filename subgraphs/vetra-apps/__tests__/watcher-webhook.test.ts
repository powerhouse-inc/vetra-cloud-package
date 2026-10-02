import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deployApp,
  PREVIEW_COMMENT_MARKER,
  type DeployAppInput,
} from "../service.js";
import {
  getApp,
  getDeployment,
  getPreview,
  listPreviews,
  type AppRow,
} from "../repo.js";
import {
  deploymentApplied,
  githubEnvironmentName,
  reportDeploymentToGithub,
  runDeploymentWatcherOnce,
  runPreviewSweepOnce,
} from "../watcher.js";
import { handleGithubWebhook, verifyGithubSignature } from "../webhook.js";
import {
  INSTALLATION,
  REPO,
  REPO_ID,
  makeHarness,
  owner,
  seedActiveApp,
  type Harness,
} from "./harness.js";

let h: Harness;
let app: AppRow;
beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
  h.envs.setStatus(app.production_environment_id, "READY");
});
afterEach(async () => {
  await h.close();
});

const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const input = (over: Partial<DeployAppInput> = {}): DeployAppInput => ({
  appId: app.id,
  kind: "PRODUCTION",
  gitRef: "refs/heads/main",
  sha: SHA,
  packages: [{ name: "@acme/shop", version: "1.0.0" }],
  ...over,
});
const preview = (pr: number): DeployAppInput =>
  input({ kind: "PREVIEW", prNumber: pr, gitRef: `refs/pull/${pr}/merge` });

describe("deployment watcher", () => {
  it("moves DEPLOYING → READY once the env is READY with the deployed versions", async () => {
    const d = await deployApp(
      h.deps,
      owner,
      null,
      input({ imageTag: "sha-aaaaaaaaaaaa" }),
    );
    expect(await runDeploymentWatcherOnce(h.deps)).toStrictEqual([]); // env still CHANGES_APPROVED
    h.envs.setStatus(app.production_environment_id, "READY");
    expect(await runDeploymentWatcherOnce(h.deps)).toStrictEqual([d.id]);
    expect((await getDeployment(h.db, d.id))?.status).toBe("READY");
  });

  it("stays DEPLOYING while the READY env does not carry the versions yet", async () => {
    const state = (await h.envs.getState(app.production_environment_id))!;
    expect(
      deploymentApplied(state, {
        packages: '[{"name":"x","version":"1"}]',
        image_tag: null,
      }),
    ).toBe(false);
    expect(
      deploymentApplied(
        { ...state, packages: [{ name: "x", version: "1", registry: "r" }] },
        {
          packages: '[{"name":"x","version":"1"}]',
          image_tag: "cr.vetra.io/app-shop/app:sha-1",
        },
      ),
    ).toBe(false);
  });

  it("marks FAILED on DEPLOYMENt_FAILED", async () => {
    const d = await deployApp(h.deps, owner, null, input());
    h.envs.setStatus(app.production_environment_id, "DEPLOYMENt_FAILED");
    await runDeploymentWatcherOnce(h.deps);
    expect(await getDeployment(h.db, d.id)).toMatchObject({
      status: "FAILED",
      error: "environment deployment failed",
    });
  });

  it("marks FAILED after the 15 minute timeout", async () => {
    const d = await deployApp(h.deps, owner, null, input());
    h.clock.now = new Date(h.clock.now.getTime() + 16 * 60_000);
    await runDeploymentWatcherOnce(h.deps);
    expect(await getDeployment(h.db, d.id)).toMatchObject({
      status: "FAILED",
      error: /timed out/,
    });
  });

  it("marks FAILED when the env is gone and fails stuck PENDING rows", async () => {
    const d = await deployApp(h.deps, owner, null, preview(3));
    await h.envs.delete(d.environment_id!);
    await h.db
      .insertInto("app_deployments")
      .values({
        id: "stuck",
        app_id: app.id,
        environment_id: app.production_environment_id,
        kind: "PRODUCTION",
        pr_number: null,
        git_ref: "refs/heads/main",
        sha: SHA,
        packages: "[]",
        image_tag: null,
        status: "PENDING",
        actor_did: null,
        actor_github: null,
        run_url: null,
        error: null,
        github_deployment_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      })
      .execute();
    await runDeploymentWatcherOnce(h.deps);
    expect((await getDeployment(h.db, d.id))?.error).toBe(
      "environment no longer exists",
    );
    expect((await getDeployment(h.db, "stuck"))?.status).toBe("FAILED");
  });
});

describe("preview TTL sweeper", () => {
  it("deletes previews whose last deploy is older than previewTtlDays", async () => {
    const old = await deployApp(h.deps, owner, null, preview(1));
    h.clock.now = new Date(h.clock.now.getTime() + 6 * 86_400_000);
    await deployApp(h.deps, owner, null, preview(2));
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 86_400_000);
    expect(await runPreviewSweepOnce(h.deps)).toBe(1);
    expect(
      (await listPreviews(h.db, app.id)).map((p) => p.pr_number),
    ).toStrictEqual([2]);
    expect(h.envs.deleted).toStrictEqual([old.environment_id]);
    expect((await getDeployment(h.db, old.id))?.status).toBe("SUPERSEDED");
  });
});

describe("GitHub feedback", () => {
  it("creates a GitHub deployment, reports its status and upserts the sticky PR comment", async () => {
    const d = await deployApp(h.deps, owner, null, preview(7));
    await reportDeploymentToGithub(h.deps, d.id);
    expect(h.github.calls.createDeployment[0]).toEqual([
      INSTALLATION,
      REPO,
      expect.objectContaining({
        ref: SHA,
        environment: "preview-pr-7",
        transient: true,
      }),
    ]);
    expect(h.github.calls.createDeploymentStatus[0][3]).toMatchObject({
      state: "in_progress",
      environment: "preview-pr-7",
      environmentUrl: expect.stringMatching(
        /^https:\/\/sub-env-\d+-connect\.vetra\.io$/,
      ),
    });
    const [, , pr, marker, body] = h.github.calls.upsertPrComment[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(pr).toBe(7);
    expect(marker).toBe(PREVIEW_COMMENT_MARKER);
    expect(body.startsWith(PREVIEW_COMMENT_MARKER)).toBe(true);
    expect(body).toContain("Switchboard");
    expect(body).toContain("`@acme/shop@1.0.0`");
    // second report reuses the GitHub deployment
    await reportDeploymentToGithub(h.deps, d.id);
    expect(h.github.calls.createDeployment).toHaveLength(1);
    expect(h.github.calls.createDeploymentStatus).toHaveLength(2);
  });

  it("names environments production / preview-pr-<n>", () => {
    expect(githubEnvironmentName({ kind: "PRODUCTION", pr_number: null })).toBe(
      "production",
    );
    expect(githubEnvironmentName({ kind: "PREVIEW", pr_number: 4 })).toBe(
      "preview-pr-4",
    );
  });

  it("is a no-op without GitHub config or for disconnected Apps", async () => {
    const d = await deployApp(h.deps, owner, null, input());
    await reportDeploymentToGithub({ ...h.deps, github: null }, d.id);
    await h.db.updateTable("apps").set({ status: "DISCONNECTED" }).execute();
    await reportDeploymentToGithub(h.deps, d.id);
    expect(h.github.calls.createDeployment).toBeUndefined();
  });
});

const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("GitHub webhook (Review Focus 3)", () => {
  const closed = (pr: number) =>
    JSON.stringify({
      action: "closed",
      number: pr,
      pull_request: { number: pr },
      repository: { id: Number(REPO_ID) },
    });

  it("401s a missing or wrong signature without side effects", async () => {
    await deployApp(h.deps, owner, null, preview(7));
    const body = closed(7);
    for (const signature of [
      null,
      "sha256=00",
      sign("wrong", body),
      "sha1=abc",
    ]) {
      const res = await handleGithubWebhook(h.deps, {
        rawBody: Buffer.from(body),
        signature,
        event: "pull_request",
      });
      expect(res.status).toBe(401);
    }
    expect(await getPreview(h.db, app.id, 7)).not.toBeNull();
    expect(h.envs.deleted).toStrictEqual([]);
  });

  it("503s when the webhook secret is not configured", async () => {
    const res = await handleGithubWebhook(
      { ...h.deps, cfg: { ...h.deps.cfg, webhookSecret: null } },
      { rawBody: Buffer.from("{}"), signature: null, event: "ping" },
    );
    expect(res.status).toBe(503);
  });

  it("pull_request.closed deletes that PR's preview and supersedes its deployments", async () => {
    const d = await deployApp(h.deps, owner, null, preview(7));
    await deployApp(h.deps, owner, null, preview(8));
    const body = closed(7);
    const res = await handleGithubWebhook(h.deps, {
      rawBody: Buffer.from(body),
      signature: sign("whsec", body),
      event: "pull_request",
    });
    expect(res).toStrictEqual({ status: 200, body: { removedPreviews: 1 } });
    expect(h.envs.deleted).toStrictEqual([d.environment_id]);
    expect((await getDeployment(h.db, d.id))?.status).toBe("SUPERSEDED");
    expect(await getPreview(h.db, app.id, 8)).not.toBeNull();
  });

  it("installation.deleted disconnects the Apps and removes their previews", async () => {
    await deployApp(h.deps, owner, null, preview(7));
    const body = JSON.stringify({
      action: "deleted",
      installation: { id: Number(INSTALLATION) },
    });
    const res = await handleGithubWebhook(h.deps, {
      rawBody: Buffer.from(body),
      signature: sign("whsec", body),
      event: "installation",
    });
    expect(res.status).toBe(200);
    expect((await getApp(h.db, app.id))?.status).toBe("DISCONNECTED");
    expect(await listPreviews(h.db, app.id)).toStrictEqual([]);
    expect(h.envs.deleted).toHaveLength(1);
    expect(h.envs.deleted).not.toContain(app.production_environment_id);
    const conns = await h.db
      .selectFrom("github_deploy_connections")
      .selectAll()
      .execute();
    expect(conns).toStrictEqual([]);
  });

  it("installation_repositories.removed disconnects the App of that repository", async () => {
    const body = JSON.stringify({
      action: "removed",
      installation: { id: Number(INSTALLATION) },
      repositories_removed: [{ id: Number(REPO_ID) }],
    });
    await handleGithubWebhook(h.deps, {
      rawBody: Buffer.from(body),
      signature: sign("whsec", body),
      event: "installation_repositories",
    });
    expect((await getApp(h.db, app.id))?.status).toBe("DISCONNECTED");
  });

  it("answers 204 to everything else and 400 to bad JSON", async () => {
    const ping = JSON.stringify({ zen: "hi" });
    expect(
      (
        await handleGithubWebhook(h.deps, {
          rawBody: Buffer.from(ping),
          signature: sign("whsec", ping),
          event: "ping",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await handleGithubWebhook(h.deps, {
          rawBody: Buffer.from("{"),
          signature: sign("whsec", "{"),
          event: "push",
        })
      ).status,
    ).toBe(400);
  });

  it("verifyGithubSignature is exact", () => {
    const body = Buffer.from("payload");
    expect(verifyGithubSignature("s", body, sign("s", "payload"))).toBe(true);
    expect(verifyGithubSignature("s", body, sign("s", "payload!"))).toBe(false);
    expect(verifyGithubSignature("s", body, undefined)).toBe(false);
  });
});
