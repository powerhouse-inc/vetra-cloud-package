import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraGithubAuthDB } from "../db/schema.js";
import {
  createRepo,
  exchangeDeviceCode,
  GithubApiError,
  RepoAlreadyExistsError,
  RepoNameInvalidError,
} from "../github-app.js";
import {
  clearDeviceTokenCache,
  createResolvers,
  githubFailure,
} from "../resolvers.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRepo", () => {
  it("422 invalid name is not reported as already exists", async () => {
    fetchMock.mockResolvedValue(
      json(422, {
        message: "Repository creation failed.",
        errors: [{ field: "name", message: "name is invalid" }],
      }),
    );
    const err = await createRepo("ghu", "bad name!").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RepoAlreadyExistsError);
    expect(err).toBeInstanceOf(RepoNameInvalidError);
    expect((err as RepoNameInvalidError).reason).toBe("name is invalid");
  });

  it("422 name already exists is RepoAlreadyExistsError", async () => {
    fetchMock.mockResolvedValue(
      json(422, {
        message: "Repository creation failed.",
        errors: [{ field: "name", message: "name already exists on this account" }],
      }),
    );
    await expect(createRepo("ghu", "widget")).rejects.toBeInstanceOf(
      RepoAlreadyExistsError,
    );
  });

  it("carries GitHub's status on other failures, and a timeout is unavailable", async () => {
    fetchMock.mockResolvedValueOnce(json(403, { message: "Forbidden" }));
    await expect(createRepo("ghu", "widget")).rejects.toMatchObject({
      status: 403,
    });
    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const err = await createRepo("ghu", "widget").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(0);
  });
});

describe("timeouts on the connect path", () => {
  it("a device-code exchange that times out is GithubApiError 0", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "cid");
    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const err = await exchangeDeviceCode("dc").catch((e: unknown) => e);
    vi.unstubAllEnvs();
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(0);
    // Every connect-path call is bounded.
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("GitHub failure codes", () => {
  let db: Kysely<VetraGithubAuthDB>;
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  const ctx = {
    user: { address: "0x" + "a".repeat(40), chainId: 1, networkId: "eip155" },
  };

  beforeEach(async () => {
    db = new Kysely<VetraGithubAuthDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    await up(db);
    clearDeviceTokenCache();
    logger = { warn: vi.fn(), error: vi.fn() };
  });
  afterEach(async () => {
    await db.destroy();
  });

  /** The customer-facing error for GitHub's answer to a repository creation. */
  async function mapped(create: () => Response) {
    fetchMock.mockImplementation(async () => create());
    const err = await createRepo("ghu_secret_token", "widget").catch(
      (e: unknown) => e,
    );
    const failure = githubFailure(err);
    if (!failure) throw new Error(`not a GitHub failure: ${String(err)}`);
    return failure;
  }

  it("REPO_NAME_INVALID with GitHub's reason", async () => {
    const err = await mapped(() =>
      json(422, { errors: [{ message: "name is invalid" }] }),
    );
    expect(err.extensions.code).toBe("REPO_NAME_INVALID");
    expect(err.extensions.reason).toBe("name is invalid");
    expect(err.message).toContain("name is invalid");
  });

  it.each([
    [403, { message: "Forbidden" }, "INSUFFICIENT_PERMISSION"],
    [404, { message: "Not Found" }, "INSUFFICIENT_PERMISSION"],
    [403, { message: "Resource protected by organization SAML enforcement." }, "ORG_POLICY"],
    [401, { message: "Bad credentials" }, "GITHUB_NOT_CONNECTED"],
    [502, { message: "Bad Gateway" }, "GITHUB_UNAVAILABLE"],
    [429, { message: "Too Many Requests" }, "GITHUB_UNAVAILABLE"],
    [403, { message: "API rate limit exceeded for user ID 1." }, "GITHUB_UNAVAILABLE"],
  ])("maps a %i (%j) to %s", async (status, body, code) => {
    const err = await mapped(() => json(status, body));
    expect(err.extensions.code).toBe(code);
    expect(err.message).not.toBe(code);
  });

  it("a 403 with x-ratelimit-remaining: 0 is GITHUB_UNAVAILABLE", async () => {
    const err = await mapped(
      () =>
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    );
    expect(err.extensions.code).toBe("GITHUB_UNAVAILABLE");
  });

  it("a plain 403 for repo privacy-policy is INSUFFICIENT_PERMISSION, not ORG_POLICY", async () => {
    fetchMock.mockImplementation(async () => json(403, { message: "Forbidden" }));
    const err = await createRepo("ghu", "privacy-policy").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(githubFailure(err)?.extensions.code).toBe("INSUFFICIENT_PERMISSION");
    // Names in the message (an org "saml-labs" in the path) are never read as a policy.
    expect(
      githubFailure(new GithubApiError(403, "GitHub POST /orgs/saml-labs/repos → 403"))
        ?.extensions.code,
    ).toBe("INSUFFICIENT_PERMISSION");
  });

  it("startGithubDeviceFlow: a network error is GITHUB_UNAVAILABLE", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "cid");
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const resolvers = createResolvers(db, logger);
    const err = await resolvers.VetraGithubAuthMutations.startGithubDeviceFlow(
      null,
      {},
      ctx,
    ).catch((e: { extensions: Record<string, unknown> }) => e);
    vi.unstubAllEnvs();
    expect(err.extensions.code).toBe("GITHUB_UNAVAILABLE");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("logs an unexpected failure at error level with the step", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    const resolvers = createResolvers(db, logger);
    const err = await resolvers.VetraGithubAuthMutations.startGithubDeviceFlow(
      null,
      {},
      ctx,
    ).catch((e: { extensions: Record<string, unknown> }) => e);
    vi.unstubAllEnvs();
    expect(err.extensions.code).toBe("INTERNAL_SERVER_ERROR");
    const logged = logger.error.mock.calls.map((c) => String(c[0]));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /startGithubDeviceFlow failed while starting the device flow/,
    );
  });
});
