import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appRegistryCredentials,
  ciRegistryCredentials,
  confirmAppIdentity,
  connectGithubDeploy,
  createApp,
  deleteApp,
  githubDeployAppInfo,
  githubDeployRepositories,
  myApps,
  myGithubDeployInstallations,
  openAppSetupPullRequest,
  renownAuthorizeUrl,
  slugify,
  updateApp,
} from "../service.js";
import { getApp } from "../repo.js";
import {
  APP_DID,
  INSTALLATION,
  OWNER,
  REPO,
  REPO_ID,
  admin,
  appIdentity,
  ciIdentity,
  makeHarness,
  owner,
  seedActiveApp,
  stranger,
  testConfig,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

describe("GitHub connection", () => {
  it("keeps only installations of the Vetra Deploy app", async () => {
    const out = await connectGithubDeploy(h.deps, owner, "code");
    expect(out).toStrictEqual([
      {
        installationId: INSTALLATION,
        accountLogin: "acme",
        accountType: "Organization",
      },
    ]);
    expect(await myGithubDeployInstallations(h.deps, stranger)).toStrictEqual(
      [],
    );
  });

  it("is idempotent", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    await connectGithubDeploy(h.deps, owner, "code");
    expect(await myGithubDeployInstallations(h.deps, owner)).toHaveLength(1);
  });

  it("maps a failed OAuth exchange to BAD_USER_INPUT", async () => {
    expect(await code(connectGithubDeploy(h.deps, owner, "bad"))).toBe(
      "BAD_USER_INPUT",
    );
  });

  it("lists repositories only for a connected installation", async () => {
    expect(
      await code(githubDeployRepositories(h.deps, owner, INSTALLATION)),
    ).toBe("GITHUB_NOT_CONNECTED");
    await connectGithubDeploy(h.deps, owner, "code");
    expect(
      await githubDeployRepositories(h.deps, owner, INSTALLATION),
    ).toHaveLength(2);
    expect(
      await code(githubDeployRepositories(h.deps, stranger, INSTALLATION)),
    ).toBe("GITHUB_NOT_CONNECTED");
  });

  it("describes the GitHub App (install + authorize URLs)", () => {
    expect(githubDeployAppInfo(h.deps)).toStrictEqual({
      slug: "vetra-deploy",
      installUrl: "https://github.com/apps/vetra-deploy/installations/new",
      authorizeUrl:
        "https://github.com/login/oauth/authorize?client_id=Iv1.client",
    });
  });
});

describe("createApp", () => {
  it("creates Harbor project + robot, Renown identity and a new production env", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const app = await createApp(h.deps, owner, {
      name: "My Shop!",
      installationId: INSTALLATION,
      repositoryId: REPO_ID,
    });
    expect(app).toMatchObject({
      slug: "my-shop",
      status: "PENDING_IDENTITY",
      repository_full_name: REPO,
      production_branch: "main",
      harbor_project: "app-my-shop",
      identity_did: APP_DID,
      previews_enabled: true,
      preview_limit: 5,
      preview_ttl_days: 7,
    });
    expect(app.harbor_robot_secret_enc).not.toContain("robot-secret");
    expect(h.harbor.projects).toStrictEqual(["app-my-shop"]);
    expect(h.renown.registered).toStrictEqual([
      {
        repositoryId: REPO_ID,
        repository: REPO,
        productionBranch: "main",
        ownerAddress: OWNER,
        chainId: 1,
      },
    ]);
    const env = await h.envs.getState(app.production_environment_id);
    expect(env).toMatchObject({
      owner: OWNER,
      label: "My Shop!",
      status: "CHANGES_APPROVED",
      defaultPackageRegistry: "https://registry.vetra.io",
      app: {
        appId: app.id,
        role: "PRODUCTION",
        imageProject: "app-my-shop",
        prNumber: null,
      },
    });
    expect(env!.services.map((s) => s.type)).toStrictEqual([
      "SWITCHBOARD",
      "CONNECT",
    ]);
    expect(renownAuthorizeUrl(h.deps, app)).toBe(
      `https://www.renown.id/?app=${encodeURIComponent(APP_DID)}&returnUrl=${encodeURIComponent(`https://vetra.io/user/apps/${app.id}?identity=1`)}`,
    );
  });

  it("attaches an existing standalone env the caller owns (and re-approves a READY one)", async () => {
    const envId = await h.envs.seedStandalone();
    await connectGithubDeploy(h.deps, owner, "code");
    const app = await createApp(h.deps, owner, {
      name: "Shop",
      installationId: INSTALLATION,
      repositoryId: REPO_ID,
      productionEnvironmentId: envId,
    });
    expect(app.production_environment_id).toBe(envId);
    const env = await h.envs.getState(envId);
    expect(env?.app).toMatchObject({ appId: app.id, role: "PRODUCTION" });
    expect(env?.status).toBe("CHANGES_APPROVED");
    expect(h.envs.docs.size).toBe(1); // no new env document
  });

  it("refuses to attach an env of another owner or one already linked", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const foreign = await h.envs.seedStandalone(
      "0xdddddddddddddddddddddddddddddddddddddddd",
    );
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "x",
          installationId: INSTALLATION,
          repositoryId: REPO_ID,
          productionEnvironmentId: foreign,
        }),
      ),
    ).toBe("FORBIDDEN");
    const linked = await h.envs.seedStandalone();
    await h.envs.link(linked, "other-app", "PRODUCTION");
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "x",
          installationId: INSTALLATION,
          repositoryId: REPO_ID,
          productionEnvironmentId: linked,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "x",
          installationId: INSTALLATION,
          repositoryId: REPO_ID,
          productionEnvironmentId: "missing",
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("makes slugs unique (-2, -3 …)", async () => {
    await seedActiveApp(h, "Shop");
    const second = await createApp(h.deps, owner, {
      name: "shop",
      installationId: INSTALLATION,
      repositoryId: "4343",
    });
    expect(second.slug).toBe("shop-2");
    expect(second.harbor_project).toBe("app-shop-2");
  });

  it("refuses a second App on the same repository, a foreign repo and an unconnected installation", async () => {
    await seedActiveApp(h);
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "again",
          installationId: INSTALLATION,
          repositoryId: REPO_ID,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "nope",
          installationId: INSTALLATION,
          repositoryId: "1",
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        createApp(h.deps, stranger, {
          name: "x",
          installationId: INSTALLATION,
          repositoryId: REPO_ID,
        }),
      ),
    ).toBe("GITHUB_NOT_CONNECTED");
  });

  it("validates name and production branch", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const base = { installationId: INSTALLATION, repositoryId: REPO_ID };
    expect(await code(createApp(h.deps, owner, { ...base, name: "  " }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      await code(
        createApp(h.deps, owner, {
          ...base,
          name: "x",
          productionBranch: "bad..branch",
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  it("fails with SERVICE_NOT_CONFIGURED when Harbor / Renown / GitHub / key are missing", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const input = {
      name: "x",
      installationId: INSTALLATION,
      repositoryId: REPO_ID,
    };
    for (const patch of [
      { harbor: null },
      { renown: null },
      { github: null },
    ] as const) {
      expect(await code(createApp({ ...h.deps, ...patch }, owner, input))).toBe(
        "SERVICE_NOT_CONFIGURED",
      );
    }
    expect(
      await code(
        createApp(
          { ...h.deps, cfg: testConfig({ encryptionKey: null }) },
          owner,
          input,
        ),
      ),
    ).toBe("SERVICE_NOT_CONFIGURED");
    expect(() =>
      githubDeployAppInfo({ ...h.deps, cfg: testConfig({ github: null }) }),
    ).toThrow(/not configured/);
  });
});

describe("App identity + settings", () => {
  it("confirmAppIdentity activates only once the delegation exists", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const app = await createApp(h.deps, owner, {
      name: "Shop",
      installationId: INSTALLATION,
      repositoryId: REPO_ID,
    });
    expect((await confirmAppIdentity(h.deps, owner, app.id)).status).toBe(
      "PENDING_IDENTITY",
    );
    h.renown.delegated = true;
    expect((await confirmAppIdentity(h.deps, owner, app.id)).status).toBe(
      "ACTIVE",
    );
  });

  it("updateApp validates limits and syncs the production branch to Renown", async () => {
    const app = await seedActiveApp(h);
    const updated = await updateApp(h.deps, owner, app.id, {
      name: "Shop 2",
      previewLimit: 3,
      previewTtlDays: 14,
      previewsEnabled: false,
      productionBranch: "release",
    });
    expect(updated).toMatchObject({
      name: "Shop 2",
      preview_limit: 3,
      preview_ttl_days: 14,
      previews_enabled: false,
      production_branch: "release",
    });
    expect(h.renown.updated).toStrictEqual([
      { did: APP_DID, patch: { productionBranch: "release" } },
    ]);
    expect(
      await code(updateApp(h.deps, owner, app.id, { previewLimit: 0 })),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(updateApp(h.deps, owner, app.id, { previewTtlDays: 365 })),
    ).toBe("BAD_USER_INPUT");
    expect(await code(updateApp(h.deps, owner, app.id, { name: "" }))).toBe(
      "BAD_USER_INPUT",
    );
  });

  it("owner-level calls: owner + admin allowed; strangers and App identities refused", async () => {
    const app = await seedActiveApp(h);
    expect(
      await code(updateApp(h.deps, admin, app.id, { name: "by admin" })),
    ).toBe("OK");
    expect(await code(updateApp(h.deps, stranger, app.id, { name: "x" }))).toBe(
      "FORBIDDEN",
    );
    // A CI token (even a production one) cannot edit, delete or open PRs.
    expect(
      await code(
        updateApp(h.deps, appIdentity, app.id, { previewsEnabled: true }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(deleteApp(h.deps, appIdentity, app.id, true))).toBe(
      "FORBIDDEN",
    );
    expect(await code(myApps(h.deps, appIdentity))).toBe("FORBIDDEN");
    expect(await code(updateApp(h.deps, owner, "missing", {}))).toBe(
      "NOT_FOUND",
    );
    expect((await myApps(h.deps, owner)).map((a) => a.id)).toStrictEqual([
      app.id,
    ]);
    expect(await myApps(h.deps, stranger)).toStrictEqual([]);
  });

  it("appRegistryCredentials: owner via GraphQL, App identity only via the CI path", async () => {
    const app = await seedActiveApp(h);
    const expected = {
      registry: "cr.vetra.io",
      project: "app-shop",
      username: "robot$app-shop+vetra-deploy-abc123",
      password: "robot-secret",
    };
    expect(await appRegistryCredentials(h.deps, owner, app.id)).toStrictEqual(
      expected,
    );
    expect(
      await ciRegistryCredentials(h.deps, ciIdentity(null), app.id),
    ).toStrictEqual(expected);
    expect(
      await code(appRegistryCredentials(h.deps, appIdentity, app.id)),
    ).toBe("FORBIDDEN");
    expect(await code(appRegistryCredentials(h.deps, stranger, app.id))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(
        ciRegistryCredentials(
          h.deps,
          {
            ...ciIdentity(null),
            address: "0x1111111111111111111111111111111111111111",
          },
          app.id,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("opens the setup PR with the workflow for this App", async () => {
    const app = await seedActiveApp(h);
    expect(await openAppSetupPullRequest(h.deps, owner, app.id)).toBe(
      `https://github.com/${REPO}/pull/9`,
    );
    const [installationId, repo, input] = h.github.calls
      .openPullRequestWithFile[0] as [
      string,
      string,
      { branch: string; path: string; content: string },
    ];
    expect([installationId, repo, input.branch, input.path]).toStrictEqual([
      INSTALLATION,
      REPO,
      "vetra/setup",
      ".github/workflows/vetra.yml",
    ]);
    expect(input.content).toContain(`app-id: ${app.id}`);
    expect(input.content).toContain("id-token: write");
  });
});

describe("deleteApp", () => {
  it("clears the production link and keeps the env unless asked to delete it", async () => {
    const app = await seedActiveApp(h);
    await deleteApp(h.deps, owner, app.id, false);
    expect(await getApp(h.deps.db, app.id)).toBeNull();
    const env = await h.envs.getState(app.production_environment_id);
    expect(env?.app ?? null).toBeNull();
    expect(h.renown.deleted).toStrictEqual([APP_DID]);
  });

  it("deletes the production env when deleteEnvironments is true", async () => {
    const app = await seedActiveApp(h);
    await deleteApp(h.deps, owner, app.id, true);
    expect(h.envs.deleted).toStrictEqual([app.production_environment_id]);
  });
});

describe("slugify", () => {
  it("kebab-cases and strips accents/symbols", () => {
    expect(slugify("Ça va? My  App__2")).toBe("ca-va-my-app-2");
    expect(slugify("!!!")).toBe("app");
  });
});
