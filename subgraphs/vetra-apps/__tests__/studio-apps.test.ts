import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectGithubDeploy,
  createStudioApp,
  type CreateStudioAppInput,
} from "../service.js";
import {
  addPackage,
  approveChanges,
  setOwnerOrg,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import {
  INSTALLATION,
  ORG,
  OWNER,
  makeHarness,
  owner,
  stranger,
  type Harness,
} from "./harness.js";
import type { Caller } from "../auth.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  // The owner's GitHub connection: installation 77 on the "acme" org.
  await connectGithubDeploy(h.deps, owner, "code");
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

const create = (
  input: Omit<CreateStudioAppInput, "installationId"> & {
    installationId?: string;
  },
  caller: Caller = owner,
) =>
  createStudioApp(h.deps, caller, {
    installationId: INSTALLATION,
    ...input,
  });

async function seedStudio(address = OWNER) {
  const id = await h.envs.seedStandalone(address);
  await h.envs.execute(id, [
    addPackage({
      packageName: "vetra",
      version: "0.0.1-dev.27",
      registry: "https://registry.dev.vetra.io",
    }),
    approveChanges({}),
  ]);
  return id;
}

/** Nothing made: no repository, Harbor project, identity or row. */
async function expectNothingLeft() {
  expect(h.github.calls.createRepoAsUser ?? []).toHaveLength(0);
  expect(h.harbor.projects).toStrictEqual([]);
  expect(h.renown.registered).toStrictEqual([]);
  expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(0);
}

describe("createStudioApp", () => {
  it("creates the repo in the user's connected org with the workflow and variable, the App, and links the studio", async () => {
    const studio = await seedStudio();
    const app = await create({ name: "My Shop", studioEnvironmentId: studio });
    const repoId = "9001"; // the fake GitHub's first repository
    expect(app).toMatchObject({
      slug: "my-shop",
      status: "PENDING_IDENTITY",
      installation_id: INSTALLATION,
      repository_id: repoId,
      repository_full_name: "acme/my-shop",
      studio_environment_id: studio,
      // The fake Renown mints one DID per repository id.
      identity_did: `did:key:zDnaeRepo${repoId}`,
    });
    // Created with the caller's user token, in the connection's account.
    expect(h.github.calls.createRepoAsUser[0].slice(0, 3)).toStrictEqual([
      "user-token",
      { login: "acme", type: "Organization" },
      "my-shop",
    ]);
    // An all-repositories installation already covers the new repo.
    expect(h.github.calls.addRepoToInstallation ?? []).toHaveLength(0);
    expect(h.github.calls.setRepoVariable[0]).toStrictEqual([
      INSTALLATION,
      "acme/my-shop",
      "VETRA_APP_ID",
      app.id,
    ]);
    const [inst, repo, file] = h.github.calls.commitFile[0] as [
      string,
      string,
      { path: string; content: string; message: string },
    ];
    expect(inst).toBe(INSTALLATION);
    expect(repo).toBe("acme/my-shop");
    expect(file.path).toBe(".github/workflows/vetra.yml");
    expect(file.content).toContain(`app-id: ${app.id}`);
    expect(file.message).toContain("[skip ci]");
    // The studio env is NOT app-linked (CI must never deploy into it).
    expect((await h.envs.getState(studio))!.app).toBeNull();
    expect(
      (await h.envs.getState(app.production_environment_id))!.app,
    ).toMatchObject({ appId: app.id, role: "PRODUCTION" });
  });

  // Review Focus 1
  it("refuses another wallet's installation with GITHUB_NOT_CONNECTED and creates nothing", async () => {
    const studio = await seedStudio();
    // The stranger's connection, to installation 555.
    await connectGithubDeploy(h.deps, stranger, "code");
    await h.db
      .updateTable("github_deploy_connections")
      .set({ installation_id: "555", account_login: "evil-corp" })
      .where("owner_address", "=", stranger.address)
      .execute();
    expect(
      await code(
        create({
          name: "A",
          studioEnvironmentId: studio,
          installationId: "555",
        }),
      ),
    ).toBe("GITHUB_NOT_CONNECTED");
    expect(
      h.github.calls.getInstallationRepositorySelection ?? [],
    ).toHaveLength(0);
    await expectNothingLeft();
  });

  it("refuses an installation the caller never connected", async () => {
    const studio = await seedStudio();
    expect(
      await code(
        create({
          name: "A",
          studioEnvironmentId: studio,
          installationId: "999",
        }),
      ),
    ).toBe("GITHUB_NOT_CONNECTED");
    await expectNothingLeft();
  });

  it("refuses when the stored user token cannot be refreshed", async () => {
    const studio = await seedStudio();
    h.clock.now = new Date("2026-12-31T00:00:00.000Z"); // token expired
    h.github.refreshUserToken = async () => {
      throw new Error("bad_refresh_token");
    };
    expect(await code(create({ name: "A", studioEnvironmentId: studio }))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    await expectNothingLeft();
  });

  // Review Focus 2
  it("maps GitHub's 403 on repo creation to INSUFFICIENT_PERMISSION and leaves nothing behind", async () => {
    const studio = await seedStudio();
    h.github.forbiddenAccounts.set("acme", 403);
    await expect(
      create({ name: "Shop", studioEnvironmentId: studio }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Install the Vetra GitHub app on acme"),
      extensions: { code: "INSUFFICIENT_PERMISSION" },
    });
    expect(h.harbor.projects).toStrictEqual([]);
    expect(h.harbor.deletedProjects).toStrictEqual(["app-shop"]);
    expect(h.renown.registered).toStrictEqual([]);
    expect(h.github.calls.deleteRepo ?? []).toHaveLength(0);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
  });

  // Review Focus 3
  it("adds the repo to a selected-repositories installation before the installation-token calls", async () => {
    h.github.repositorySelection.set(INSTALLATION, "selected");
    const app = await create({
      name: "Shop",
      studioEnvironmentId: await seedStudio(),
    });
    expect(h.github.calls.addRepoToInstallation).toStrictEqual([
      ["user-token", INSTALLATION, app.repository_id],
    ]);
    const at = (name: string) => h.github.order.indexOf(name);
    expect(at("createRepoAsUser")).toBeLessThan(at("addRepoToInstallation"));
    expect(at("addRepoToInstallation")).toBeLessThan(at("setRepoVariable"));
    expect(at("addRepoToInstallation")).toBeLessThan(at("commitFile"));
  });

  it("undoes a repo not yet in a selected installation by adding it, then deleting with the installation token", async () => {
    h.github.repositorySelection.set(INSTALLATION, "selected");
    h.github.addRepoFailures.push(502); // the create's add fails, the undo's works
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({ extensions: { code: "GITHUB_UNAVAILABLE" } });
    expect(h.github.calls.addRepoToInstallation).toStrictEqual([
      ["user-token", INSTALLATION, "9001"],
      ["user-token", INSTALLATION, "9001"],
    ]);
    expect(h.github.calls.deleteRepo).toStrictEqual([
      [INSTALLATION, "acme/shop"],
    ]);
    expect(h.github.calls.deleteRepoAsUser ?? []).toHaveLength(0);
    expect(h.harbor.projects).toStrictEqual([]);
  });

  it("undoes a public repo in a selected installation through the installation too", async () => {
    h.github.repositorySelection.set(INSTALLATION, "selected");
    const createRepoAsUser = h.github.createRepoAsUser.bind(h.github);
    h.github.createRepoAsUser = async (...args) => ({
      ...(await createRepoAsUser(...args)),
      private: false,
    });
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({ extensions: { code: "DEPLOY_SETUP_FAILED" } });
    expect(h.github.order.slice(-2)).toStrictEqual([
      "addRepoToInstallation",
      "deleteRepo",
    ]);
    expect(h.github.calls.deleteRepo).toStrictEqual([
      [INSTALLATION, "acme/shop"],
    ]);
  });

  it("maps a 403 on adding to the installation to INSUFFICIENT_PERMISSION and falls back to the user-token delete", async () => {
    h.github.repositorySelection.set(INSTALLATION, "selected");
    h.github.addRepoFailures.push(403, 403);
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({
      extensions: { code: "INSUFFICIENT_PERMISSION" },
    });
    expect(h.github.calls.deleteRepo ?? []).toHaveLength(0);
    expect(h.github.calls.deleteRepoAsUser).toStrictEqual([
      ["user-token", "acme/shop"],
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(h.renown.registered).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
  });

  it("warns naming the repo when no delete could reach it (user-token 404 is not success)", async () => {
    h.github.repositorySelection.set(INSTALLATION, "selected");
    h.github.addRepoFailures.push(403, 403);
    h.github.userDeleteMissing.value = true;
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({
      extensions: { code: "INSUFFICIENT_PERMISSION" },
    });
    expect(h.github.calls.deleteRepoAsUser).toStrictEqual([
      ["user-token", "acme/shop"],
    ]);
    const warnings = vi
      .mocked(h.deps.logger.warn)
      .mock.calls.map((c) => String(c[0]));
    expect(
      warnings.some((w) => w.includes("acme/shop") && /by hand/.test(w)),
    ).toBe(true);
  });

  it("maps a 404 on repo creation to INSUFFICIENT_PERMISSION", async () => {
    h.github.forbiddenAccounts.set("acme", 404);
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Install the Vetra GitHub app on acme"),
      extensions: { code: "INSUFFICIENT_PERMISSION" },
    });
    expect(h.harbor.projects).toStrictEqual([]);
  });

  it("maps an uninstalled app (selection lookup 404) to GITHUB_NOT_CONNECTED", async () => {
    h.github.repositorySelection.set(INSTALLATION, "missing");
    expect(
      await code(
        create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
      ),
    ).toBe("GITHUB_NOT_CONNECTED");
    await expectNothingLeft();
  });

  it("undoes and refuses when a personal-account repo lands under another owner", async () => {
    await h.db
      .updateTable("github_deploy_connections")
      .set({ account_login: "alice", account_type: "User" })
      .where("owner_address", "=", OWNER)
      .execute();
    h.github.repoOwnerOverride.login = "bob";
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    expect(h.github.calls.deleteRepo).toStrictEqual([
      [INSTALLATION, "bob/shop"],
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
  });

  it("accepts a personal-account owner that differs only in case", async () => {
    await h.db
      .updateTable("github_deploy_connections")
      .set({ account_login: "Alice", account_type: "User" })
      .where("owner_address", "=", OWNER)
      .execute();
    h.github.repoOwnerOverride.login = "alice";
    const app = await create({
      name: "Shop",
      studioEnvironmentId: await seedStudio(),
    });
    expect(app.repository_full_name).toBe("alice/shop");
  });

  it("deletes the repo with the installation token once it was added to a selected installation", async () => {
    h.github.repositorySelection.set(INSTALLATION, "selected");
    h.github.commitFile = async () => {
      throw new Error("GitHub down");
    };
    await expect(
      create({ name: "Shop", studioEnvironmentId: await seedStudio() }),
    ).rejects.toMatchObject({ extensions: { code: "DEPLOY_SETUP_FAILED" } });
    expect(h.github.calls.deleteRepo).toStrictEqual([
      [INSTALLATION, "acme/shop"],
    ]);
    expect(h.github.calls.deleteRepoAsUser ?? []).toHaveLength(0);
  });

  // Review Focus 4
  it("takes the next name when the repo name is taken in the user's account", async () => {
    h.github.takenRepoNames.add("acme/my-shop");
    const app = await create({
      name: "My Shop",
      studioEnvironmentId: await seedStudio(),
    });
    expect(app.repository_full_name).toBe("acme/my-shop-2");
    expect(app.slug).toBe("my-shop-2");
    expect(h.harbor.projects).toStrictEqual(["app-my-shop-2"]);
  });

  // Review Focus 5
  it("creates the repo in a personal account for a user-account installation", async () => {
    await h.db
      .updateTable("github_deploy_connections")
      .set({ account_login: "alice", account_type: "User" })
      .where("owner_address", "=", OWNER)
      .execute();
    const app = await create({
      name: "My Shop",
      studioEnvironmentId: await seedStudio(),
    });
    expect(h.github.calls.createRepoAsUser[0][1]).toStrictEqual({
      login: "alice",
      type: "User",
    });
    expect(app.repository_full_name).toBe("alice/my-shop");
  });

  it("refuses a second App for the same studio without creating another repo", async () => {
    const studio = await seedStudio();
    await create({ name: "A", studioEnvironmentId: studio });
    expect(await code(create({ name: "B", studioEnvironmentId: studio }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(h.github.calls.createRepoAsUser).toHaveLength(1);
  });

  it("refuses a non-studio env and a studio of someone else", async () => {
    const plain = await h.envs.seedStandalone();
    expect(await code(create({ name: "A", studioEnvironmentId: plain }))).toBe(
      "BAD_USER_INPUT",
    );
    const studio = await seedStudio();
    expect(
      await code(create({ name: "A", studioEnvironmentId: studio }, stranger)),
    ).toBe("FORBIDDEN");
    expect(h.github.calls.createRepoAsUser ?? []).toHaveLength(0);
  });

  it("removes the repo, Harbor project and row when a later step fails, and a retry works", async () => {
    const studio = await seedStudio();
    h.renown.failNextRegistration = true;
    await expect(
      create({ name: "Shop", studioEnvironmentId: studio }),
    ).rejects.toThrow();
    expect(h.github.calls.deleteRepo[0]).toStrictEqual([
      INSTALLATION,
      "acme/shop",
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
    h.github.takenRepoNames.delete("acme/shop"); // the fake does not model deletion
    const app = await create({ name: "Shop", studioEnvironmentId: studio });
    expect(app.slug).toBe("shop");
  });

  it("serialises two creates for one Studio: one App, one refusal, one repository", async () => {
    const studio = await seedStudio();
    const results = await Promise.all([
      code(create({ name: "A", studioEnvironmentId: studio })),
      code(create({ name: "B", studioEnvironmentId: studio })),
    ]);
    expect(results.sort()).toStrictEqual(["BAD_USER_INPUT", "OK"]);
    expect(h.github.calls.createRepoAsUser).toHaveLength(1);
  });

  it("maps another replica's App for the Studio (unique index) to BAD_USER_INPUT and cleans up", async () => {
    const studio = await seedStudio();
    const first = await create({ name: "A", studioEnvironmentId: studio });
    // Hidden from the pre-check, then "committed" by another replica while
    // this create is under way.
    await h.db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", first.id)
      .execute();
    const createRepoAsUser = h.github.createRepoAsUser.bind(h.github);
    h.github.createRepoAsUser = async (...args) => {
      await h.db
        .updateTable("apps")
        .set({ status: "ACTIVE" })
        .where("id", "=", first.id)
        .execute();
      return createRepoAsUser(...args);
    };
    expect(await code(create({ name: "B", studioEnvironmentId: studio }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(h.github.calls.deleteRepo).toStrictEqual([[INSTALLATION, "acme/b"]]);
    expect(h.harbor.projects).toStrictEqual(["app-a"]);
  });

  it("undoes and errors when the repository comes back public", async () => {
    const studio = await seedStudio();
    const createRepoAsUser = h.github.createRepoAsUser.bind(h.github);
    h.github.createRepoAsUser = async (...args) => ({
      ...(await createRepoAsUser(...args)),
      private: false,
    });
    await expect(
      create({ name: "Shop", studioEnvironmentId: studio }),
    ).rejects.toMatchObject({ extensions: { code: "DEPLOY_SETUP_FAILED" } });
    expect(h.github.calls.deleteRepo).toStrictEqual([
      [INSTALLATION, "acme/shop"],
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
  });

  it("strips control characters and caps the repository description", async () => {
    const studio = await seedStudio();
    await create({ name: "Sh\nop\t\u007fshop", studioEnvironmentId: studio });
    const description = h.github.calls.createRepoAsUser[0][3] as string;
    expect(
      description.split("").some((c) => c.charCodeAt(0) < 32 || c === "\u007f"),
    ).toBe(false);
    expect(description.length).toBeLessThanOrEqual(350);
  });

  it("creates no env when the workflow commit fails, and removes the repository", async () => {
    const studio = await seedStudio();
    const envsBefore = [...h.envs.docs.keys()];
    const executedBefore = h.envs.executed.length;
    h.github.commitFile = async () => {
      throw new Error("GitHub down");
    };
    await expect(
      create({ name: "Shop", studioEnvironmentId: studio }),
    ).rejects.toMatchObject({ extensions: { code: "DEPLOY_SETUP_FAILED" } });
    expect([...h.envs.docs.keys()]).toStrictEqual(envsBefore);
    expect(h.envs.executed).toHaveLength(executedBefore);
    expect(h.github.calls.deleteRepo).toStrictEqual([
      [INSTALLATION, "acme/shop"],
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
  });

  it("makes an organisation's Studio only that organisation's App", async () => {
    const studio = await seedStudio();
    await h.envs.execute(studio, [
      setOwnerOrg({ ownerOrgId: ORG, operators: [OWNER] }),
    ]);
    h.orgs.join(ORG, OWNER, "OWNER");
    h.orgs.join("org-other", OWNER, "OWNER");
    await expect(
      create({ name: "A", studioEnvironmentId: studio }),
    ).rejects.toThrow(
      "This environment belongs to an organisation; create the App there",
    );
    await expect(
      create({ name: "A", studioEnvironmentId: studio, orgId: "org-other" }),
    ).rejects.toThrow("Environment belongs to another organisation");
    expect(h.github.calls.createRepoAsUser ?? []).toHaveLength(0);
    const app = await create({
      name: "A",
      studioEnvironmentId: studio,
      orgId: ORG,
    });
    expect(app.owner_org_id).toBe(ORG);
  });

  it("refuses a terminated Studio", async () => {
    const studio = await seedStudio();
    h.envs.setStatus(studio, "TERMINATING");
    await expect(
      create({ name: "A", studioEnvironmentId: studio }),
    ).rejects.toThrow("Studio is terminated");
    expect(h.github.calls.createRepoAsUser ?? []).toHaveLength(0);
  });
});
