import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real GitHub client below signs app calls with this (no key needed).
vi.mock("@octokit/auth-app", () => ({
  createAppAuth: () => async () => ({ token: "ghs_app_jwt" }),
}));

import {
  addPackage,
  approveChanges,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { Caller } from "../auth.js";
import { createCiRoutes, type CiTokenVerifier } from "../ci.js";
import { createGithubDeployApi, GithubHttpError } from "../github.js";
import { getApp, type AppRow } from "../repo.js";
import { createResolvers } from "../resolvers.js";
import {
  attachStudioRepository,
  confirmAppIdentity,
  connectGithubDeploy,
  createStudioApp,
  deleteApp,
  ensureStudioProduct,
  myApps,
  openAppSetupPullRequest,
  updateApp,
  launchStudioVersion,
  studioPushToken,
} from "../service.js";
import {
  hashLaunchSecret,
  STUDIO_SECRET_HEADER,
  storeLaunchSecretHash,
} from "../studio-binding.js";
import { reportDeploymentToGithub } from "../watcher.js";
import { handleGithubWebhook } from "../webhook.js";
import {
  INSTALLATION,
  makeHarness,
  OWNER,
  owner,
  testConfig,
  type Harness,
} from "./harness.js";

const AGENT_KEY = "did:key:zDnaeStudioAgent";
const OTHER_AGENT_KEY = "did:key:zDnaeOtherStudioAgent";
const agent: Caller = { address: OWNER, chainId: 1, appKey: AGENT_KEY, isAdmin: false };
const otherAgent: Caller = {
  address: OWNER,
  chainId: 1,
  appKey: OTHER_AGENT_KEY,
  isAdmin: false,
};
const FUTURE = "2027-10-02T12:00:00.000Z";

const PERSONAL = "88";
const ORG_INSTALLATION = "66";
const ORG_LOGIN = "web3-berlin";

let h: Harness;
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
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );
const failure = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: "OK", message: "" }),
    (e: { extensions?: { code?: string }; message?: string }) => ({
      code: e.extensions?.code ?? "",
      message: e.message ?? String(e),
    }),
  );

interface Product {
  app: AppRow;
  studioId: string;
  secret: string;
}

/** A claimed Studio with its launch secret and its product (no GitHub), made by its agent. */
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
  h.envs.setStatus(app.production_environment_id, "READY");
  return { app, studioId, secret };
}

type Route = (body: any) => Response;
interface Call {
  method: string;
  path: string;
  body: any;
  auth: string | undefined;
}

/** Swap in the real GitHub client, answering `routes` ("METHOD /path" prefix match; anything else 404s). */
function realGithub(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? "GET",
      path: url.replace("https://api.github.com", ""),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    const route = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!route) return Response.json({ message: "Not Found" }, { status: 404 });
    return route[1](call.body);
  });
  h.deps.github = createGithubDeployApi(testConfig().github!, fetchImpl as never);
  return calls;
}

const created = (fullName: string, id = 5150) => () =>
  Response.json({ id, full_name: fullName, private: true, default_branch: "main" }, { status: 201 });
const selection = (s = "all") => () => Response.json({ repository_selection: s });
const membership = (state: string, role: string) => () => Response.json({ state, role });

describe("attachStudioRepository (D14)", () => {
  it("personal installation creates a private repo in the user account", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");

    const app = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });

    expect(h.github.calls.createRepoAsUser).toHaveLength(1);
    const [token, account, name, description] = h.github.calls.createRepoAsUser[0];
    expect(token).toBe("user-token");
    expect(account).toStrictEqual({ login: "frank", type: "User" });
    expect(name).toBe(p.app.slug);
    expect(description).toBe("My Shop — built with Vetra Studio");
    expect(app.repository_full_name).toBe(`frank/${p.app.slug}`);
    expect(app.installation_id).toBe(PERSONAL);
    expect(app.repository_account_login).toBe("frank");
    expect(app.repository_account_type).toBe("User");
    // A personal account is not an organisation: no membership lookup.
    expect(h.github.calls.getOrgMembership).toBeUndefined();
    // D15: no CI for Studio products — no workflow, no repo variable, no CI identity.
    expect(h.github.calls.commitFile).toBeUndefined();
    expect(h.github.calls.setRepoVariable).toBeUndefined();
    expect(h.renown.registered).toHaveLength(0);
    // The product keeps working as it did.
    expect(app.status).toBe("ACTIVE");
    expect(app.identity_did).toBe(AGENT_KEY);
    expect(app.owner_address).toBe(OWNER);
  });

  it("a taken repository name gets the next suffix", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    h.github.takenRepoNames.add(`frank/${p.app.slug}`);
    h.github.takenRepoNames.add(`frank/${p.app.slug}-2`);

    const app = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    expect(app.repository_full_name).toBe(`frank/${p.app.slug}-3`);
  });

  it("a selected-repositories installation gets the new repository added", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    h.github.repositorySelection.set(PERSONAL, "selected");
    const app = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    expect(h.github.calls.addRepoToInstallation).toStrictEqual([
      ["user-token", PERSONAL, app.repository_id],
    ]);
  });

  it("org installation posts to /orgs/<login>/repos", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const calls = realGithub({
      [`GET /app/installations/${ORG_INSTALLATION}`]: selection(),
      [`GET /user/memberships/orgs/${ORG_LOGIN}`]: membership("active", "member"),
      [`POST /orgs/${ORG_LOGIN}/repos`]: created(`${ORG_LOGIN}/${p.app.slug}`),
    });

    const app = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: ORG_INSTALLATION,
    });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(`/orgs/${ORG_LOGIN}/repos`);
    expect(post.auth).toBe("token user-token");
    expect(post.body).toMatchObject({
      name: p.app.slug,
      private: true,
      description: "My Shop — built with Vetra Studio",
    });
    expect(calls.some((c) => c.path === "/user/repos")).toBe(false);
    expect(app.repository_full_name).toBe(`${ORG_LOGIN}/${p.app.slug}`);
    expect(app.repository_account_login).toBe(ORG_LOGIN);
    expect(app.repository_account_type).toBe("Organization");
    // The App stays the Studio owner's: the GitHub organisation is only where the code goes.
    expect(app.owner_address).toBe(OWNER);
    expect(app.owner_org_id).toBeNull();
  });

  it("org repo creation restricted to owners maps to ORG_POLICY with the ask-an-owner message", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    realGithub({
      [`GET /app/installations/${ORG_INSTALLATION}`]: selection(),
      [`GET /user/memberships/orgs/${ORG_LOGIN}`]: membership("active", "member"),
      [`POST /orgs/${ORG_LOGIN}/repos`]: () =>
        Response.json(
          {
            message:
              "You need admin access to the organization before adding a repository to it.",
          },
          { status: 403 },
        ),
    });

    expect(
      await failure(
        attachStudioRepository(h.deps, owner, {
          appId: p.app.id,
          installationId: ORG_INSTALLATION,
        }),
      ),
    ).toStrictEqual({
      code: "ORG_POLICY",
      message: `Ask an owner of ${ORG_LOGIN} to allow Vetra, or choose your personal account`,
    });
    // Nothing recorded; Live is untouched.
    const after = (await getApp(h.db, p.app.id))!;
    expect(after.repository_id).toBeNull();
    expect(after.status).toBe("ACTIVE");
  });

  it("an organisation policy named by GitHub (SAML) maps to ORG_POLICY too", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    realGithub({
      [`GET /app/installations/${ORG_INSTALLATION}`]: selection(),
      [`GET /user/memberships/orgs/${ORG_LOGIN}`]: () =>
        Response.json(
          { message: "Resource protected by organization SAML enforcement." },
          { status: 403 },
        ),
    });
    expect(
      await failure(
        attachStudioRepository(h.deps, owner, {
          appId: p.app.id,
          installationId: ORG_INSTALLATION,
        }),
      ),
    ).toMatchObject({ code: "ORG_POLICY" });
  });

  it("app not installed on the org maps to INSUFFICIENT_PERMISSION", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    // The installation lookup 404s: Vetra was uninstalled from the organisation.
    const calls = realGithub({
      [`GET /user/memberships/orgs/${ORG_LOGIN}`]: membership("active", "admin"),
    });

    expect(
      await failure(
        attachStudioRepository(h.deps, owner, {
          appId: p.app.id,
          installationId: ORG_INSTALLATION,
        }),
      ),
    ).toStrictEqual({
      code: "INSUFFICIENT_PERMISSION",
      message: `Install Vetra on ${ORG_LOGIN} or choose your personal account`,
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("caller no longer an org member is refused", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const calls = realGithub({
      [`GET /app/installations/${ORG_INSTALLATION}`]: selection(),
      // GitHub answers 404 for an organisation the user is not a member of.
    });

    expect(
      await failure(
        attachStudioRepository(h.deps, owner, {
          appId: p.app.id,
          installationId: ORG_INSTALLATION,
        }),
      ),
    ).toStrictEqual({
      code: "INSUFFICIENT_PERMISSION",
      message: `Install Vetra on ${ORG_LOGIN} or choose your personal account`,
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    // A pending invitation is not membership either.
    h.deps.github = h.github;
    h.github.memberships.set(ORG_LOGIN, { state: "pending", role: "member" });
    expect(
      await code(
        attachStudioRepository(h.deps, owner, {
          appId: p.app.id,
          installationId: ORG_INSTALLATION,
        }),
      ),
    ).toBe("INSUFFICIENT_PERMISSION");
    expect(h.github.calls.createRepoAsUser).toBeUndefined();
  });

  it("the product's bound agent key, strangers and installations the owner never connected are refused", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    expect(
      await code(
        attachStudioRepository(h.deps, agent, { appId: p.app.id, installationId: PERSONAL }),
      ),
    ).toBe("FORBIDDEN");
    const stranger: Caller = {
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chainId: 1,
      appKey: null,
      isAdmin: false,
    };
    expect(
      await code(
        attachStudioRepository(h.deps, stranger, { appId: p.app.id, installationId: PERSONAL }),
      ),
    ).toBe("FORBIDDEN");
    // An installation the owner never connected.
    expect(
      await code(
        attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: "12345" }),
      ),
    ).toBe("GITHUB_NOT_CONNECTED");
    expect(h.github.calls.createRepoAsUser).toBeUndefined();
  });

  it("a request through the Studio-agent path is refused, even with a key not bound to any App", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const unbound: Caller = { ...agent, appKey: "did:key:zDnaeNotBoundYet" };
    expect(
      await code(
        attachStudioRepository(
          h.deps,
          unbound,
          { appId: p.app.id, installationId: PERSONAL },
          { kind: "agent", secret: p.secret },
        ),
      ),
    ).toBe("FORBIDDEN");
    const resolvers = createResolvers(h.deps);
    const viaGraphql = (
      resolvers.Mutation.attachStudioRepository as (...a: unknown[]) => Promise<unknown>
    )(
      null,
      { input: { appId: p.app.id, installationId: PERSONAL } },
      {
        user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: "did:key:zDnaeNotBoundYet" },
        headers: { [STUDIO_SECRET_HEADER]: "" },
      },
    );
    expect(await code(viaGraphql)).toBe("FORBIDDEN");
    expect(h.github.calls.createRepoAsUser).toBeUndefined();
  });

  it("a replica that recorded a repository first wins; the second repository is kept, never deleted", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const create = h.github.createRepoAsUser;
    h.github.createRepoAsUser = async (...args) => {
      const made = await create(...args);
      // Another replica recorded its repository meanwhile.
      await h.db
        .updateTable("apps")
        .set({
          installation_id: PERSONAL,
          repository_id: "7777",
          repository_full_name: "frank/winner",
        })
        .where("id", "=", p.app.id)
        .execute();
      return made;
    };
    const app = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    expect(app.repository_full_name).toBe("frank/winner");
    expect(h.github.calls.deleteRepo).toBeUndefined();
    expect(h.github.calls.deleteRepoAsUser).toBeUndefined();
    const info = (h.deps.logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(JSON.stringify(info)).toContain(`frank/${p.app.slug}`);
  });

  it("a product already on GitHub is not given a second repository", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    await attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: PERSONAL });
    expect(
      await code(
        attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: PERSONAL }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(h.github.calls.createRepoAsUser).toHaveLength(1);
  });

  it("GitHub disconnecting never blocks the product; connecting again makes a new repository", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const attached = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    const body = JSON.stringify({
      action: "removed",
      installation: { id: Number(PERSONAL) },
      repositories_removed: [{ id: Number(attached.repository_id) }],
    });
    const signature = `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`;
    await handleGithubWebhook(h.deps, {
      rawBody: Buffer.from(body),
      signature,
      event: "installation_repositories",
    });

    const after = (await getApp(h.db, p.app.id))!;
    expect(after.status).toBe("ACTIVE");
    expect(after.repository_disconnected_at).not.toBeNull();
    // Live still launches.
    expect(
      await code(
        launchStudioVersion(
          h.deps,
          agent,
          {
            appId: p.app.id,
            versionNumber: 1,
            sha: "1111111aaaaaaa",
            gitTag: "v1",
            packages: [{ name: "@vetra-apps/my-shop", version: "0.1.0" }],
          },
          p.secret,
        ),
      ),
    ).toBe("OK");
    // No push token for a disconnected repository.
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    const again = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    expect(again.repository_full_name).toBe(`frank/${p.app.slug}-2`);
    expect(again.repository_disconnected_at).toBeNull();
  });
});

describe("a Studio product on GitHub stays a Studio product (D15)", () => {
  it("keeps following its agent's key, gets no deploy workflow and no CI identity", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    await attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: PERSONAL });

    // The Studio's agent came back with a new key: the product follows it.
    const renewed: Caller = { ...agent, appKey: "did:key:zDnaeStudioAgentRenewed" };
    const again = await ensureStudioProduct(
      h.deps,
      renewed,
      { studioEnvironmentId: p.studioId, name: "My Shop" },
      { kind: "agent", secret: p.secret },
    );
    expect(again.identity_did).toBe("did:key:zDnaeStudioAgentRenewed");
    // ...so the owner-only paths go on refusing the agent.
    expect(await code(confirmAppIdentity(h.deps, renewed, p.app.id))).toBe("FORBIDDEN");

    expect(await code(openAppSetupPullRequest(h.deps, owner, p.app.id))).toBe("BAD_USER_INPUT");
    expect(h.github.calls.openPullRequestWithFile).toBeUndefined();
    // No Renown workload identity to confirm.
    expect((await confirmAppIdentity(h.deps, owner, p.app.id)).status).toBe("ACTIVE");
    expect(h.renown.registered).toHaveLength(0);
  });
});

describe("a Studio product on GitHub never deploys through CI", () => {
  const routesFor = (appDid: string, repositoryId: string) => {
    const verify: CiTokenVerifier = async (token) =>
      token === "expired"
        ? { identityExpired: { appDid, address: OWNER } }
        : {
            address: OWNER,
            chainId: 1,
            appDid,
            claim: {
              repositoryId,
              refClass: "PRODUCTION",
              ref: "refs/heads/main",
              eventName: "push",
              sha: "abcdef1234567",
            } as never,
          };
    return createCiRoutes(h.deps, verify);
  };
  const post = (path: string, body: unknown, token = "good") =>
    new Request(`https://switchboard.vetra.io/api/x/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const deployBody = (appId: string) => ({
    appId,
    kind: "PRODUCTION",
    gitRef: "refs/heads/main",
    sha: "abcdef1234567",
    packages: [{ name: "@vetra-apps/my-shop", version: "0.1.0" }],
  });

  it("a token of the agent's key is refused on every CI route and cannot expire the product", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const attached = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    const routes = routesFor(AGENT_KEY, attached.repository_id!);

    const deploy = await routes.deploy(post("apps/ci/deploy", deployBody(p.app.id)));
    expect(deploy.status).toBe(403);
    expect(await deploy.json()).toMatchObject({ error: "FORBIDDEN" });
    const artifacts = await routes.artifacts(
      post("apps/ci/artifacts", {
        appId: p.app.id,
        kind: "PACKAGE",
        name: "@vetra-apps/my-shop",
        version: "0.1.0",
        reference: "@vetra-apps/my-shop@0.1.0",
      }),
    );
    expect(artifacts.status).toBe(403);
    const creds = await routes.registryCredentials(
      post("apps/ci/registry-credentials", { appId: p.app.id }),
    );
    expect(creds.status).toBe(403);

    const expired = await routes.deploy(post("apps/ci/deploy", deployBody(p.app.id), "expired"));
    expect(expired.status).toBe(401);
    expect((await getApp(h.db, p.app.id))!.status).toBe("ACTIVE");
    expect(await h.db.selectFrom("app_deployments").select("id").execute()).toHaveLength(0);
  });

  it("an App made by createStudioApp (with CI) deploys through CI as before", async () => {
    const studio = await h.envs.seedStandalone(OWNER);
    await h.envs.execute(studio, [
      addPackage({
        packageName: "vetra",
        version: "0.0.1-dev.27",
        registry: "https://registry.dev.vetra.io",
      }),
      approveChanges({}),
    ]);
    await connectGithubDeploy(h.deps, owner, "code");
    const legacy = await createStudioApp(h.deps, owner, {
      name: "Legacy Shop",
      studioEnvironmentId: studio,
      installationId: INSTALLATION,
    });
    const active = await confirmAppIdentity(h.deps, owner, legacy.id);
    expect(active.status).toBe("ACTIVE");
    h.envs.setStatus(active.production_environment_id, "READY");
    const routes = routesFor(active.identity_did, active.repository_id!);
    const deploy = await routes.deploy(post("apps/ci/deploy", deployBody(active.id)));
    expect(deploy.status).toBe(200);
    const creds = await routes.registryCredentials(
      post("apps/ci/registry-credentials", { appId: active.id }),
    );
    expect(creds.status).toBe(200);
  });

  it("no branch change, no Renown identity delete, no GitHub deployment reports, not on old Apps pages", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    await attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: PERSONAL });

    expect(await code(updateApp(h.deps, owner, p.app.id, { productionBranch: "dev" }))).toBe(
      "BAD_USER_INPUT",
    );
    expect(h.renown.updated).toHaveLength(0);

    expect((await myApps(h.deps, owner)).map((a) => a.id)).not.toContain(p.app.id);
    expect(
      (await myApps(h.deps, owner, null, { includeStudioProducts: true })).map((a) => a.id),
    ).toContain(p.app.id);

    const d = await launchStudioVersion(
      h.deps,
      agent,
      {
        appId: p.app.id,
        versionNumber: 1,
        sha: "1111111aaaaaaa",
        gitTag: "v1",
        packages: [{ name: "@vetra-apps/my-shop", version: "0.1.0" }],
      },
      p.secret,
    );
    await reportDeploymentToGithub(h.deps, d.id);
    expect(h.github.calls.createDeployment).toBeUndefined();
    expect(h.github.calls.createDeploymentStatus).toBeUndefined();

    expect(await deleteApp(h.deps, owner, p.app.id, false)).toBe(true);
    expect(h.renown.deleted).toHaveLength(0);
  });
});

describe("studioPushToken (D20 binding)", () => {
  it("push token is scoped to the App's repo and never returned to another Studio", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const attached = await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: PERSONAL,
    });
    const other = await seedProduct("Other Shop", otherAgent);

    const expiresAt = new Date(h.clock.now.getTime() + 3_600_000).toISOString();
    const calls = realGithub({
      [`POST /app/installations/${PERSONAL}/access_tokens`]: () =>
        Response.json({ token: "ghs_scoped", expires_at: expiresAt }, { status: 201 }),
    });

    const t = await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(t.token).toBe("ghs_scoped");
    expect(t.remoteUrl).toBe(`https://github.com/frank/${p.app.slug}.git`);
    expect(t.remoteUrl).not.toContain("ghs_");
    expect(Date.parse(t.expiresAt) - h.clock.now.getTime()).toBeLessThanOrEqual(3_600_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe("Bearer ghs_app_jwt");
    expect(calls[0].body).toStrictEqual({
      repository_ids: [Number(attached.repository_id)],
      permissions: { contents: "write" },
    });

    // The other Studio's agent, with its own valid secret, gets nothing for this App.
    expect(await code(studioPushToken(h.deps, otherAgent, p.app.id, other.secret))).toBe(
      "STUDIO_BINDING",
    );
    // Nor does this App's id with a wrong secret, or the owner's browser.
    expect(await code(studioPushToken(h.deps, agent, p.app.id, other.secret))).toBe(
      "STUDIO_BINDING",
    );
    expect(await code(studioPushToken(h.deps, owner, p.app.id, null))).toBe("STUDIO_BINDING");
    // A product without GitHub has nothing to push to.
    expect(await code(studioPushToken(h.deps, otherAgent, other.app.id, other.secret))).toBe(
      "GITHUB_NOT_CONNECTED",
    );
    expect(calls).toHaveLength(1);

    // Never logged.
    const logger = h.deps.logger as unknown as Record<string, { mock: { calls: unknown[][] } }>;
    for (const level of ["info", "warn", "error"]) {
      expect(JSON.stringify(logger[level].mock.calls)).not.toContain("ghs_scoped");
    }
  });

  it("a token GitHub hands out for longer is reported as at most one hour", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    await attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: PERSONAL });
    h.github.createRepoPushToken = async () => ({
      token: "ghs_long",
      expiresAt: new Date(h.clock.now.getTime() + 8 * 3_600_000).toISOString(),
    });
    const t = await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(Date.parse(t.expiresAt) - h.clock.now.getTime()).toBeLessThanOrEqual(3_600_000);
  });

  it("is served over GraphQL to the agent with the launch secret header", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    const resolvers = createResolvers(h.deps);
    const attached = await (
      resolvers.Mutation.attachStudioRepository as (...a: unknown[]) => Promise<{
        repository: { fullName: string; accountLogin: string; accountType: string } | null;
      }>
    )(
      null,
      { input: { appId: p.app.id, installationId: PERSONAL } },
      { user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: "did:key:zDnaeOwnerBrowser" } },
    );
    expect(attached.repository).toMatchObject({
      fullName: `frank/${p.app.slug}`,
      accountLogin: "frank",
      accountType: "User",
    });
    const t = await (
      resolvers.Mutation.studioPushToken as (...a: unknown[]) => Promise<{
        token: string;
        remoteUrl: string;
      }>
    )(
      null,
      { appId: p.app.id },
      {
        user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: AGENT_KEY },
        headers: { [STUDIO_SECRET_HEADER]: p.secret },
      },
    );
    expect(t.token).toMatch(/^ghs_push_/);
    expect(t.remoteUrl).toBe(`https://github.com/frank/${p.app.slug}.git`);
  });

  it("GitHub refusing the token (403/404/422) reads as not connected", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    await attachStudioRepository(h.deps, owner, { appId: p.app.id, installationId: PERSONAL });
    for (const status of [403, 404, 422]) {
      h.github.createRepoPushToken = async () => {
        throw new GithubHttpError(status, "refused");
      };
      expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
        "GITHUB_NOT_CONNECTED",
      );
    }
  });

  it("an organisation repository needs the owner to still be an active member", async () => {
    const p = await seedProduct();
    await connectGithubDeploy(h.deps, owner, "code");
    await attachStudioRepository(h.deps, owner, {
      appId: p.app.id,
      installationId: ORG_INSTALLATION,
    });
    expect((await studioPushToken(h.deps, agent, p.app.id, p.secret)).token).toMatch(/^ghs_push_/);

    h.github.memberships.set(ORG_LOGIN, null);
    expect(await failure(studioPushToken(h.deps, agent, p.app.id, p.secret))).toStrictEqual({
      code: "INSUFFICIENT_PERMISSION",
      message: `Install Vetra on ${ORG_LOGIN} or choose your personal account`,
    });
    h.github.memberships.set(ORG_LOGIN, { state: "pending", role: "member" });
    expect(await code(studioPushToken(h.deps, agent, p.app.id, p.secret))).toBe(
      "INSUFFICIENT_PERMISSION",
    );

    // The app may not read memberships: GitHub's own checks decide; logged without secrets.
    h.github.getOrgMembership = async () => {
      throw new GithubHttpError(403, "Resource not accessible by integration", [
        "Resource not accessible by integration",
      ]);
    };
    const t = await studioPushToken(h.deps, agent, p.app.id, p.secret);
    expect(t.token).toMatch(/^ghs_push_/);
    const warn = JSON.stringify(
      (h.deps.logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    );
    expect(warn).toContain("membership");
    expect(warn).not.toContain("ghs_");
    expect(warn).not.toContain("user-token");
  });

  it("an App deployed by its own CI gets no Studio push token", async () => {
    const studio = await h.envs.seedStandalone(OWNER);
    await h.envs.execute(studio, [
      addPackage({
        packageName: "vetra",
        version: "0.0.1-dev.27",
        registry: "https://registry.dev.vetra.io",
      }),
      approveChanges({}),
    ]);
    const secret = randomBytes(32).toString("hex");
    await storeLaunchSecretHash(h.db, studio, hashLaunchSecret(secret), "2026-10-20T00:00:00.000Z");
    await connectGithubDeploy(h.deps, owner, "code");
    const legacy = await createStudioApp(h.deps, owner, {
      name: "Legacy Shop",
      studioEnvironmentId: studio,
      installationId: INSTALLATION,
    });
    expect(await code(studioPushToken(h.deps, agent, legacy.id, secret))).toBe("BAD_USER_INPUT");
    expect(h.github.calls.createRepoPushToken).toBeUndefined();
  });
});
