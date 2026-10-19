import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real GitHub client runs against a fake fetch; only the app JWT is faked.
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "ghs_installation" }),
}));

const { createGithubDeployApi } = await import("../github.js");
const { connectGithubDeploy, createApp, createStudioApp } = await import(
  "../service.js"
);
const { createResolvers } = await import("../resolvers.js");

import {
  addPackage,
  approveChanges,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import {
  INSTALLATION,
  OWNER,
  REPO_ID,
  USER_KEY,
  makeHarness,
  owner,
  type Harness,
} from "./harness.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  await connectGithubDeploy(h.deps, owner, "code");
});
afterEach(async () => {
  await h.close();
});

async function seedStudio() {
  const id = await h.envs.seedStandalone(OWNER);
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

/** createRepoAsUser through the real client, answering every call with `respond`. */
function githubAnswers(respond: () => Response | Promise<Response>) {
  const api = createGithubDeployApi(
    {
      appId: "1",
      slug: "vetra-deploy",
      clientId: "cid",
      clientSecret: "csecret",
      privateKey: "k",
    },
    (async () => respond()) as unknown as typeof fetch,
  );
  h.github.createRepoAsUser = api.createRepoAsUser.bind(api);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Failure = { message: string; extensions: Record<string, unknown> };
async function failure(p: Promise<unknown>): Promise<Failure> {
  try {
    await p;
  } catch (err) {
    return err as Failure;
  }
  throw new Error("expected a failure");
}

async function createFails() {
  const studio = await seedStudio();
  return failure(
    createStudioApp(h.deps, owner, {
      name: "Shop",
      studioEnvironmentId: studio,
      installationId: INSTALLATION,
    }),
  );
}

async function expectNothingLeft() {
  expect(h.harbor.projects).toStrictEqual([]);
  expect(await h.db.selectFrom("apps").select("id").execute()).toHaveLength(0);
}

describe("createStudioApp GitHub errors", () => {
  it("REPO_EXISTS when every candidate name already exists", async () => {
    githubAnswers(() =>
      json(422, {
        message: "Repository creation failed.",
        errors: [{ field: "name", message: "name already exists on this account" }],
      }),
    );
    const err = await createFails();
    expect(err.extensions.code).toBe("REPO_EXISTS");
    expect(err.message).toMatch(/already exists.*another name/i);
    await expectNothingLeft();
  });

  it("REPO_NAME_INVALID with GitHub's reason, not 'already exists'", async () => {
    githubAnswers(() =>
      json(422, {
        message: "Repository creation failed.",
        errors: [{ field: "name", message: "name is invalid" }],
      }),
    );
    const err = await createFails();
    expect(err.extensions.code).toBe("REPO_NAME_INVALID");
    expect(err.extensions.reason).toBe("name is invalid");
    expect(err.message).toContain("name is invalid");
    expect(err.message).not.toMatch(/already exists/i);
    // A rejected name is not retried with a suffix.
    expect(h.harbor.deletedProjects).toStrictEqual(["app-shop"]);
    await expectNothingLeft();
  });

  it.each([403, 404])(
    "INSUFFICIENT_PERMISSION on %i, naming the app and the Administration permission",
    async (status) => {
      githubAnswers(() => json(status, { message: "Not Found" }));
      const err = await createFails();
      expect(err.extensions.code).toBe("INSUFFICIENT_PERMISSION");
      expect(err.message).toContain("acme");
      expect(err.message).toMatch(/Administration/);
      await expectNothingLeft();
    },
  );

  it.each([
    [403, "Resource protected by organization SAML enforcement."],
    [422, "Repository creation failed: the organization policy restricts repository creation"],
  ])("ORG_POLICY on %i mentioning an organisation policy", async (status, msg) => {
    githubAnswers(() => json(status, { message: msg }));
    const err = await createFails();
    expect(err.extensions.code).toBe("ORG_POLICY");
    expect(err.message).toMatch(/owner/i);
    await expectNothingLeft();
  });

  it("GITHUB_NOT_CONNECTED on 401", async () => {
    githubAnswers(() => json(401, { message: "Bad credentials" }));
    const err = await createFails();
    expect(err.extensions.code).toBe("GITHUB_NOT_CONNECTED");
    expect(err.message).toMatch(/reconnect GitHub/i);
    await expectNothingLeft();
  });

  it.each([
    ["502", () => new Response("Bad Gateway", { status: 502 })],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
  ])("GITHUB_UNAVAILABLE on %s", async (_label, respond) => {
    githubAnswers(respond);
    const err = await createFails();
    expect(err.extensions.code).toBe("GITHUB_UNAVAILABLE");
    expect(err.message).toMatch(/try again in a minute/i);
    await expectNothingLeft();
  });

  it("GITHUB_UNAVAILABLE when the installation lookup gets a 5xx", async () => {
    const { GithubHttpError } = await import("../github.js");
    h.github.getInstallationRepositorySelection = async () => {
      throw new GithubHttpError(503, "GitHub GET /app/installations/77 → 503");
    };
    const err = await createFails();
    expect(err.extensions.code).toBe("GITHUB_UNAVAILABLE");
  });
});

describe("createStudioApp setup errors after the repository exists", () => {
  it("DEPLOY_SETUP_FAILED on a Harbor failure, rolled back and logged at error level with the step", async () => {
    h.harbor.createPushRobot = async () => {
      throw new Error("harbor: 500 robot creation failed");
    };
    const err = await createFails();
    expect(err.extensions.code).toBe("DEPLOY_SETUP_FAILED");
    expect(err.message).toMatch(/rolled back/i);
    expect(err.message).not.toContain("harbor");
    expect(h.github.calls.deleteRepo).toStrictEqual([[INSTALLATION, "acme/shop"]]);
    await expectNothingLeft();
    const logged = vi.mocked(h.deps.logger.error).mock.calls.map((c) => c[0]);
    expect(logged.some((m) => /Harbor robot/.test(m) && /500/.test(m))).toBe(true);
    expect(logged.join("\n")).not.toContain("user-token");
  });

  it("DEPLOY_SETUP_FAILED when creating the production env fails", async () => {
    const studio = await seedStudio();
    h.envs.create = async () => {
      throw new Error("reactor unavailable");
    };
    const err = await failure(
      createStudioApp(h.deps, owner, {
        name: "Shop",
        studioEnvironmentId: studio,
        installationId: INSTALLATION,
      }),
    );
    expect(err.extensions.code).toBe("DEPLOY_SETUP_FAILED");
    expect(h.github.calls.deleteRepo).toStrictEqual([[INSTALLATION, "acme/shop"]]);
    await expectNothingLeft();
  });

  it("rollback deletes the production env document", async () => {
    const studio = await seedStudio();
    const before = new Set(h.envs.docs.keys());
    const execute = h.envs.execute.bind(h.envs);
    h.envs.execute = async (id, actions) => {
      if (!before.has(id)) throw new Error("INITIALIZE rejected");
      return execute(id, actions);
    };
    const err = await failure(
      createStudioApp(h.deps, owner, {
        name: "Shop",
        studioEnvironmentId: studio,
        installationId: INSTALLATION,
      }),
    );
    expect(err.extensions.code).toBe("DEPLOY_SETUP_FAILED");
    expect(h.envs.deleted).toHaveLength(1);
    expect(before.has(h.envs.deleted[0])).toBe(false);
    expect(new Set(h.envs.docs.keys())).toStrictEqual(before);
    await expectNothingLeft();
  });
});

describe("createApp rollback", () => {
  it("deletes the new production env document it created", async () => {
    const before = new Set(h.envs.docs.keys());
    h.envs.execute = async () => {
      throw new Error("INITIALIZE rejected");
    };
    await expect(
      createApp(h.deps, owner, {
        name: "Shop",
        installationId: INSTALLATION,
        repositoryId: REPO_ID,
      }),
    ).rejects.toThrow();
    expect(h.envs.deleted).toHaveLength(1);
    expect(new Set(h.envs.docs.keys())).toStrictEqual(before);
  });

  it("never deletes an attached env", async () => {
    const env = await h.envs.seedStandalone(OWNER);
    const execute = h.envs.execute.bind(h.envs);
    h.envs.execute = async (id, actions) => {
      if (actions.some((a) => a.type === "SET_APP_LINK"))
        throw new Error("SET_APP_LINK rejected");
      return execute(id, actions);
    };
    await expect(
      createApp(h.deps, owner, {
        name: "Shop",
        installationId: INSTALLATION,
        repositoryId: REPO_ID,
        productionEnvironmentId: env,
      }),
    ).rejects.toThrow();
    expect(h.envs.deleted).toStrictEqual([]);
    expect(h.envs.docs.has(env)).toBe(true);
  });
});

describe("guard", () => {
  it("logs an unexpected resolver failure at error level with the step name", async () => {
    const studio = await seedStudio();
    h.github.getInstallationRepositorySelection = async () => {
      throw new TypeError("Cannot read properties of undefined");
    };
    const r = createResolvers(h.deps);
    const err = await failure(
      r.Mutation.createStudioApp(
        null,
        {
          input: {
            name: "Shop",
            studioEnvironmentId: studio,
            installationId: INSTALLATION,
          },
        },
        {
          user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: USER_KEY },
          headers: {},
        },
      ),
    );
    expect(err.extensions.code).toBe("INTERNAL_SERVER_ERROR");
    expect(err.message).not.toContain("Cannot read");
    const logged = vi.mocked(h.deps.logger.error).mock.calls.map((c) => c[0]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/createStudioApp failed: TypeError: Cannot read/);
  });
});
