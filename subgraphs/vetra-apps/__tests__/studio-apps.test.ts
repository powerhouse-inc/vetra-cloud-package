import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStudioApp } from "../service.js";
import {
  addPackage,
  approveChanges,
  setOwnerOrg,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import {
  ORG,
  OWNER,
  makeHarness,
  owner,
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

describe("createStudioApp", () => {
  it("creates a managed repo with the workflow and variable, the App, and links the studio", async () => {
    const studio = await seedStudio();
    const app = await createStudioApp(h.deps, owner, {
      name: "My Shop",
      studioEnvironmentId: studio,
    });
    const repoId = "9001"; // the fake GitHub's first repository
    expect(app).toMatchObject({
      slug: "my-shop",
      status: "PENDING_IDENTITY",
      installation_id: "88",
      repository_id: repoId,
      repository_full_name: "vetra-apps/my-shop",
      studio_environment_id: studio,
      // The fake Renown mints one DID per repository id.
      identity_did: `did:key:zDnaeRepo${repoId}`,
    });
    expect(h.github.calls.createOrgRepo[0].slice(1, 3)).toStrictEqual([
      "vetra-apps",
      "my-shop",
    ]);
    expect(h.github.calls.setRepoVariable[0]).toStrictEqual([
      "88",
      "vetra-apps/my-shop",
      "VETRA_APP_ID",
      app.id,
    ]);
    const [, repo, file] = h.github.calls.commitFile[0] as [
      string,
      string,
      { path: string; content: string; message: string },
    ];
    expect(repo).toBe("vetra-apps/my-shop");
    expect(file.path).toBe(".github/workflows/vetra.yml");
    expect(file.content).toContain(`app-id: ${app.id}`);
    expect(file.message).toContain("[skip ci]");
    // The studio env is NOT app-linked (CI must never deploy into it).
    expect((await h.envs.getState(studio))!.app).toBeNull();
    expect(
      (await h.envs.getState(app.production_environment_id))!.app,
    ).toMatchObject({ appId: app.id, role: "PRODUCTION" });
  });

  it("takes the next name when the repo name is taken in the managed org", async () => {
    h.github.takenRepoNames.add("my-shop");
    const app = await createStudioApp(h.deps, owner, {
      name: "My Shop",
      studioEnvironmentId: await seedStudio(),
    });
    expect(app.repository_full_name).toBe("vetra-apps/my-shop-2");
    expect(app.slug).toBe("my-shop-2");
    expect(h.harbor.projects).toStrictEqual(["app-my-shop-2"]);
  });

  it("refuses a second App for the same studio without creating another repo", async () => {
    const studio = await seedStudio();
    await createStudioApp(h.deps, owner, {
      name: "A",
      studioEnvironmentId: studio,
    });
    expect(
      await code(
        createStudioApp(h.deps, owner, {
          name: "B",
          studioEnvironmentId: studio,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(h.github.calls.createOrgRepo).toHaveLength(1);
  });

  it("refuses a non-studio env and a studio of someone else", async () => {
    const plain = await h.envs.seedStandalone();
    expect(
      await code(
        createStudioApp(h.deps, owner, {
          name: "A",
          studioEnvironmentId: plain,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    const studio = await seedStudio();
    expect(
      await code(
        createStudioApp(h.deps, stranger, {
          name: "A",
          studioEnvironmentId: studio,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(h.github.calls.createOrgRepo ?? []).toHaveLength(0);
  });

  it("removes the repo, Harbor project and row when a later step fails, and a retry works", async () => {
    const studio = await seedStudio();
    h.renown.failNextRegistration = true;
    await expect(
      createStudioApp(h.deps, owner, {
        name: "Shop",
        studioEnvironmentId: studio,
      }),
    ).rejects.toThrow();
    expect(h.github.calls.deleteRepo[0]).toStrictEqual([
      "88",
      "vetra-apps/shop",
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
    h.github.takenRepoNames.delete("shop"); // the fake does not model deletion
    const app = await createStudioApp(h.deps, owner, {
      name: "Shop",
      studioEnvironmentId: studio,
    });
    expect(app.slug).toBe("shop");
  });

  it("is unavailable without a managed org", async () => {
    const h2 = await makeHarness(testConfig({ managedGithub: null }));
    try {
      expect(
        await code(
          createStudioApp(h2.deps, owner, {
            name: "A",
            studioEnvironmentId: "x",
          }),
        ),
      ).toBe("SERVICE_NOT_CONFIGURED");
    } finally {
      await h2.close();
    }
  });

  it("serialises two creates for one Studio: one App, one refusal, one repository", async () => {
    const studio = await seedStudio();
    const results = await Promise.all([
      code(
        createStudioApp(h.deps, owner, {
          name: "A",
          studioEnvironmentId: studio,
        }),
      ),
      code(
        createStudioApp(h.deps, owner, {
          name: "B",
          studioEnvironmentId: studio,
        }),
      ),
    ]);
    expect(results.sort()).toStrictEqual(["BAD_USER_INPUT", "OK"]);
    expect(h.github.calls.createOrgRepo).toHaveLength(1);
  });

  it("maps another replica's App for the Studio (unique index) to BAD_USER_INPUT and cleans up", async () => {
    const studio = await seedStudio();
    const first = await createStudioApp(h.deps, owner, {
      name: "A",
      studioEnvironmentId: studio,
    });
    // Hidden from the pre-check, then "committed" by another replica while
    // this create is under way.
    await h.db
      .updateTable("apps")
      .set({ status: "DELETED" })
      .where("id", "=", first.id)
      .execute();
    const createOrgRepo = h.github.createOrgRepo.bind(h.github);
    h.github.createOrgRepo = async (...args) => {
      await h.db
        .updateTable("apps")
        .set({ status: "ACTIVE" })
        .where("id", "=", first.id)
        .execute();
      return createOrgRepo(...args);
    };
    expect(
      await code(
        createStudioApp(h.deps, owner, {
          name: "B",
          studioEnvironmentId: studio,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(h.github.calls.deleteRepo).toStrictEqual([["88", "vetra-apps/b"]]);
    expect(h.harbor.projects).toStrictEqual(["app-a"]);
  });

  it("undoes and errors when the repository comes back public", async () => {
    const studio = await seedStudio();
    const createOrgRepo = h.github.createOrgRepo.bind(h.github);
    h.github.createOrgRepo = async (...args) => ({
      ...(await createOrgRepo(...args)),
      private: false,
    });
    await expect(
      createStudioApp(h.deps, owner, {
        name: "Shop",
        studioEnvironmentId: studio,
      }),
    ).rejects.toThrow(/public repository/);
    expect(h.github.calls.deleteRepo).toStrictEqual([
      ["88", "vetra-apps/shop"],
    ]);
    expect(h.harbor.projects).toStrictEqual([]);
    expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(
      0,
    );
  });

  it("strips control characters and caps the repository description", async () => {
    const studio = await seedStudio();
    await createStudioApp(h.deps, owner, {
      name: "Sh\nop\t\u007fshop",
      studioEnvironmentId: studio,
    });
    const description = h.github.calls.createOrgRepo[0][3] as string;
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
      createStudioApp(h.deps, owner, {
        name: "Shop",
        studioEnvironmentId: studio,
      }),
    ).rejects.toThrow("GitHub down");
    expect([...h.envs.docs.keys()]).toStrictEqual(envsBefore);
    expect(h.envs.executed).toHaveLength(executedBefore);
    expect(h.github.calls.deleteRepo).toStrictEqual([
      ["88", "vetra-apps/shop"],
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
      createStudioApp(h.deps, owner, {
        name: "A",
        studioEnvironmentId: studio,
      }),
    ).rejects.toThrow(
      "This environment belongs to an organisation; create the App there",
    );
    await expect(
      createStudioApp(h.deps, owner, {
        name: "A",
        studioEnvironmentId: studio,
        orgId: "org-other",
      }),
    ).rejects.toThrow("Environment belongs to another organisation");
    expect(h.github.calls.createOrgRepo ?? []).toHaveLength(0);
    const app = await createStudioApp(h.deps, owner, {
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
      createStudioApp(h.deps, owner, {
        name: "A",
        studioEnvironmentId: studio,
      }),
    ).rejects.toThrow("Studio is terminated");
    expect(h.github.calls.createOrgRepo ?? []).toHaveLength(0);
  });
});
