import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildASTSchema, type GraphQLObjectType } from "graphql";
import { schema } from "../schema.js";
import { createResolvers } from "../resolvers.js";
import {
  bearerHasVetraClaim,
  parseVetraClaim,
  requireCaller,
} from "../auth.js";
import { loadAppsConfig, missingConfig } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { workflowTemplate } from "../workflow-template.js";
import { createHarborApi } from "../harbor.js";
import { createRenownApi } from "../renown.js";
import { envUrls } from "../envs.js";
import type { AppRow } from "../repo.js";
import {
  APP_DID,
  OWNER,
  USER_KEY,
  makeHarness,
  seedActiveApp,
  type Harness,
} from "./harness.js";

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) =>
  `${b64({ alg: "ES256" })}.${b64(payload)}.sig`;

const identityCtx = (payload: Record<string, unknown> | null) => ({
  user: { address: OWNER, chainId: 1, networkId: "eip155", appKey: APP_DID },
  headers: payload ? { authorization: `Bearer ${jwt(payload)}` } : {},
});

describe("SDL", () => {
  it("builds, and every Query/Mutation field has a resolver", () => {
    const built = buildASTSchema(schema);
    const resolvers = createResolvers({} as never);
    for (const [type, impl] of [
      ["Query", resolvers.Query],
      ["Mutation", resolvers.Mutation],
    ] as const) {
      const fields = Object.keys(
        (built.getType(type) as GraphQLObjectType).getFields(),
      ).sort();
      expect(Object.keys(impl).sort()).toStrictEqual(fields);
    }
  });
});

describe("vetra claim parsing", () => {
  it("parseVetraClaim keeps C1 fields incl. eventName and rejects malformed claims", () => {
    expect(
      parseVetraClaim({
        ref: "refs/heads/main",
        refClass: "PRODUCTION",
        eventName: "push",
        prNumber: null,
        runId: 5,
      }),
    ).toMatchObject({
      ref: "refs/heads/main",
      refClass: "PRODUCTION",
      eventName: "push",
      prNumber: null,
      runId: "5",
    });
    expect(parseVetraClaim({ ref: 1 })).toBeNull();
    expect(parseVetraClaim(null)).toBeNull();
  });

  it("bearerHasVetraClaim spots CI tokens, whoever issued them", () => {
    expect(
      bearerHasVetraClaim(
        identityCtx({ iss: "did:key:any", vetra: { ref: "x" } }),
      ),
    ).toBe(true);
    expect(bearerHasVetraClaim(identityCtx({ iss: APP_DID }))).toBe(false);
    expect(bearerHasVetraClaim(identityCtx(null))).toBe(false);
    expect(
      bearerHasVetraClaim({ headers: { authorization: "Bearer not-a-jwt" } }),
    ).toBe(false);
  });

  it("requireCaller lowercases and flags admins", () => {
    vi.stubEnv("ADMINS", OWNER.toUpperCase().replace("0X", "0x"));
    expect(
      requireCaller({
        user: {
          address: OWNER.toUpperCase(),
          chainId: 1,
          networkId: "eip155",
          appKey: USER_KEY,
        },
      }),
    ).toStrictEqual({
      address: OWNER,
      chainId: 1,
      appKey: USER_KEY,
      isAdmin: true,
    });
    vi.unstubAllEnvs();
    expect(() => requireCaller({})).toThrow(/Sign in/);
  });
});

describe("resolvers", () => {
  let h: Harness;
  let app: AppRow;
  beforeEach(async () => {
    h = await makeHarness();
    app = await seedActiveApp(h);
  });
  afterEach(async () => {
    await h.close();
  });

  const deployInput = () => ({
    appId: app.id,
    kind: "PRODUCTION" as const,
    gitRef: "refs/heads/main",
    sha: "abcdef1234567",
    packages: [],
  });

  it("deployApp works for the owner and resolves URLs; CI bearers are refused", async () => {
    const r = createResolvers(h.deps);
    const ownerCtx = {
      user: {
        address: OWNER,
        chainId: 1,
        networkId: "eip155",
        appKey: USER_KEY,
      },
      headers: {},
    };
    const ok = await r.Mutation.deployApp(
      null,
      { input: deployInput() },
      ownerCtx,
    );
    expect(ok).toMatchObject({ kind: "PRODUCTION", packages: [] });
    expect(await ok.urls()).toMatchObject({
      connect: expect.stringContaining("-connect.vetra.io"),
    });
    await expect(
      r.Mutation.deployApp(
        null,
        { input: deployInput() },
        identityCtx({ iss: APP_DID, vetra: { ref: "refs/heads/main" } }),
      ),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("maps Apps with repository, URLs, previews and latest deployment", async () => {
    const r = createResolvers(h.deps);
    const ctx = {
      user: {
        address: OWNER,
        chainId: 1,
        networkId: "eip155",
        appKey: USER_KEY,
      },
      headers: {},
    };
    await r.Mutation.deployApp(
      null,
      {
        input: {
          ...deployInput(),
          kind: "PREVIEW",
          prNumber: 3,
          gitRef: "refs/pull/3/merge",
        },
      },
      ctx,
    );
    const [mapped] = await r.Query.myApps(null, {}, ctx);
    expect(mapped).toMatchObject({
      id: app.id,
      repository: {
        fullName: "acme/shop",
        repositoryId: "4242",
        installationId: "77",
      },
      status: "ACTIVE",
      identityDid: APP_DID,
    });
    expect(await mapped.productionUrls()).toMatchObject({
      switchboard: expect.stringContaining("-switchboard.vetra.io"),
    });
    const previews = await mapped.previews();
    expect(previews).toMatchObject([
      {
        prNumber: 3,
        prUrl: "https://github.com/acme/shop/pull/3",
        status: "DEPLOYING",
      },
    ]);
    expect((await mapped.latestDeployment())?.prNumber).toBe(3);
    expect(await r.Query.app(null, { id: "missing" }, ctx)).toBeNull();
    expect(
      await r.Query.appDeployments(null, { appId: app.id, limit: 1 }, ctx),
    ).toHaveLength(1);
  });

  it("hides upstream failures behind a generic error", async () => {
    const r = createResolvers({
      ...h.deps,
      github: {
        ...h.github,
        openPullRequestWithFile: async () => {
          throw new Error("token ghs_secret leaked");
        },
      },
    });
    const ctx = {
      user: {
        address: OWNER,
        chainId: 1,
        networkId: "eip155",
        appKey: USER_KEY,
      },
      headers: {},
    };
    await expect(
      r.Mutation.openAppSetupPullRequest(null, { appId: app.id }, ctx),
    ).rejects.toMatchObject({
      message: "openAppSetupPullRequest failed",
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  });

  it("requires authentication", async () => {
    const r = createResolvers(h.deps);
    await expect(r.Query.myApps(null, {}, {})).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });
});

describe("config", () => {
  it("loads nothing optional from an empty env without throwing", () => {
    const cfg = loadAppsConfig({});
    expect(cfg).toMatchObject({
      github: null,
      harbor: null,
      renown: null,
      encryptionKey: null,
      webhookSecret: null,
      vetraAppUrl: "https://vetra.io",
    });
    expect(missingConfig(cfg)).toHaveLength(5);
  });

  it("reads every group, unescapes the private key and validates the encryption key", () => {
    const cfg = loadAppsConfig({
      GITHUB_DEPLOY_APP_ID: "1",
      GITHUB_DEPLOY_APP_SLUG: "vetra-deploy",
      GITHUB_DEPLOY_APP_CLIENT_ID: "c",
      GITHUB_DEPLOY_APP_CLIENT_SECRET: "s",
      GITHUB_DEPLOY_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----",
      GITHUB_DEPLOY_APP_WEBHOOK_SECRET: "w",
      HARBOR_APPS_ADMIN_USERNAME: "u",
      HARBOR_APPS_ADMIN_PASSWORD: "p",
      RENOWN_WORKLOAD_REGISTRATION_TOKEN: "t",
      VETRA_APPS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      VETRA_APP_URL: "https://staging.vetra.io/",
    });
    expect(cfg.github?.privateKey).toBe("-----BEGIN-----\nabc\n-----END-----");
    expect(cfg.harbor?.url).toBe("https://cr.vetra.io");
    expect(cfg.renown?.switchboardUrl).toBe(
      "https://switchboard.renown.vetra.io",
    );
    expect(cfg.encryptionKey?.length).toBe(32);
    expect(cfg.vetraAppUrl).toBe("https://staging.vetra.io");
    expect(missingConfig(cfg)).toStrictEqual([]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      loadAppsConfig({ VETRA_APPS_ENCRYPTION_KEY: "c2hvcnQ=" }).encryptionKey,
    ).toBeNull();
  });
});

describe("crypto", () => {
  it("round-trips and detects tampering", () => {
    const key = Buffer.alloc(32, 3);
    const sealed = encryptSecret(key, "robot-secret");
    expect(sealed).not.toContain("robot-secret");
    expect(decryptSecret(key, sealed)).toBe("robot-secret");
    expect(() => decryptSecret(Buffer.alloc(32, 4), sealed)).toThrow();
    expect(() => decryptSecret(key, "v0.x")).toThrow();
  });
});

describe("workflow template", () => {
  it("fills the App id and a non-default production branch", () => {
    expect(workflowTemplate("app-1")).toContain("branches: [main]");
    const t = workflowTemplate("app-1", "release");
    expect(t).toContain('branches: ["release"]');
    expect(t).toContain('production-branch: "release"');
    expect(t).toContain("app-id: app-1");
  });
});

describe("HTTP clients", () => {
  it("Harbor: creates a private project (409 ok) and a project push robot", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith("/projects"))
        return new Response(null, { status: calls.length === 1 ? 201 : 409 });
      return Response.json(
        { name: "robot$app-x+vetra-deploy-1", secret: "s" },
        { status: 201 },
      );
    });
    const harbor = createHarborApi(
      { url: "https://cr.vetra.io", username: "u", password: "p" },
      fetchImpl as never,
    );
    await harbor.ensureProject("app-x");
    await harbor.ensureProject("app-x");
    expect(await harbor.createPushRobot("app-x")).toStrictEqual({
      name: "robot$app-x+vetra-deploy-1",
      secret: "s",
    });
    expect(calls[0]).toStrictEqual({
      url: "https://cr.vetra.io/api/v2.0/projects",
      body: { project_name: "app-x", metadata: { public: "false" } },
    });
    expect(calls[2].body).toMatchObject({
      level: "project",
      duration: -1,
      permissions: [
        {
          kind: "project",
          namespace: "app-x",
          access: [
            { resource: "repository", action: "push" },
            { resource: "repository", action: "pull" },
          ],
        },
      ],
    });
  });

  it("Renown: sends the registration token and checks the delegation credential", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit) => {
      seen.push({
        url: String(url),
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (String(url).includes("/api/auth/credential")) {
        return Response.json({
          credential: {
            issuer: { id: `did:pkh:eip155:1:${OWNER}` },
            credentialSubject: { id: APP_DID },
          },
        });
      }
      return Response.json({
        data: { registerWorkloadIdentity: { did: APP_DID } },
      });
    });
    const renown = createRenownApi(
      {
        switchboardUrl: "https://switchboard.renown.vetra.io",
        registrationToken: "tok",
      },
      "https://www.renown.id",
      fetchImpl as never,
    );
    expect(
      await renown.registerWorkloadIdentity({
        repositoryId: "1",
        repository: "a/b",
        productionBranch: "main",
        ownerAddress: OWNER,
        chainId: 1,
      }),
    ).toStrictEqual({ did: APP_DID });
    expect(seen[0].url).toBe(
      "https://switchboard.renown.vetra.io/graphql/renown-workload",
    );
    expect(seen[0].headers["x-renown-workload-registration-token"]).toBe("tok");
  });

  it("Renown: the delegation check uses @renown/sdk with EIP-712 proof verification", async () => {
    const fetchDelegation = vi.fn(async (o: { appDid: string }) =>
      o.appDid === APP_DID ? ({ id: "cred" } as never) : undefined,
    );
    const renown = createRenownApi(
      { switchboardUrl: "https://r", registrationToken: "tok" },
      "https://www.renown.id",
      fetch,
      fetchDelegation,
    );
    expect(
      await renown.hasDelegation({ address: OWNER, chainId: 1, did: APP_DID }),
    ).toBe(true);
    expect(fetchDelegation).toHaveBeenCalledWith({
      address: OWNER,
      chainId: 1,
      appDid: APP_DID,
      baseUrl: "https://www.renown.id",
      discover: false,
      verifySignature: true,
    });
    expect(
      await renown.hasDelegation({
        address: OWNER,
        chainId: 1,
        did: "did:key:other",
      }),
    ).toBe(false);
  });

  it("Renown: an unsigned credential (no EIP-712 proof) does not count as a delegation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          credential: {
            issuer: { id: `did:pkh:eip155:1:${OWNER}`, ethereumAddress: OWNER },
            credentialSubject: { id: APP_DID },
          },
        }),
      ),
    );
    const renown = createRenownApi(
      { switchboardUrl: "https://r", registrationToken: "tok" },
      "https://www.renown.id",
    );
    expect(
      await renown.hasDelegation({ address: OWNER, chainId: 1, did: APP_DID }),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("Renown: surfaces GraphQL error codes", async () => {
    const renown = createRenownApi(
      { switchboardUrl: "https://r", registrationToken: "tok" },
      "https://www.renown.id",
      (async () =>
        Response.json({
          errors: [{ message: "taken", extensions: { code: "CONFLICT" } }],
        })) as never,
    );
    await expect(renown.deleteWorkloadIdentity("d")).rejects.toThrow(
      /CONFLICT/,
    );
  });
});

describe("envUrls", () => {
  it("is empty for an uninitialised env", () => {
    expect(envUrls(null)).toStrictEqual({
      app: null,
      connect: null,
      switchboard: null,
    });
  });
});
