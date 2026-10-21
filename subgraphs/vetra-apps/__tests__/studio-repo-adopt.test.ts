import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real GitHub client below signs app calls with this (no key needed).
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async (opts: { type: string; installationId?: number }) => ({
    token: opts.type === "app" ? "ghs_app_jwt" : `ghs_inst_${opts.installationId}`,
  }),
}));

import {
  addPackage,
  approveChanges,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { Caller } from "../auth.js";
import { createGithubDeployApi, GithubHttpError } from "../github.js";
import { getApp, type AppRow } from "../repo.js";
import { createResolvers } from "../resolvers.js";
import {
  adoptStudioRepository,
  attachStudioRepository,
  connectGithubDeploy,
  ensureStudioProduct,
  studioPushToken,
  type StudioGithubConnection,
} from "../service.js";
import {
  hashLaunchSecret,
  STUDIO_SECRET_HEADER,
  storeLaunchSecretHash,
} from "../studio-binding.js";
import { makeHarness, OWNER, owner, STRANGER, testConfig, type Harness } from "./harness.js";

const AGENT_KEY = "did:key:zDnaeStudioAgent";
const OTHER_AGENT_KEY = "did:key:zDnaeOtherStudioAgent";
const agent: Caller = { address: OWNER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };
const otherAgent: Caller = { address: OWNER, chainId: 1, appKey: OTHER_AGENT_KEY, isAdmin: false };
const FUTURE = "2027-10-02T12:00:00.000Z";

const PERSONAL = "88";
const ORG_INSTALLATION = "66";
const ORG_LOGIN = "web3-berlin";
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
/** The repository the Studio made through vetra-github-auth (the old path). */
const OLD_REPO = "frank/my-shop-studio";
const OLD_REPO_ID = "7001";

let h: Harness;
/** vetra-github-auth's connections, by Studio environment id. */
let legacy: Map<string, StudioGithubConnection[]>;
beforeEach(async () => {
  h = await makeHarness();
  h.renown.delegation = { expiresAt: FUTURE };
  h.github.installations.push(
    { installationId: PERSONAL, appId: "1001", accountLogin: "frank", accountType: "User" },
    {
      installationId: ORG_INSTALLATION,
      appId: "1001",
      accountLogin: ORG_LOGIN,
      accountType: "Organization",
    },
  );
  legacy = new Map();
  h.deps.studioGithubConnections = async (studioId) => legacy.get(studioId) ?? [];
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );

interface Product {
  app: AppRow;
  studioId: string;
  secret: string;
}

async function seedProduct(name = "My Shop", by: Caller = agent): Promise<Product> {
  const studioId = await h.envs.seedStandalone(OWNER);
  await h.envs.execute(studioId, [
    addPackage({
      packageName: "vetra",
      version: "0.0.1-dev.27",
      registry: "https://registry.dev.vetra.io",
    }),
    approveChanges({}),
  ]);
  const secret = randomBytes(32).toString("hex");
  await storeLaunchSecretHash(h.db, studioId, hashLaunchSecret(secret), "2026-10-20T00:00:00.000Z");
  const app = await ensureStudioProduct(
    h.deps,
    by,
    { studioEnvironmentId: studioId, name },
    { kind: "agent", secret },
  );
  return { app, studioId, secret };
}

/** The Studio connected GitHub the old way, and Vetra Deploy reaches that repository. */
function connectedTheOldWay(
  p: Product,
  where: { installationId: string; accountLogin: string; accountType: string } = {
    installationId: PERSONAL,
    accountLogin: "frank",
    accountType: "User",
  },
  repoFullName = OLD_REPO,
) {
  legacy.set(p.studioId, [{ userDid: OWNER_DID, repoFullName, githubLogin: "frank" }]);
  h.github.repoInstallations.set(repoFullName, {
    ...where,
    repo: { id: OLD_REPO_ID, fullName: repoFullName, private: true, defaultBranch: "main" },
  });
}

const nothingMadeOrMoved = () => {
  for (const name of ["createRepoAsUser", "addRepoToInstallation", "deleteRepo", "deleteRepoAsUser"])
    expect(h.github.calls[name] ?? []).toHaveLength(0);
};

describe("adoptStudioRepository (existing Studio GitHub connections carried over)", () => {
  it("adopting keeps the existing repo", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);

    // The agent's first mirror attempt asks for a push token: the old repository is adopted.
    const t = await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(t.remoteUrl).toBe(`https://github.com/${OLD_REPO}.git`);
    expect(t.token).toMatch(/^ghs_push_/);
    expect(h.github.calls.createRepoPushToken).toStrictEqual([[PERSONAL, OLD_REPO_ID]]);

    const app = (await getApp(h.db, p.app.id))!;
    expect(app).toMatchObject({
      installation_id: PERSONAL,
      repository_id: OLD_REPO_ID,
      repository_full_name: OLD_REPO,
      repository_account_login: "frank",
      repository_account_type: "User",
      repository_disconnected_at: null,
      repository_connected_by: OWNER,
      // GitHub's main was empty: nothing to bring in.
      external_changes_sha: null,
    });
    // Still a Studio product (no CI identity, no Harbor robot).
    expect(app.harbor_robot_name).toBe("");
    expect(app.status).toBe(p.app.status);
    nothingMadeOrMoved();

    // Adopting again changes nothing.
    const again = await adoptStudioRepository(h.deps, agent, p.app.id, p.secret);
    expect(again.repository_full_name).toBe(OLD_REPO);
    expect(h.github.calls.findRepoInstallation).toHaveLength(1);
    expect(h.github.calls.createRepoPushToken).toHaveLength(1);
    expect((h.deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n")).toContain(
      OLD_REPO,
    );
  });

  it("commits already on GitHub show as changes made there", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);
    const head = "AB".repeat(20);
    h.github.branchHeads.set(OLD_REPO, head);
    await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(h.github.calls.getBranchHead).toStrictEqual([[PERSONAL, OLD_REPO, "main"]]);
    expect((await getApp(h.db, p.app.id))!.external_changes_sha).toBe(head.toLowerCase());
  });

  it("is not carried over when GitHub's main can't be read or no push token is given", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);
    h.github.branchHeads.set(OLD_REPO, "error");
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();

    // A refused token leaves the Studio on its earlier connection (not disconnected).
    h.github.branchHeads.delete(OLD_REPO);
    h.github.createRepoPushToken = async () => {
      throw new GithubHttpError(403, "refused");
    };
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect(await code(adoptStudioRepository(h.deps, agent, p.app.id, p.secret))).toBe("OK");
    const app = (await getApp(h.db, p.app.id))!;
    expect(app.repository_id).toBeNull();
    expect(app.repository_disconnected_at).toBeNull();
  });

  it("a personal repository is carried over only into the owner's own GitHub account", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);
    // GitHub says the account is someone else's than the owner's GitHub identity.
    legacy.set(p.studioId, [{ userDid: OWNER_DID, repoFullName: OLD_REPO, githubLogin: "mallory" }]);
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    // No identity recorded: can't tell.
    legacy.set(p.studioId, [{ userDid: OWNER_DID, repoFullName: OLD_REPO, githubLogin: null }]);
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();
    expect(h.github.calls.createRepoPushToken ?? []).toHaveLength(0);
    // Same login, other case: the owner's.
    legacy.set(p.studioId, [{ userDid: OWNER_DID, repoFullName: OLD_REPO, githubLogin: "Frank" }]);
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe("OK");
  });

  it("is served over GraphQL to the agent with the launch secret header", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);
    const resolvers = createResolvers(h.deps);
    const adopt = resolvers.Mutation.adoptStudioRepository as (...a: unknown[]) => Promise<{
      repository: { fullName: string; accountLogin: string; accountType: string } | null;
    }>;
    const userCtx = (appKey: string) => ({
      user: { address: OWNER, chainId: 1, networkId: "eip155", appKey },
    });

    // The owner's browser (no launch secret) is not the agent.
    await expect(
      adopt(null, { appId: p.app.id }, userCtx("did:key:zDnaeOwnerBrowser")),
    ).rejects.toMatchObject({ extensions: { code: "STUDIO_BINDING" } });

    const adopted = await adopt(
      null,
      { appId: p.app.id },
      { ...userCtx(AGENT_KEY), headers: { [STUDIO_SECRET_HEADER]: p.secret } },
    );
    expect(adopted.repository).toMatchObject({
      fullName: OLD_REPO,
      accountLogin: "frank",
      accountType: "User",
    });
  });

  it("another Studio's agent cannot adopt this product's repository", async () => {
    const p = await seedProduct();
    const other = await seedProduct("Other Shop", otherAgent);
    connectedTheOldWay(p);
    expect(await code(adoptStudioRepository(h.deps, otherAgent, p.app.id, other.secret))).toBe(
      "STUDIO_BINDING",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();
  });

  it("nothing to adopt: the push token stays not connected and the App unchanged", async () => {
    const p = await seedProduct();

    // No old connection at all.
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect(h.github.calls.findRepoInstallation ?? []).toHaveLength(0);

    // Someone else's connection for this Studio is not the owner's.
    legacy.set(p.studioId, [
      { userDid: `did:pkh:eip155:1:${STRANGER}`, repoFullName: OLD_REPO, githubLogin: "frank" },
    ]);
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect(h.github.calls.findRepoInstallation ?? []).toHaveLength(0);

    // The owner's connection, but Vetra Deploy is not installed there / does not reach the repository.
    legacy.set(p.studioId, [{ userDid: OWNER_DID, repoFullName: OLD_REPO, githubLogin: "frank" }]);
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect(h.github.calls.findRepoInstallation).toStrictEqual([[OLD_REPO]]);

    // GitHub not answering: left for the next attempt.
    h.github.findRepoInstallation = async () => {
      throw new GithubHttpError(502, "Bad Gateway");
    };
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((h.deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n")).toMatch(
      /could not carry .* over/,
    );

    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();
    nothingMadeOrMoved();
  });

  it("without the old connections' table nothing is adopted", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);
    h.deps.studioGithubConnections = null;
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    h.deps.studioGithubConnections = async () => {
      throw new Error("relation github_installations does not exist");
    };
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();
  });

  it("a repository another App already uses is not adopted", async () => {
    const p = await seedProduct();
    connectedTheOldWay(p);
    const other = await seedProduct("Other Shop", otherAgent);
    await h.db
      .updateTable("apps")
      .set({ repository_id: OLD_REPO_ID, repository_full_name: OLD_REPO, installation_id: PERSONAL })
      .where("id", "=", other.app.id)
      .execute();
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();
  });

  it("a product already on GitHub keeps its own repository", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const attached = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    connectedTheOldWay(p);
    const t = await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(t.remoteUrl).toBe(`https://github.com/${attached.repository_full_name}.git`);
    expect(await adoptStudioRepository(h.deps, agent, p.app.id, p.secret)).toMatchObject({
      repository_id: attached.repository_id,
    });

    // Disconnected later (GitHub took it away): the old repository is not brought back.
    await h.db
      .updateTable("apps")
      .set({ repository_disconnected_at: "2026-10-03T00:00:00.000Z" })
      .where("id", "=", p.app.id)
      .execute();
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBe(attached.repository_id);
    expect(h.github.calls.findRepoInstallation ?? []).toHaveLength(0);
  });

  it("an organisation's repository is adopted only for an active member with Vetra Deploy connected there", async () => {
    const p = await seedProduct();
    const orgRepo = `${ORG_LOGIN}/my-shop-studio`;
    connectedTheOldWay(
      p,
      { installationId: ORG_INSTALLATION, accountLogin: ORG_LOGIN, accountType: "Organization" },
      orgRepo,
    );

    // The owner never connected Vetra Deploy: nothing to check membership with.
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();

    // Connected, but no longer a member.
    await connectGithubDeploy(h.deps, owner, "code");
    h.github.memberships.set(ORG_LOGIN, null);
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect((await getApp(h.db, p.app.id))!.repository_id).toBeNull();

    // An active member.
    h.github.memberships.delete(ORG_LOGIN);
    const t = await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(t.remoteUrl).toBe(`https://github.com/${orgRepo}.git`);
    expect(await getApp(h.db, p.app.id)).toMatchObject({
      installation_id: ORG_INSTALLATION,
      repository_full_name: orgRepo,
      repository_account_login: ORG_LOGIN,
      repository_account_type: "Organization",
      repository_connected_by: OWNER,
      // The product stays its owner's.
      owner_address: OWNER,
    });
    nothingMadeOrMoved();
  });

  it("a legacy CI App is not a Studio product", async () => {
    const p = await seedProduct();
    await h.db.updateTable("apps").set({ harbor_robot_name: "robot$x" }).where("id", "=", p.app.id).execute();
    expect(await code(adoptStudioRepository(h.deps, agent, p.app.id, p.secret))).toBe(
      "BAD_USER_INPUT",
    );
  });
});

describe("GitHub client: findRepoInstallation", () => {
  function client(routes: Record<string, () => Response>) {
    const calls: { method: string; path: string; auth: string | undefined }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = new URL(url).pathname;
      calls.push({ method, path, auth: (init.headers as Record<string, string>).Authorization });
      const route = routes[`${method} ${path}`];
      return route ? route() : Response.json({ message: "Not Found" }, { status: 404 });
    });
    return { api: createGithubDeployApi(testConfig().github!, fetchImpl as never), calls };
  }

  it("names the installation and the repository it reaches", async () => {
    const { api, calls } = client({
      "GET /repos/frank/my-shop-studio/installation": () =>
        Response.json({ id: 88, account: { login: "frank", type: "User" } }),
      "GET /repos/frank/my-shop-studio": () =>
        Response.json({ id: 7001, full_name: "frank/my-shop-studio", private: true, default_branch: "main" }),
    });
    expect(await api.findRepoInstallation("frank/my-shop-studio")).toStrictEqual({
      installationId: "88",
      accountLogin: "frank",
      accountType: "User",
      repo: { id: "7001", fullName: "frank/my-shop-studio", private: true, defaultBranch: "main" },
    });
    expect(calls.map((c) => c.auth)).toStrictEqual(["Bearer ghs_app_jwt", "token ghs_inst_88"]);
  });

  it("reads a branch head with the installation token; an empty repository has none", async () => {
    const { api, calls } = client({
      "GET /repos/frank/shop/git/ref/heads/main": () =>
        Response.json({ ref: "refs/heads/main", object: { sha: "c".repeat(40), type: "commit" } }),
    });
    expect(await api.getBranchHead("88", "frank/shop", "main")).toBe("c".repeat(40));
    expect(calls[0].auth).toBe("token ghs_inst_88");
    expect(await client({}).api.getBranchHead("88", "frank/shop", "main")).toBeNull();
    const empty = client({
      "GET /repos/frank/shop/git/ref/heads/main": () =>
        Response.json({ message: "Git Repository is empty." }, { status: 409 }),
    });
    expect(await empty.api.getBranchHead("88", "frank/shop", "main")).toBeNull();
  });

  it("is null when Vetra Deploy is not installed there or does not reach the repository", async () => {
    expect(await client({}).api.findRepoInstallation("frank/my-shop-studio")).toBeNull();
    const notCovered = client({
      "GET /repos/frank/my-shop-studio/installation": () =>
        Response.json({ id: 88, account: { login: "frank", type: "User" } }),
    });
    expect(await notCovered.api.findRepoInstallation("frank/my-shop-studio")).toBeNull();
  });
});
