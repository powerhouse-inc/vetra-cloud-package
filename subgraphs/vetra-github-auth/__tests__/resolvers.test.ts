import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import { getConnection, saveConnection } from "../db/installations.js";
import type { VetraGithubAuthDB } from "../db/schema.js";
import type * as GithubApp from "../github-app.js";

// Mock the GitHub network calls but keep the real error classes so the
// resolver's `instanceof` checks still work.
vi.mock("../github-app.js", async (importActual) => {
  const actual = await importActual<typeof GithubApp>();
  return {
    ...actual,
    startDeviceFlow: vi.fn(),
    exchangeDeviceCode: vi.fn(),
    fetchGithubUser: vi.fn(),
    findRepoInstallationId: vi.fn(),
    findUserAccountInstallation: vi.fn(),
    findUserInstallation: vi.fn(),
    addRepoToInstallation: vi.fn(),
    findUserRepo: vi.fn(),
    createRepo: vi.fn(),
    mintInstallationToken: vi.fn(),
  };
});

import {
  addRepoToInstallation,
  createRepo,
  exchangeDeviceCode,
  fetchGithubUser,
  findRepoInstallationId,
  findUserAccountInstallation,
  findUserInstallation,
  findUserRepo,
  mintInstallationToken,
  startDeviceFlow,
  ReinstallRequiredError,
  RepoAlreadyExistsError,
  type DeviceFlowExchange,
} from "../github-app.js";
import { getIdentity, saveIdentity } from "../db/identities.js";
import { clearDeviceTokenCache, createResolvers } from "../resolvers.js";

const startDeviceFlowMock = vi.mocked(startDeviceFlow);
const exchangeDeviceCodeMock = vi.mocked(exchangeDeviceCode);
const fetchGithubUserMock = vi.mocked(fetchGithubUser);
const findRepoInstallationIdMock = vi.mocked(findRepoInstallationId);
const findUserAccountInstallationMock = vi.mocked(findUserAccountInstallation);
const findUserInstallationMock = vi.mocked(findUserInstallation);
const addRepoToInstallationMock = vi.mocked(addRepoToInstallation);
const findUserRepoMock = vi.mocked(findUserRepo);
const createRepoMock = vi.mocked(createRepo);
const mintInstallationTokenMock = vi.mocked(mintInstallationToken);

const ADDR = "0x" + "a".repeat(40);
const DID = `did:pkh:eip155:1:${ADDR}`;
const ENV = "env-123";
const ctx = { user: { address: ADDR, chainId: 1, networkId: "eip155" } };
const anonCtx = {};

let db: Kysely<VetraGithubAuthDB>;
let resolvers: Record<string, any>;

const startGithubDeviceFlow = (c: unknown) =>
  resolvers.VetraGithubAuthMutations.startGithubDeviceFlow(null, {}, c);
const connectGithub = (
  args: { deviceCode: string; repoName: string; environmentId: string },
  c: unknown,
) => resolvers.VetraGithubAuthMutations.connectGithub(null, args, c);
const authorizeGithub = (args: { deviceCode: string }, c: unknown) =>
  resolvers.VetraGithubAuthMutations.authorizeGithub(null, args, c);
const getPushToken = (args: { environmentId: string }, c: unknown) =>
  resolvers.VetraGithubAuthQueries.getPushToken(null, args, c);
const myGithubConnection = (args: { environmentId: string }, c: unknown) =>
  resolvers.VetraGithubAuthQueries.myGithubConnection(null, args, c);
const myGithubStatus = (args: { environmentId: string }, c: unknown) =>
  resolvers.VetraGithubAuthQueries.myGithubStatus(null, args, c);

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<VetraGithubAuthDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  resolvers = createResolvers(db);
  vi.clearAllMocks();
  clearDeviceTokenCache();
});

afterEach(async () => {
  await db.destroy();
});

describe("startGithubDeviceFlow", () => {
  it("returns the device flow for an authenticated caller", async () => {
    const flow = {
      deviceCode: "dev_code",
      userCode: "WXYZ-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    };
    startDeviceFlowMock.mockResolvedValue(flow);

    expect(await startGithubDeviceFlow(ctx)).toEqual(flow);
  });

  it("requires an authenticated caller", async () => {
    await expect(startGithubDeviceFlow(anonCtx)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    expect(startDeviceFlowMock).not.toHaveBeenCalled();
  });
});

describe("connectGithub (retired: GitHub is connected from the product's settings)", () => {
  it("old repo creation answers with the new path", async () => {
    const err = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    ).catch((e: { message: string; extensions: Record<string, unknown> }) => e);

    expect(err.extensions.code).toBe("GITHUB_MOVED");
    expect(err.message).toBe("Connect GitHub from your product's settings");
    // Nothing is exchanged, created or recorded.
    expect(exchangeDeviceCodeMock).not.toHaveBeenCalled();
    expect(findUserInstallationMock).not.toHaveBeenCalled();
    expect(createRepoMock).not.toHaveBeenCalled();
    expect(findUserRepoMock).not.toHaveBeenCalled();
    expect(addRepoToInstallationMock).not.toHaveBeenCalled();
    expect(await getConnection(db, DID, ENV)).toBeNull();
  });

  it("an existing connection is left as it is", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "other", environmentId: ENV },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "GITHUB_MOVED" } });
    expect(await getConnection(db, DID, ENV)).toMatchObject({
      repoFullName: "alice/widget",
    });
  });

  it("requires an authenticated caller", async () => {
    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
        anonCtx,
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
});

describe("authorizeGithub", () => {
  it("maps a pending exchange to AUTHORIZATION_PENDING", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({ status: "pending" });
    await expect(
      authorizeGithub({ deviceCode: "dev_code" }, ctx),
    ).rejects.toThrow("AUTHORIZATION_PENDING");
  });

  it("reports identity + install state once authorized", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockResolvedValue({ login: "alice", id: 7 });
    findUserInstallationMock.mockResolvedValue(null);

    expect(await authorizeGithub({ deviceCode: "dev_code" }, ctx)).toEqual({
      githubLogin: "alice",
      appInstalled: false,
    });

    // Install appears; the next poll reuses the cached token — no re-exchange.
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "selected",
    });
    expect(await authorizeGithub({ deviceCode: "dev_code" }, ctx)).toEqual({
      githubLogin: "alice",
      appInstalled: true,
    });
    expect(exchangeDeviceCodeMock).toHaveBeenCalledTimes(1);
  });

  it("still answers when identity capture fails", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockRejectedValue(new Error("github hiccup"));
    findUserInstallationMock.mockResolvedValue(null);

    expect(await authorizeGithub({ deviceCode: "dev_code" }, ctx)).toEqual({
      githubLogin: null,
      appInstalled: false,
    });
    expect(await getIdentity(db, DID)).toBeNull();
  });

  it("ignores an expired cache entry", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockResolvedValue({ login: "alice", id: 7 });
    findUserInstallationMock.mockResolvedValue(null);

    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      await authorizeGithub({ deviceCode: "dev_code" }, ctx);
      // 21 minutes later the entry is stale → the resolver exchanges again.
      nowSpy.mockReturnValue(t0 + 21 * 60 * 1000);
      exchangeDeviceCodeMock.mockResolvedValue({ status: "expired" });
      await expect(
        authorizeGithub({ deviceCode: "dev_code" }, ctx),
      ).rejects.toThrow("DEVICE_CODE_EXPIRED");
      expect(exchangeDeviceCodeMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("requires an authenticated caller", async () => {
    await expect(
      authorizeGithub({ deviceCode: "dev_code" }, anonCtx),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(exchangeDeviceCodeMock).not.toHaveBeenCalled();
  });
});

describe("myGithubStatus", () => {
  it("reports nothing for a caller who never authorized", async () => {
    expect(await myGithubStatus({ environmentId: ENV }, ctx)).toEqual({
      connected: false,
      connection: null,
      githubLogin: null,
      appInstalled: false,
      repoAccessible: null,
    });
    expect(findUserAccountInstallationMock).not.toHaveBeenCalled();
    expect(findRepoInstallationIdMock).not.toHaveBeenCalled();
  });

  it("resolves install state live from the identity link", async () => {
    await saveIdentity(db, DID, "alice", "7");
    findUserAccountInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "selected",
    });

    const status = await myGithubStatus({ environmentId: ENV }, ctx);

    expect(status).toMatchObject({ githubLogin: "alice", appInstalled: true });
    expect(findUserAccountInstallationMock).toHaveBeenCalledWith("alice");
  });

  it("reports not installed when GitHub has no installation for the account", async () => {
    await saveIdentity(db, DID, "alice", "7");
    findUserAccountInstallationMock.mockResolvedValue(null);

    const status = await myGithubStatus({ environmentId: ENV }, ctx);

    expect(status).toMatchObject({ githubLogin: "alice", appInstalled: false });
  });

  it("includes the environment's connection and its live repo access", async () => {
    await saveIdentity(db, DID, "alice", "7");
    await saveConnection(db, DID, ENV, "alice/widget");
    findUserAccountInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    findRepoInstallationIdMock.mockResolvedValue("55");

    const status = await myGithubStatus({ environmentId: ENV }, ctx);

    expect(status.connected).toBe(true);
    expect(status.connection).toMatchObject({ repoFullName: "alice/widget" });
    expect(status.repoAccessible).toBe(true);
    expect(findRepoInstallationIdMock).toHaveBeenCalledWith("alice/widget");
  });

  it("flags a connected repo the installation can no longer reach", async () => {
    await saveIdentity(db, DID, "alice", "7");
    await saveConnection(db, DID, ENV, "alice/widget");
    // App still installed on the account, but the repo fell out of a
    // selected-repositories installation.
    findUserAccountInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "selected",
    });
    findRepoInstallationIdMock.mockResolvedValue(null);

    const status = await myGithubStatus({ environmentId: ENV }, ctx);

    expect(status).toMatchObject({ appInstalled: true, repoAccessible: false });
  });

  it("degrades live lookups instead of failing when GitHub is unreachable", async () => {
    await saveIdentity(db, DID, "alice", "7");
    await saveConnection(db, DID, ENV, "alice/widget");
    findUserAccountInstallationMock.mockRejectedValue(new Error("github down"));
    findRepoInstallationIdMock.mockRejectedValue(new Error("github down"));

    const status = await myGithubStatus({ environmentId: ENV }, ctx);

    expect(status.connected).toBe(true);
    expect(status).toMatchObject({ appInstalled: false, repoAccessible: null });
  });

  it("requires an authenticated caller", async () => {
    await expect(myGithubStatus({ environmentId: ENV }, anonCtx)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
  });
});

describe("getPushToken", () => {
  it("existing connection keeps pushing until moved", async () => {
    // A Studio connected before GitHub moved to the product's settings.
    await saveConnection(db, DID, ENV, "alice/widget");
    // New connections are refused…
    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "widget-2", environmentId: ENV },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "GITHUB_MOVED" } });
    // …but the existing one still gets push tokens, with no customer action.
    findRepoInstallationIdMock.mockResolvedValue("123");
    mintInstallationTokenMock.mockResolvedValue({
      token: "ghs_token",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    expect(await getPushToken({ environmentId: ENV }, ctx)).toEqual({
      token: "ghs_token",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    expect(mintInstallationTokenMock).toHaveBeenCalledWith("123", "widget");
  });

  it("resolves the repo's installation and mints a scoped token", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    findRepoInstallationIdMock.mockResolvedValue("123");
    mintInstallationTokenMock.mockResolvedValue({
      token: "ghs_token",
      expiresAt: "2026-01-01T00:00:00Z",
    });

    const result = await getPushToken({ environmentId: ENV }, ctx);

    expect(result).toEqual({
      token: "ghs_token",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    expect(findRepoInstallationIdMock).toHaveBeenCalledWith("alice/widget");
    expect(mintInstallationTokenMock).toHaveBeenCalledWith("123", "widget");
  });

  it("throws NOT_CONNECTED when the caller has no connection for the environment", async () => {
    await expect(getPushToken({ environmentId: ENV }, ctx)).rejects.toThrow(
      "NOT_CONNECTED",
    );
    expect(findRepoInstallationIdMock).not.toHaveBeenCalled();
    expect(mintInstallationTokenMock).not.toHaveBeenCalled();
  });

  it("throws APP_NOT_INSTALLED when the app is not installed on the repo yet", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    findRepoInstallationIdMock.mockResolvedValue(null);

    await expect(getPushToken({ environmentId: ENV }, ctx)).rejects.toThrow(
      "APP_NOT_INSTALLED",
    );
    expect(mintInstallationTokenMock).not.toHaveBeenCalled();
  });

  it("maps a mid-flight uninstall to APP_NOT_INSTALLED", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");
    findRepoInstallationIdMock.mockResolvedValue("123");
    mintInstallationTokenMock.mockRejectedValue(
      new ReinstallRequiredError("uninstalled"),
    );

    await expect(getPushToken({ environmentId: ENV }, ctx)).rejects.toThrow(
      "APP_NOT_INSTALLED",
    );
  });

  it("requires an authenticated caller", async () => {
    await expect(getPushToken({ environmentId: ENV }, anonCtx)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
  });

  it("throws GraphQLErrors that carry the code in extensions.code", async () => {
    await expect(
      getPushToken({ environmentId: ENV }, ctx),
    ).rejects.toMatchObject({ extensions: { code: "NOT_CONNECTED" } });
  });
});

describe("myGithubConnection", () => {
  it("reports not connected when there is no binding for the environment", async () => {
    expect(await myGithubConnection({ environmentId: ENV }, ctx)).toEqual({
      connected: false,
      connection: null,
    });
  });

  it("reports the connection when one exists", async () => {
    await saveConnection(db, DID, ENV, "alice/widget");

    const status = await myGithubConnection({ environmentId: ENV }, ctx);

    expect(status.connected).toBe(true);
    expect(status.connection).toMatchObject({
      environmentId: ENV,
      repoFullName: "alice/widget",
      repoUrl: "https://github.com/alice/widget",
    });
  });

  it("requires an authenticated caller", async () => {
    await expect(
      myGithubConnection({ environmentId: ENV }, anonCtx),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
});
