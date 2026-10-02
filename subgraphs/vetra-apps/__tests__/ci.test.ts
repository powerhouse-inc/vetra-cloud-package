import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthBearerToken,
  MemoryKeyStorage,
  RenownCryptoBuilder,
} from "@renown/sdk/node";
import {
  createCiRoutes,
  createRenownCiVerifier,
  type CiTokenVerifier,
} from "../ci.js";
import { createResolvers } from "../resolvers.js";
import { getApp, getDeployment, type AppRow } from "../repo.js";
import {
  APP_DID,
  OWNER,
  REPO_ID,
  USER_KEY,
  makeHarness,
  seedActiveApp,
  type Harness,
} from "./harness.js";

const AUDIENCE =
  "https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/apps";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

let h: Harness;
let app: AppRow;
beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
  h.envs.setStatus(app.production_environment_id, "READY");
});
afterEach(async () => {
  await h.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const prodClaim = {
  ref: "refs/heads/main",
  refClass: "PRODUCTION",
  eventName: "push",
  sha: SHA,
  repository: "acme/shop",
  repositoryId: REPO_ID,
  actor: "octocat",
  runId: "1",
};
const prClaim = (n: number, over: Record<string, unknown> = {}) => ({
  ...prodClaim,
  ref: `refs/pull/${n}/merge`,
  refClass: "PREVIEW",
  eventName: "pull_request",
  prNumber: n,
  ...over,
});

/** Fake verifier: token "good:<json claim>" → the App identity with that claim. */
const fakeVerifier: CiTokenVerifier = async (token) => {
  if (!token.startsWith("good:")) return null;
  return {
    address: OWNER,
    chainId: 1,
    appDid: APP_DID,
    claim: JSON.parse(token.slice(5)) as never,
  };
};
const bearer = (claim: unknown) => `Bearer good:${JSON.stringify(claim)}`;

const post = (path: string, auth: string | null, body: unknown) =>
  new Request(
    `https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
const get = (path: string, auth: string | null) =>
  new Request(
    `https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/${path}`,
    {
      headers: auth ? { authorization: auth } : {},
    },
  );

const deployBody = (over: Record<string, unknown> = {}) => ({
  appId: app.id,
  kind: "PRODUCTION",
  prNumber: null,
  gitRef: "refs/heads/main",
  sha: SHA,
  runUrl: "https://github.com/acme/shop/actions/runs/1",
  actorGithub: "someone",
  packages: [{ name: "@acme/shop", version: "1.0.0-main.1.abcdef1" }],
  imageTag: null,
  ...over,
});

describe("CI routes: happy paths", () => {
  it("POST apps/ci/registry-credentials returns the robot", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    const res = await routes.registryCredentials(
      post("apps/ci/registry-credentials", bearer(prodClaim), {
        appId: app.id,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      registry: "cr.vetra.io",
      project: "app-shop",
      username: "robot$app-shop+vetra-deploy-abc123",
      password: "robot-secret",
    });
  });

  it("POST apps/ci/deploy (production) and GET apps/ci/deployments/:id", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    const res = await routes.deploy(
      post("apps/ci/deploy", bearer(prodClaim), deployBody()),
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as Record<string, unknown>;
    expect(d).toMatchObject({
      appId: app.id,
      kind: "PRODUCTION",
      status: "DEPLOYING",
      gitRef: "refs/heads/main",
      sha: SHA,
      actorDid: APP_DID,
      actorGithub: "octocat",
      packages: [{ name: "@acme/shop", version: "1.0.0-main.1.abcdef1" }],
      imageTag: null,
      prNumber: null,
      urls: {
        connect: expect.stringContaining("-connect.vetra.io"),
        app: null,
      },
    });
    const got = await routes.deployment(
      get(`apps/ci/deployments/${String(d.id)}`, bearer(prodClaim)),
      String(d.id),
    );
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: d.id, status: "DEPLOYING" });
    const missing = await routes.deployment(
      get("apps/ci/deployments/nope", bearer(prodClaim)),
      "nope",
    );
    expect(missing.status).toBe(404);
  });

  it("POST apps/ci/deploy (preview) from its own PR", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    const res = await routes.deploy(
      post(
        "apps/ci/deploy",
        bearer(prClaim(7)),
        deployBody({
          kind: "PREVIEW",
          prNumber: 7,
          gitRef: "refs/pull/7/merge",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "PREVIEW",
      prNumber: 7,
      status: "DEPLOYING",
    });
  });
});

describe("CI routes: authorization", () => {
  const status = async (res: Promise<Response>) => {
    const r = await res;
    return [r.status, ((await r.json()) as { error: string }).error];
  };

  it("401 without or with an unverifiable bearer", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    expect(
      await status(routes.deploy(post("apps/ci/deploy", null, deployBody()))),
    ).toStrictEqual([401, "UNAUTHENTICATED"]);
    expect(
      await status(
        routes.deploy(post("apps/ci/deploy", "Bearer junk", deployBody())),
      ),
    ).toStrictEqual([401, "UNAUTHENTICATED"]);
  });

  it("a PR token cannot deploy PRODUCTION (403), nor another PR", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    expect(
      await status(
        routes.deploy(post("apps/ci/deploy", bearer(prClaim(7)), deployBody())),
      ),
    ).toStrictEqual([403, "FORBIDDEN"]);
    expect(
      await status(
        routes.deploy(
          post(
            "apps/ci/deploy",
            bearer(prClaim(7)),
            deployBody({
              kind: "PREVIEW",
              prNumber: 8,
              gitRef: "refs/pull/8/merge",
            }),
          ),
        ),
      ),
    ).toStrictEqual([403, "FORBIDDEN"]);
    expect(
      await h.db.selectFrom("app_deployments").selectAll().execute(),
    ).toStrictEqual([]);
  });

  it("pull_request_target-like claims (eventName ≠ pull_request) cannot deploy previews", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    const body = deployBody({
      kind: "PREVIEW",
      prNumber: 7,
      gitRef: "refs/pull/7/merge",
    });
    for (const eventName of [
      "pull_request_target",
      "workflow_run",
      undefined,
    ]) {
      expect(
        await status(
          routes.deploy(
            post("apps/ci/deploy", bearer(prClaim(7, { eventName })), body),
          ),
        ),
      ).toStrictEqual([403, "FORBIDDEN"]);
    }
  });

  it("production needs refClass PRODUCTION and a push/workflow_dispatch event", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    for (const claim of [
      { ...prodClaim, refClass: "RELEASE" },
      { ...prodClaim, eventName: "pull_request" },
      { ...prodClaim, ref: "refs/heads/dev" },
      { ...prodClaim, repositoryId: "1" },
    ]) {
      expect(
        await status(
          routes.deploy(post("apps/ci/deploy", bearer(claim), deployBody())),
        ),
      ).toStrictEqual([403, "FORBIDDEN"]);
    }
    const dispatch = await routes.deploy(
      post(
        "apps/ci/deploy",
        bearer({ ...prodClaim, eventName: "workflow_dispatch" }),
        deployBody(),
      ),
    );
    expect(dispatch.status).toBe(200);
  });

  it("the issuer must be this App's identity acting for the owner", async () => {
    const other: CiTokenVerifier = async () => ({
      address: OWNER,
      chainId: 1,
      appDid: "did:key:zOther",
      claim: prodClaim as never,
    });
    const foreign: CiTokenVerifier = async () => ({
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
      appDid: APP_DID,
      claim: prodClaim as never,
    });
    expect(
      await status(
        createCiRoutes(h.deps, other).deploy(
          post("apps/ci/deploy", "Bearer x", deployBody()),
        ),
      ),
    ).toStrictEqual([403, "FORBIDDEN"]);
    expect(
      await status(
        createCiRoutes(h.deps, foreign).registryCredentials(
          post("apps/ci/registry-credentials", "Bearer x", { appId: app.id }),
        ),
      ),
    ).toStrictEqual([403, "FORBIDDEN"]);
  });

  it("maps input and state errors to 400/404", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    expect(
      await status(
        routes.deploy(post("apps/ci/deploy", bearer(prodClaim), "{not json")),
      ),
    ).toStrictEqual([400, "BAD_USER_INPUT"]);
    expect(
      await status(
        routes.deploy(
          post("apps/ci/deploy", bearer(prodClaim), deployBody({ sha: "x" })),
        ),
      ),
    ).toStrictEqual([400, "BAD_USER_INPUT"]);
    expect(
      await status(
        routes.deploy(
          post(
            "apps/ci/deploy",
            bearer(prodClaim),
            deployBody({ appId: "missing" }),
          ),
        ),
      ),
    ).toStrictEqual([404, "NOT_FOUND"]);
    await h.db.updateTable("apps").set({ status: "DISCONNECTED" }).execute();
    expect(
      await status(
        routes.deploy(post("apps/ci/deploy", bearer(prodClaim), deployBody())),
      ),
    ).toStrictEqual([400, "APP_NOT_ACTIVE"]);
  });

  it("503 when the robot secret cannot be decrypted (no key configured)", async () => {
    const routes = createCiRoutes(
      { ...h.deps, cfg: { ...h.deps.cfg, encryptionKey: null } },
      fakeVerifier,
    );
    const r = await routes.registryCredentials(
      post("apps/ci/registry-credentials", bearer(prodClaim), {
        appId: app.id,
      }),
    );
    expect(r.status).toBe(503);
  });

  it("a deployment of another App is not readable", async () => {
    const routes = createCiRoutes(h.deps, fakeVerifier);
    const res = await routes.deploy(
      post("apps/ci/deploy", bearer(prodClaim), deployBody()),
    );
    const { id } = (await res.json()) as { id: string };
    await h.db
      .updateTable("app_deployments")
      .set({ app_id: "other-app" })
      .where("id", "=", id)
      .execute();
    const r = await routes.deployment(
      get(`apps/ci/deployments/${id}`, bearer(prodClaim)),
      id,
    );
    expect(r.status).toBe(404);
    expect((await getDeployment(h.db, id))?.app_id).toBe("other-app");
  });
});

describe("CI token verification with @renown/sdk (real did:key tokens)", () => {
  async function tokenFor(aud: string) {
    const crypto = await new RenownCryptoBuilder()
      .withKeyPairStorage(new MemoryKeyStorage())
      .build();
    const token = await createAuthBearerToken(
      1,
      "eip155",
      OWNER,
      crypto.issuer,
      { aud, expiresIn: 600 },
    );
    // The Renown credential REST endpoint, answering with a delegation for this key.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          credential: {
            issuer: { id: `did:pkh:eip155:1:${OWNER}`, ethereumAddress: OWNER },
            credentialSubject: { id: crypto.did },
          },
        }),
      ),
    );
    return { token, did: crypto.did };
  }
  // Test-only: the stub credential carries no EIP-712 proof.
  const verifier = createRenownCiVerifier({
    audience: AUDIENCE,
    verifySignature: false,
  });

  it("accepts the CI audience and reports the issuing did:key", async () => {
    const { token, did } = await tokenFor(AUDIENCE);
    expect(await verifier(token)).toMatchObject({
      address: OWNER,
      chainId: 1,
      appDid: did,
      claim: null,
    });
  });

  it("wrong audience → 401", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { token } = await tokenFor("https://switchboard.vetra.io");
    expect(await verifier(token)).toBeNull();
    const r = await createCiRoutes(h.deps, verifier).registryCredentials(
      post("apps/ci/registry-credentials", `Bearer ${token}`, {
        appId: app.id,
      }),
    );
    expect(r.status).toBe(401);
  });

  it("valid credential but issuer ≠ the App identity → 403", async () => {
    const { token } = await tokenFor(AUDIENCE);
    const r = await createCiRoutes(h.deps, verifier).registryCredentials(
      post("apps/ci/registry-credentials", `Bearer ${token}`, {
        appId: app.id,
      }),
    );
    expect(r.status).toBe(403);
  });

  it("the default verifier checks the credential's EIP-712 proof (an unsigned credential is refused)", async () => {
    const { token, did } = await tokenFor(AUDIENCE);
    await h.db.updateTable("apps").set({ identity_did: did }).execute();
    const strict = createRenownCiVerifier({ audience: AUDIENCE });
    expect(await strict(token)).toStrictEqual({
      identityExpired: { appDid: did, address: OWNER },
    });
    // ...whereas the same token passes the identity check when the proof is not re-verified
    const r = await createCiRoutes(h.deps, verifier).registryCredentials(
      post("apps/ci/registry-credentials", `Bearer ${token}`, {
        appId: app.id,
      }),
    );
    expect(r.status).toBe(200);
  });
});

describe("expired / missing App identity delegation", () => {
  async function tokenWithoutDelegation() {
    const crypto = await new RenownCryptoBuilder()
      .withKeyPairStorage(new MemoryKeyStorage())
      .build();
    const token = await createAuthBearerToken(
      1,
      "eip155",
      OWNER,
      crypto.issuer,
      {
        aud: AUDIENCE,
        expiresIn: 600,
      },
    );
    // Renown has no (valid) delegation credential for this key any more.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await h.db.updateTable("apps").set({ identity_did: crypto.did }).execute();
    return token;
  }
  const verifier = createRenownCiVerifier({
    audience: AUDIENCE,
    verifySignature: false,
  });

  it("a valid token whose delegation is gone → 401 IDENTITY_EXPIRED; the App goes PENDING_IDENTITY", async () => {
    const token = await tokenWithoutDelegation();
    await h.db
      .updateTable("apps")
      .set({ identity_expires_at: "2026-01-01T00:00:00.000Z" })
      .execute();
    const r = await createCiRoutes(h.deps, verifier).deploy(
      post("apps/ci/deploy", `Bearer ${token}`, deployBody()),
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toStrictEqual({
      error: "IDENTITY_EXPIRED",
      message:
        "The App's deploy identity authorization expired — re-authorize it on vetra.io",
    });
    expect((await getApp(h.db, app.id))?.status).toBe("PENDING_IDENTITY");
  });

  it("with a stored expiry still in the future (revoked, or Renown unreachable) the status is left alone", async () => {
    const token = await tokenWithoutDelegation();
    const r = await createCiRoutes(h.deps, verifier).registryCredentials(
      post("apps/ci/registry-credentials", `Bearer ${token}`, {
        appId: app.id,
      }),
    );
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe(
      "IDENTITY_EXPIRED",
    );
    expect((await getApp(h.db, app.id))?.status).toBe("ACTIVE");
  });

  it("an invalid token is still plain UNAUTHENTICATED", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await createCiRoutes(h.deps, verifier).deploy(
      post("apps/ci/deploy", "Bearer not.a.jwt", deployBody()),
    );
    expect(((await r.json()) as { error: string }).error).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("GraphQL rejects App identities entirely", () => {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (p: Record<string, unknown>) =>
    `${b64({ alg: "ES256" })}.${b64(p)}.sig`;
  const input = () => ({
    appId: app.id,
    kind: "PRODUCTION" as const,
    gitRef: "refs/heads/main",
    sha: SHA,
    packages: [],
  });

  it("deployApp / appRegistryCredentials / appDeployment with a vetra-claim bearer → FORBIDDEN", async () => {
    const r = createResolvers(h.deps);
    // even when the gateway put the OWNER's own browser key in appKey
    const ctx = {
      user: {
        address: OWNER,
        chainId: 1,
        networkId: "eip155",
        appKey: USER_KEY,
      },
      headers: {
        authorization: `Bearer ${jwt({ iss: USER_KEY, vetra: prodClaim })}`,
      },
    };
    await expect(
      r.Mutation.deployApp(null, { input: input() }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
    await expect(
      r.Mutation.appRegistryCredentials(null, { appId: app.id }, ctx),
    ).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    await expect(
      r.Query.appDeployment(null, { id: "x" }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });

  it("deployApp from the App identity key → FORBIDDEN; from the owner → OK", async () => {
    const r = createResolvers(h.deps);
    const identity = {
      user: {
        address: OWNER,
        chainId: 1,
        networkId: "eip155",
        appKey: APP_DID,
      },
      headers: {},
    };
    await expect(
      r.Mutation.deployApp(null, { input: input() }, identity),
    ).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
    const ownerCtx = {
      user: {
        address: OWNER,
        chainId: 1,
        networkId: "eip155",
        appKey: USER_KEY,
      },
      headers: {},
    };
    expect(
      await r.Mutation.deployApp(null, { input: input() }, ownerCtx),
    ).toMatchObject({ kind: "PRODUCTION" });
  });
});
