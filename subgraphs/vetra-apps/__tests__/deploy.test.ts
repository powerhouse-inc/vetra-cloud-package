import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appDeploymentFor,
  deletePreview,
  deployApp,
  resolveImage,
  rollbackApp,
  updateApp,
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
  REPO_ID,
  admin,
  appIdentity,
  claim,
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
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

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

const SHA = "abcdef1234567890abcdef1234567890abcdef12";
const prod = (over: Partial<DeployAppInput> = {}): DeployAppInput => ({
  appId: app.id,
  kind: "PRODUCTION",
  gitRef: "refs/heads/main",
  sha: SHA,
  packages: [{ name: "@acme/shop", version: "1.2.0-main.7.abcdef1" }],
  ...over,
});
const preview = (
  pr: number,
  over: Partial<DeployAppInput> = {},
): DeployAppInput => ({
  appId: app.id,
  kind: "PREVIEW",
  prNumber: pr,
  gitRef: `refs/pull/${pr}/merge`,
  sha: SHA,
  packages: [{ name: "@acme/shop", version: `1.2.0-pr.${pr}.abcdef1` }],
  ...over,
});

describe("deployApp authorization (Review Focus 1)", () => {
  it("App identity with the production-branch claim deploys PRODUCTION", async () => {
    const d = await deployApp(
      h.deps,
      appIdentity,
      claim("refs/heads/main"),
      prod(),
    );
    expect(d).toMatchObject({
      status: "DEPLOYING",
      kind: "PRODUCTION",
      environment_id: app.production_environment_id,
      actor_did: appIdentity.appKey,
      actor_github: "octocat",
      git_ref: "refs/heads/main",
    });
  });

  it("a PR-branch token can never deploy PRODUCTION", async () => {
    expect(
      await code(
        deployApp(
          h.deps,
          appIdentity,
          claim("refs/pull/7/merge", { prNumber: 7 }),
          prod(),
        ),
      ),
    ).toBe("FORBIDDEN");
    // even when it lies about gitRef in the input
    expect(
      await code(
        deployApp(
          h.deps,
          appIdentity,
          claim("refs/pull/7/merge"),
          prod({ gitRef: "refs/heads/main" }),
        ),
      ),
    ).toBe("FORBIDDEN");
    // and a tag / other branch token is refused too
    expect(
      await code(
        deployApp(h.deps, appIdentity, claim("refs/tags/v1.0.0"), prod()),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        deployApp(h.deps, appIdentity, claim("refs/heads/dev"), prod()),
      ),
    ).toBe("FORBIDDEN");
    const env = await h.envs.getState(app.production_environment_id);
    expect(env?.packages).toStrictEqual([]);
    expect(
      await h.db.selectFrom("app_deployments").selectAll().execute(),
    ).toStrictEqual([]);
  });

  it("a PR token deploys only its own PR's preview", async () => {
    expect(
      await code(
        deployApp(h.deps, appIdentity, claim("refs/pull/7/merge"), preview(7)),
      ),
    ).toBe("OK");
    expect(
      await code(
        deployApp(h.deps, appIdentity, claim("refs/pull/7/merge"), preview(8)),
      ),
    ).toBe("FORBIDDEN");
    // a production token cannot deploy a PR preview either
    expect(
      await code(
        deployApp(h.deps, appIdentity, claim("refs/heads/main"), preview(9)),
      ),
    ).toBe("FORBIDDEN");
  });

  it("App identity without a vetra claim, or minted for another repo, is refused", async () => {
    expect(await code(deployApp(h.deps, appIdentity, null, prod()))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(
        deployApp(
          h.deps,
          appIdentity,
          claim("refs/heads/main", { repositoryId: "1" }),
          prod(),
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("an App identity acting for someone else is refused", async () => {
    expect(
      await code(
        deployApp(
          h.deps,
          { ...appIdentity, address: stranger.address },
          claim("refs/heads/main"),
          prod(),
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("the owner (manual redeploy) and admins may deploy without claims; strangers may not", async () => {
    expect(await code(deployApp(h.deps, owner, null, prod()))).toBe("OK");
    expect(await code(deployApp(h.deps, admin, null, prod()))).toBe("OK");
    expect(await code(deployApp(h.deps, stranger, null, prod()))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(deployApp(h.deps, owner, null, prod({ appId: "missing" }))),
    ).toBe("NOT_FOUND");
  });

  it("an App that is not ACTIVE cannot deploy", async () => {
    await h.db
      .updateTable("apps")
      .set({ status: "PENDING_IDENTITY" })
      .execute();
    expect(await code(deployApp(h.deps, owner, null, prod()))).toBe(
      "APP_NOT_ACTIVE",
    );
  });

  it("validates input", async () => {
    expect(
      await code(deployApp(h.deps, owner, null, prod({ sha: "nope" }))),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        deployApp(
          h.deps,
          owner,
          null,
          prod({ packages: [{ name: "Bad Name", version: "1" }] }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        deployApp(
          h.deps,
          owner,
          null,
          prod({ packages: [{ name: "a", version: "1 2" }] }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        deployApp(
          h.deps,
          owner,
          null,
          prod({
            packages: [
              { name: "a", version: "1" },
              { name: "a", version: "2" },
            ],
          }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(await code(deployApp(h.deps, owner, null, preview(0)))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      await code(
        deployApp(
          h.deps,
          owner,
          null,
          prod({ imageTag: "cr.vetra.io/other-project/app:sha-1" }),
        ),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("deployApp PRODUCTION", () => {
  it("dispatches exact package versions, the FUSION image and approves", async () => {
    const d = await deployApp(
      h.deps,
      owner,
      null,
      prod({ imageTag: "sha-abcdef123456" }),
    );
    expect(d.image_tag).toBe("cr.vetra.io/app-shop/app:sha-abcdef123456");
    const env = await h.envs.getState(app.production_environment_id);
    expect(env).toMatchObject({
      status: "CHANGES_APPROVED",
      packages: [
        {
          name: "@acme/shop",
          version: "1.2.0-main.7.abcdef1",
          registry: "https://registry.vetra.io",
        },
      ],
      fusion: { image: "cr.vetra.io/app-shop/app", autoUpdate: false },
    });
    expect(env!.services.find((s) => s.type === "FUSION")).toMatchObject({
      enabled: true,
      version: "sha-abcdef123456",
    });
  });

  it("wakes a sleeping env before deploying", async () => {
    h.envs.setStatus(app.production_environment_id, "STOPPED");
    const d = await deployApp(h.deps, owner, null, prod());
    expect(d.status).toBe("DEPLOYING");
    expect(h.envs.executed.at(-1)?.types[0]).toBe("WAKE_ENVIRONMENT");
    expect((await h.envs.getState(app.production_environment_id))?.status).toBe(
      "CHANGES_APPROVED",
    );
  });

  it("records FAILED when the environment is terminated", async () => {
    h.envs.setStatus(app.production_environment_id, "TERMINATING");
    const d = await deployApp(h.deps, owner, null, prod());
    expect(d.status).toBe("FAILED");
    expect(d.error).toMatch(/TERMINATING/);
  });

  it("a newer deployment supersedes older pending/deploying ones of the same env", async () => {
    const first = await deployApp(h.deps, owner, null, prod());
    const second = await deployApp(
      h.deps,
      owner,
      null,
      prod({ packages: [{ name: "@acme/shop", version: "1.2.1" }] }),
    );
    expect((await getDeployment(h.db, first.id))?.status).toBe("SUPERSEDED");
    expect((await getDeployment(h.db, second.id))?.status).toBe("DEPLOYING");
  });

  it("refuses when the production env is no longer linked to the App", async () => {
    await h.envs.execute(app.production_environment_id, [
      (
        await import("../../../document-models/vetra-cloud-environment/v1/index.js")
      ).clearAppLink({}),
    ]);
    expect(await code(deployApp(h.deps, owner, null, prod()))).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("deployApp PREVIEW", () => {
  it("creates a slim preview env on the first deploy and reuses it afterwards", async () => {
    const d1 = await deployApp(
      h.deps,
      appIdentity,
      claim("refs/pull/7/merge"),
      preview(7),
    );
    const p = await getPreview(h.db, app.id, 7);
    expect(p?.environment_id).toBe(d1.environment_id);
    const env = await h.envs.getState(p!.environment_id);
    expect(env).toMatchObject({
      owner: app.owner_address,
      label: "Shop PR #7",
      status: "CHANGES_APPROVED",
      defaultPackageRegistry: "https://registry.dev.vetra.io",
      app: {
        appId: app.id,
        role: "PREVIEW",
        prNumber: 7,
        gitRef: "refs/pull/7/merge",
        imageProject: "app-shop",
      },
      packages: [
        {
          name: "@acme/shop",
          version: "1.2.0-pr.7.abcdef1",
          registry: "https://registry.dev.vetra.io",
        },
      ],
    });
    h.envs.setStatus(p!.environment_id, "READY");
    const d2 = await deployApp(
      h.deps,
      appIdentity,
      claim("refs/pull/7/merge"),
      preview(7, { imageTag: "sha-111111111111" }),
    );
    expect(d2.environment_id).toBe(d1.environment_id);
    expect(await listPreviews(h.db, app.id)).toHaveLength(1);
  });

  it("copies production's non-secret FUSION env as the preview template", async () => {
    const { setFusionConfig } =
      await import("../../../document-models/vetra-cloud-environment/v1/index.js");
    await h.envs.execute(app.production_environment_id, [
      setFusionConfig({
        image: "cr.vetra.io/app-shop/web",
        env: [
          { name: "NEXT_PUBLIC_FLAG", value: "1", isSecret: false },
          { name: "API_KEY", value: "s", isSecret: true },
        ],
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
    ]);
    const d = await deployApp(
      h.deps,
      owner,
      null,
      preview(3, { imageTag: "sha-222222222222" }),
    );
    const env = await h.envs.getState(d.environment_id!);
    expect(env?.fusion).toStrictEqual({
      image: "cr.vetra.io/app-shop/web",
      env: [{ name: "NEXT_PUBLIC_FLAG", value: "1", isSecret: false }],
      autoUpdate: false,
      autoUpdateTagPattern: null,
    });
    expect(d.image_tag).toBe("cr.vetra.io/app-shop/web:sha-222222222222");
  });

  it("fails with PREVIEWS_DISABLED when previews are off", async () => {
    await updateApp(h.deps, owner, app.id, { previewsEnabled: false });
    expect(
      await code(
        deployApp(h.deps, appIdentity, claim("refs/pull/7/merge"), preview(7)),
      ),
    ).toBe("PREVIEWS_DISABLED");
  });

  it("evicts the least recently deployed preview at the limit", async () => {
    await updateApp(h.deps, owner, app.id, { previewLimit: 2 });
    const d1 = await deployApp(h.deps, owner, null, preview(1));
    await deployApp(h.deps, owner, null, preview(2));
    await deployApp(h.deps, owner, null, preview(1)); // PR 1 is now the most recent
    const d3 = await deployApp(h.deps, owner, null, preview(3));
    const prs = (await listPreviews(h.db, app.id)).map((p) => p.pr_number);
    expect(prs).toStrictEqual([1, 3]);
    expect(h.envs.deleted).toHaveLength(1);
    expect(h.envs.deleted).not.toContain(d1.environment_id);
    expect(h.envs.deleted).not.toContain(app.production_environment_id);
    expect(d3.status).toBe("DEPLOYING");
  });

  it("recreates a preview whose env document disappeared", async () => {
    const d1 = await deployApp(h.deps, owner, null, preview(4));
    await h.envs.delete(d1.environment_id!);
    const d2 = await deployApp(h.deps, owner, null, preview(4));
    expect(d2.environment_id).not.toBe(d1.environment_id);
    expect(d2.status).toBe("DEPLOYING");
  });
});

describe("preview deletion safety (Review Focus 2)", () => {
  it("never deletes a production or standalone env, even if a preview row points at it", async () => {
    const standalone = await h.envs.seedStandalone();
    for (const envId of [app.production_environment_id, standalone]) {
      await h.db
        .insertInto("app_previews")
        .values({
          app_id: app.id,
          pr_number: 99,
          environment_id: envId,
          git_ref: null,
          created_at: "x",
          last_deployed_at: "x",
        })
        .execute();
      await deletePreview(
        h.deps,
        app,
        (await getPreview(h.db, app.id, 99))!,
        "test",
      );
      expect(await getPreview(h.db, app.id, 99)).toBeNull();
    }
    expect(h.envs.deleted).toStrictEqual([]);
  });

  it("never deletes another App's preview", async () => {
    const other = await h.envs.seedStandalone();
    await h.envs.link(other, "another-app", "PREVIEW", 5);
    await h.db
      .insertInto("app_previews")
      .values({
        app_id: app.id,
        pr_number: 5,
        environment_id: other,
        git_ref: null,
        created_at: "x",
        last_deployed_at: "x",
      })
      .execute();
    await deletePreview(
      h.deps,
      app,
      (await getPreview(h.db, app.id, 5))!,
      "test",
    );
    expect(h.envs.deleted).toStrictEqual([]);
  });
});

describe("rollbackApp", () => {
  it("re-applies a READY deployment as a new one with actor rollback", async () => {
    const good = await deployApp(h.deps, owner, null, prod());
    await h.db
      .updateTable("app_deployments")
      .set({ status: "READY" })
      .where("id", "=", good.id)
      .execute();
    h.envs.setStatus(app.production_environment_id, "READY");
    await deployApp(
      h.deps,
      owner,
      null,
      prod({ packages: [{ name: "@acme/shop", version: "9.9.9" }] }),
    );
    h.envs.setStatus(app.production_environment_id, "READY");

    const rb = await rollbackApp(h.deps, owner, good.id);
    expect(rb).toMatchObject({
      actor_github: "rollback",
      status: "DEPLOYING",
      kind: "PRODUCTION",
    });
    const env = await h.envs.getState(app.production_environment_id);
    expect(env?.packages[0]?.version).toBe("1.2.0-main.7.abcdef1");
  });

  it("refuses non-READY sources, strangers and App identities", async () => {
    const d = await deployApp(h.deps, owner, null, prod());
    expect(await code(rollbackApp(h.deps, owner, d.id))).toBe("BAD_USER_INPUT");
    await h.db
      .updateTable("app_deployments")
      .set({ status: "READY" })
      .where("id", "=", d.id)
      .execute();
    expect(await code(rollbackApp(h.deps, stranger, d.id))).toBe("FORBIDDEN");
    // a CI token (e.g. from a PR) must not be able to move production
    expect(await code(rollbackApp(h.deps, appIdentity, d.id))).toBe(
      "FORBIDDEN",
    );
    expect(await code(rollbackApp(h.deps, owner, "missing"))).toBe("NOT_FOUND");
  });

  it("refuses to roll back a preview that is gone", async () => {
    const d = await deployApp(h.deps, owner, null, preview(5));
    await h.db
      .updateTable("app_deployments")
      .set({ status: "READY" })
      .where("id", "=", d.id)
      .execute();
    await deletePreview(
      h.deps,
      app,
      (await getPreview(h.db, app.id, 5))!,
      "closed",
    );
    await h.db
      .updateTable("app_deployments")
      .set({ status: "READY" })
      .where("id", "=", d.id)
      .execute();
    expect(await code(rollbackApp(h.deps, owner, d.id))).toBe("BAD_USER_INPUT");
  });
});

describe("appDeployment access", () => {
  it("owner and App identity can read; strangers cannot", async () => {
    const d = await deployApp(h.deps, owner, null, prod());
    expect((await appDeploymentFor(h.deps, appIdentity, d.id))?.id).toBe(d.id);
    expect((await appDeploymentFor(h.deps, owner, d.id))?.id).toBe(d.id);
    expect(await code(appDeploymentFor(h.deps, stranger, d.id))).toBe(
      "FORBIDDEN",
    );
    expect(await appDeploymentFor(h.deps, owner, "missing")).toBeNull();
  });
});

describe("resolveImage", () => {
  it("accepts bare tags and full references inside the App's project only", async () => {
    const a = (await getApp(h.db, app.id))!;
    expect(resolveImage(a, null, null)).toBeNull();
    expect(resolveImage(a, "sha-1", null)).toStrictEqual({
      repository: "cr.vetra.io/app-shop/app",
      tag: "sha-1",
    });
    expect(
      resolveImage(a, "cr.vetra.io/app-shop/web/next:v1", null),
    ).toStrictEqual({
      repository: "cr.vetra.io/app-shop/web/next",
      tag: "v1",
    });
    expect(() => resolveImage(a, "cr.vetra.io/app-shop/web", null)).toThrow();
    expect(() => resolveImage(a, "bad tag", null)).toThrow();
    expect(() => resolveImage(a, "docker.io/app-shop/web:1", null)).toThrow();
    expect(REPO_ID).toBe(a.repository_id);
  });
});
