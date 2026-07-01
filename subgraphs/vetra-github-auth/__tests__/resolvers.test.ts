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
    findRepoInstallationId: vi.fn(),
    findUserRepo: vi.fn(),
    createRepo: vi.fn(),
    mintInstallationToken: vi.fn(),
  };
});

import {
  createRepo,
  exchangeDeviceCode,
  findRepoInstallationId,
  findUserRepo,
  mintInstallationToken,
  startDeviceFlow,
  ReinstallRequiredError,
  RepoAlreadyExistsError,
  type DeviceFlowExchange,
} from "../github-app.js";
import { createResolvers } from "../resolvers.js";

const startDeviceFlowMock = vi.mocked(startDeviceFlow);
const exchangeDeviceCodeMock = vi.mocked(exchangeDeviceCode);
const findRepoInstallationIdMock = vi.mocked(findRepoInstallationId);
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

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<VetraGithubAuthDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
  resolvers = createResolvers(db);
  vi.clearAllMocks();
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
  it("exchanges the device code, creates the blank repo, and persists the connection — without requiring the app to be installed", async () => {
    exchangeDeviceCodeMock.mockResolvedValue({
      status: "authorized",
      accessToken: "ghu_token",
    });
    createRepoMock.mockResolvedValue({
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

    const persisted = await getConnection(db, DID, ENV);
    expect(persisted).toMatchObject({
      environmentId: ENV,
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
    createRepoMock.mockRejectedValue(new RepoAlreadyExistsError("taken"));
    findUserRepoMock.mockResolvedValue({
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
