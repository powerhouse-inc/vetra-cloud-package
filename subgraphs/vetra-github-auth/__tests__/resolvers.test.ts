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

describe("connectGithub", () => {
  it("exchanges the device code, creates the blank repo, and persists the connection when the app is installed", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    createRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });

    const status = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    expect(status.connected).toBe(true);
    expect(status.connection).toMatchObject({
      environmentId: ENV,
      repoFullName: "alice/widget",
      repoUrl: "https://github.com/alice/widget",
    });
    // the user token from the exchange is what creates the blank repo
    expect(createRepoMock).toHaveBeenCalledWith("ghu_token", "widget");
    // an all-repositories install already covers the new repo
    expect(addRepoToInstallationMock).not.toHaveBeenCalled();

    const persisted = await getConnection(db, DID, ENV);
    expect(persisted).toMatchObject({
      environmentId: ENV,
      repoFullName: "alice/widget",
    });
  });

  it("throws APP_NOT_INSTALLED before creating anything when the app is not installed", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    findUserInstallationMock.mockResolvedValue(null);

    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
        ctx,
      ),
    ).rejects.toMatchObject({ extensions: { code: "APP_NOT_INSTALLED" } });

    expect(createRepoMock).not.toHaveBeenCalled();
    expect(await getConnection(db, DID, ENV)).toBeNull();
  });

  it("adds the new repo to a selected-repositories installation", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "selected",
    });
    createRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });
    addRepoToInstallationMock.mockResolvedValue();

    const status = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    expect(status.connected).toBe(true);
    expect(addRepoToInstallationMock).toHaveBeenCalledWith(
      "ghu_token",
      "55",
      9001,
    );
  });

  it("still connects when adding the repo to the installation fails (push-time check remains)", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "selected",
    });
    createRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });
    addRepoToInstallationMock.mockRejectedValue(new Error("boom"));

    const status = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    expect(status.connected).toBe(true);
    expect(await getConnection(db, DID, ENV)).toMatchObject({
      repoFullName: "alice/widget",
    });
  });

  const POLLING_CASES: Array<{ exchange: DeviceFlowExchange; code: string }> = [
    { exchange: { status: "pending" }, code: "AUTHORIZATION_PENDING" },
    { exchange: { status: "slowDown" }, code: "SLOW_DOWN" },
    { exchange: { status: "expired" }, code: "DEVICE_CODE_EXPIRED" },
    { exchange: { status: "denied" }, code: "ACCESS_DENIED" },
  ];

  it.each(POLLING_CASES)(
    "surfaces $exchange.status as the matching code and creates nothing",
    async ({ exchange, code }) => {
      exchangeDeviceCodeMock.mockResolvedValue(exchange);

      await expect(
        connectGithub(
          { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
          ctx,
        ),
      ).rejects.toThrow(code);

      expect(createRepoMock).not.toHaveBeenCalled();
      expect(await getConnection(db, DID, ENV)).toBeNull();
    },
  );

  it("maps a name clash to REPO_ALREADY_EXISTS when the user has no matching repo", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    createRepoMock.mockRejectedValue(new RepoAlreadyExistsError("taken"));
    findUserRepoMock.mockResolvedValue(null);

    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
        ctx,
      ),
    ).rejects.toThrow("REPO_ALREADY_EXISTS");

    expect(await getConnection(db, DID, ENV)).toBeNull();
  });

  it("re-binds to the existing repo when the user already has one with that name", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    createRepoMock.mockRejectedValue(new RepoAlreadyExistsError("taken"));
    findUserRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });

    const status = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    expect(status.connected).toBe(true);
    expect(status.connection).toMatchObject({ repoFullName: "alice/widget" });
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

    expect(exchangeDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("persists the caller's GitHub identity on a successful exchange, even when the app is not installed", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockResolvedValue({ login: "alice", id: 7 });
    findUserInstallationMock.mockResolvedValue(null);

    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
        ctx,
      ),
    ).rejects.toThrow("APP_NOT_INSTALLED");

    expect(await getIdentity(db, DID)).toMatchObject({
      githubLogin: "alice",
      githubUserId: "7",
    });
  });

  it("keeps polling through the install wait using the cached token (exchange runs once)", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockResolvedValue({ login: "alice", id: 7 });
    findUserInstallationMock.mockResolvedValue(null);

    // First poll: authorized but app not installed — device code is consumed,
    // token cached.
    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
        ctx,
      ),
    ).rejects.toThrow("APP_NOT_INSTALLED");

    // User installs; the next poll of the SAME device code must complete
    // without a second exchange.
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    createRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });

    const status = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    expect(status.connected).toBe(true);
    expect(exchangeDeviceCodeMock).toHaveBeenCalledTimes(1);
    expect(findUserInstallationMock.mock.calls.every((c) => c[0] === "ghu_token")).toBe(true);
  });

  it("drops the cached token after a successful connect", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockResolvedValue({ login: "alice", id: 7 });
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    createRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });

    await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    // The cache entry is gone: another call with the same code hits the (now
    // spent) exchange again.
    exchangeDeviceCodeMock.mockResolvedValue({ status: "expired" });
    await expect(
      connectGithub(
        { deviceCode: "dev_code", repoName: "again", environmentId: ENV },
        ctx,
      ),
    ).rejects.toThrow("DEVICE_CODE_EXPIRED");
    expect(exchangeDeviceCodeMock).toHaveBeenCalledTimes(2);
  });

  it("ignores an expired cache entry", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockResolvedValue({ login: "alice", id: 7 });
    findUserInstallationMock.mockResolvedValue(null);

    const realNow = Date.now;
    const t0 = realNow();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      await expect(
        connectGithub(
          { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
          ctx,
        ),
      ).rejects.toThrow("APP_NOT_INSTALLED");

      // 21 minutes later the entry is stale → the resolver exchanges again.
      nowSpy.mockReturnValue(t0 + 21 * 60 * 1000);
      exchangeDeviceCodeMock.mockResolvedValue({ status: "expired" });
      await expect(
        connectGithub(
          { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
          ctx,
        ),
      ).rejects.toThrow("DEVICE_CODE_EXPIRED");
      expect(exchangeDeviceCodeMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("still connects when identity capture fails", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    fetchGithubUserMock.mockRejectedValue(new Error("github hiccup"));
    findUserInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });
    createRepoMock.mockResolvedValue({
      id: 9001,
      fullName: "alice/widget",
      url: "https://github.com/alice/widget",
    });

    const status = await connectGithub(
      { deviceCode: "dev_code", repoName: "widget", environmentId: ENV },
      ctx,
    );

    expect(status.connected).toBe(true);
    expect(await getIdentity(db, DID)).toBeNull();
  });
});

describe("myGithubStatus", () => {
  it("reports nothing for a caller who never authorized", async () => {
    expect(await myGithubStatus({ environmentId: ENV }, ctx)).toEqual({
      connected: false,
      connection: null,
      githubLogin: null,
      appInstalled: false,
    });
    expect(findUserAccountInstallationMock).not.toHaveBeenCalled();
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

  it("includes the environment's connection when one exists", async () => {
    await saveIdentity(db, DID, "alice", "7");
    await saveConnection(db, DID, ENV, "alice/widget");
    findUserAccountInstallationMock.mockResolvedValue({
      id: "55",
      repositorySelection: "all",
    });

    const status = await myGithubStatus({ environmentId: ENV }, ctx);

    expect(status.connected).toBe(true);
    expect(status.connection).toMatchObject({ repoFullName: "alice/widget" });
  });

  it("requires an authenticated caller", async () => {
    await expect(myGithubStatus({ environmentId: ENV }, anonCtx)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
  });
});

describe("getPushToken", () => {
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
