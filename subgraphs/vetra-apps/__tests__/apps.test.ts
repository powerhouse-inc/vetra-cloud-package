import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appRegistryCredentials,
  appForOwner,
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
  detectRepoToolchain,
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
  fakeGithub,
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

  it("lists repositories with the USER's token, never the installation's (I5)", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const repos = await githubDeployRepositories(h.deps, owner, INSTALLATION);
    expect(repos.map((r) => r.id)).toStrictEqual([REPO_ID, "4343"]);
    expect(h.github.calls.listUserInstallationRepos?.[0]).toStrictEqual([
      "user-token",
      INSTALLATION,
    ]);
  });

  it("stores the user token encrypted, refreshes it when expired, and asks to reconnect when refresh fails", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    const row = await h.db
      .selectFrom("github_deploy_connections")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain("user-token");
    expect(JSON.stringify(row)).not.toContain("refresh-1");
    h.clock.now = new Date(h.clock.now.getTime() + 9 * 3600_000);
    await githubDeployRepositories(h.deps, owner, INSTALLATION);
    expect(h.github.calls.refreshUserToken?.[0]).toStrictEqual(["refresh-1"]);
    expect(h.github.calls.listUserInstallationRepos?.at(-1)?.[0]).toBe(
      "user-token-2",
    );
    // the rotated refresh token was stored: a second expiry refreshes with refresh-2 (fails here)
    h.clock.now = new Date(h.clock.now.getTime() + 9 * 3600_000);
    expect(
      await code(githubDeployRepositories(h.deps, owner, INSTALLATION)),
    ).toBe("GITHUB_NOT_CONNECTED");
  });

  it("connecting needs VETRA_APPS_ENCRYPTION_KEY (the user token is stored)", async () => {
    expect(
      await code(
        connectGithubDeploy(
          { ...h.deps, cfg: testConfig({ encryptionKey: null }) },
          owner,
          "code",
        ),
      ),
    ).toBe("SERVICE_NOT_CONFIGURED");
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
      `https://www.renown.id/?app=${encodeURIComponent(APP_DID)}&returnUrl=${encodeURIComponent(`https://vetra.io/user/apps/${app.id}?identity=1`)}&expiresInDays=365`,
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

  it("never hands out the studio app's reserved slug", async () => {
    // No row holds "vetra-studio" (the studio app has none), yet an app named
    // "Vetra Studio" must not take it: a trusted document carrying it would
    // compete with the studio app.
    await connectGithubDeploy(h.deps, owner, "code");
    const first = await createApp(h.deps, owner, {
      name: "Vetra Studio",
      installationId: INSTALLATION,
      repositoryId: REPO_ID,
    });
    expect(first.slug).toBe("vetra-studio-2");
    const second = await createApp(h.deps, owner, {
      name: "vetra-studio",
      installationId: INSTALLATION,
      repositoryId: "4343",
    });
    expect(second.slug).toBe("vetra-studio-3");
    expect([first.slug, second.slug]).not.toContain("vetra-studio");
  });

  it("refuses a repo the installation can reach but the user cannot (I5)", async () => {
    await connectGithubDeploy(h.deps, owner, "code");
    // "9999" exists in the org installation but is not in the user's list
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "squat",
          installationId: INSTALLATION,
          repositoryId: "9999",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(h.harbor.projects).toStrictEqual([]);
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
    ).toBe("FORBIDDEN");
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
    h.renown.delegation = { expiresAt: "2027-10-02T12:00:00.000Z" };
    const active = await confirmAppIdentity(h.deps, owner, app.id);
    expect(active.status).toBe("ACTIVE");
    expect(active.identity_expires_at).toBe("2027-10-02T12:00:00.000Z");
  });

  it("confirmAppIdentity re-checks: a renewed credential updates the expiry, none left → PENDING_IDENTITY", async () => {
    const app = await seedActiveApp(h);
    h.renown.delegation = { expiresAt: "2028-01-01T00:00:00.000Z" };
    expect(
      (await confirmAppIdentity(h.deps, owner, app.id)).identity_expires_at,
    ).toBe("2028-01-01T00:00:00.000Z");
    h.renown.delegation = null; // expired or revoked
    const pending = await confirmAppIdentity(h.deps, owner, app.id);
    expect(pending.status).toBe("PENDING_IDENTITY");
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

describe("deleteApp (C1/C2: soft delete)", () => {
  it("keeps the row as DELETED, hides it, and keeps the production link so the site stays up", async () => {
    const app = await seedActiveApp(h);
    await deleteApp(h.deps, owner, app.id, false);
    const row = await getApp(h.deps.db, app.id);
    expect(row?.status).toBe("DELETED");
    expect(row?.harbor_robot_secret_enc).toBe("");
    // production env keeps its link (FUSION image project stays allowed)
    const env = await h.envs.getState(app.production_environment_id);
    expect(env?.app).toMatchObject({ appId: app.id, role: "PRODUCTION" });
    expect(h.envs.deleted).toStrictEqual([]);
    // CI is cut off: robot and workload identity deleted
    expect(h.harbor.deletedRobots).toStrictEqual([row?.harbor_robot_id]);
    expect(h.renown.deleted).toStrictEqual([APP_DID]);
    // hidden from the owner, visible to admins
    expect(await myApps(h.deps, owner)).toStrictEqual([]);
    expect(await code(appForOwner(h.deps, owner, app.id))).toBe("NOT_FOUND");
    expect(
      (await appForOwner(h.deps, admin, app.id, { includeDeleted: true }))
        .status,
    ).toBe("DELETED");
    expect(await code(updateApp(h.deps, owner, app.id, { name: "x" }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(deleteApp(h.deps, owner, app.id, false))).toBe(
      "NOT_FOUND",
    );
    expect(await code(appRegistryCredentials(h.deps, owner, app.id))).toBe(
      "NOT_FOUND",
    );
    expect(
      await code(ciRegistryCredentials(h.deps, ciIdentity(null), app.id)),
    ).toBe("NOT_FOUND");
  });

  it("deletes the production env when deleteEnvironments is true", async () => {
    const app = await seedActiveApp(h);
    await deleteApp(h.deps, owner, app.id, true);
    expect(h.envs.deleted).toStrictEqual([app.production_environment_id]);
    expect((await getApp(h.deps.db, app.id))?.status).toBe("DELETED");
  });

  it("create → delete → create with the same name gets a new slug and Harbor project", async () => {
    const first = await seedActiveApp(h, "Shop");
    await deleteApp(h.deps, owner, first.id, false);
    const second = await createApp(h.deps, owner, {
      name: "Shop",
      installationId: INSTALLATION,
      repositoryId: REPO_ID,
    });
    expect(second.slug).toBe("shop-2");
    expect(second.harbor_project).toBe("app-shop-2");
    expect(h.harbor.projects).toStrictEqual(["app-shop", "app-shop-2"]);
  });

  it("a pre-existing Harbor project app-<slug> is never reused: next suffix", async () => {
    h.harbor.existing.add("app-shop");
    h.harbor.existing.add("app-shop-2");
    const app = await seedActiveApp(h, "Shop");
    expect(app.slug).toBe("shop-3");
    expect(app.harbor_project).toBe("app-shop-3");
  });

  it("gives up after a bounded number of Harbor conflicts", async () => {
    h.harbor.existing.add("app-shop");
    for (let i = 2; i <= 30; i++) h.harbor.existing.add(`app-shop-${i}`);
    await connectGithubDeploy(h.deps, owner, "code");
    expect(
      await code(
        createApp(h.deps, owner, {
          name: "Shop",
          installationId: INSTALLATION,
          repositoryId: REPO_ID,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });
});

describe("slugify", () => {
  it("kebab-cases and strips accents/symbols", () => {
    expect(slugify("Ça va? My  App__2")).toBe("ca-va-my-app-2");
    expect(slugify("!!!")).toBe("app");
  });
});

describe("detectRepoToolchain", () => {
  const gh = () => fakeGithub();

  it("reads bun from bun.lock, not the pnpm house default", async () => {
    const g = gh();
    g.files.set("package.json", "{}");
    g.files.set("bun.lock", "");
    expect(await detectRepoToolchain(g, "i1", "o/r")).toEqual({
      packageManager: "bun",
      declaresPackageManager: false,
    });
  });

  it("prefers the pnpm lockfile when several are present", async () => {
    const g = gh();
    g.files.set("package.json", '{"packageManager":"pnpm@9.1.0"}');
    g.files.set("pnpm-lock.yaml", "");
    g.files.set("package-lock.json", "");
    expect(await detectRepoToolchain(g, "i1", "o/r")).toEqual({
      packageManager: "pnpm",
      declaresPackageManager: true,
    });
  });

  it("reports no package manager when the repo ships no package.json", async () => {
    // A Dockerfile-only app: the workflow must not try to install anything.
    const g = gh();
    g.files.set("Dockerfile", "FROM scratch");
    expect(await detectRepoToolchain(g, "i1", "o/r")).toEqual({
      packageManager: null,
      declaresPackageManager: false,
    });
  });

  it("falls back to pnpm for a package.json with no lockfile", async () => {
    const g = gh();
    g.files.set("package.json", "{}");
    expect((await detectRepoToolchain(g, "i1", "o/r")).packageManager).toBe("pnpm");
  });

  it("survives an unparseable package.json", async () => {
    const g = gh();
    g.files.set("package.json", "{ not json");
    g.files.set("yarn.lock", "");
    expect(await detectRepoToolchain(g, "i1", "o/r")).toEqual({
      packageManager: "yarn",
      declaresPackageManager: false,
    });
  });
});
