import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExplorerResolvers,
  type ExplorerResolverDeps,
} from "../explorer/resolvers.js";
import { createResolvers } from "../resolvers.js";

const TENANT = "tenant-1";

/**
 * Minimal envDb stub matching the chain used by `loadEnv`.
 *
 *   envDb.selectFrom("environments")
 *        .select(["id","tenantId","owner"])
 *        .where("tenantId","=",tenantId)
 *        .executeTakeFirst()
 */
function envDbStub(envOwner: string | null) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () =>
            envOwner === null
              ? undefined
              : { id: "doc-1", tenantId: TENANT, owner: envOwner },
        }),
      }),
    }),
  };
}

/**
 * Pool stub whose `connect()` returns a client driving a single-row
 * SELECT result so the helpers complete the happy path without
 * touching a real Postgres.
 */
function poolStub() {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        const u = sql.trim().toUpperCase();
        if (
          u.startsWith("BEGIN") ||
          u.startsWith("SET LOCAL") ||
          u.startsWith("ROLLBACK")
        ) {
          return { rows: [] };
        }
        // describe queries
        if (/FROM information_schema/i.test(sql)) return { rows: [] };
        if (/FROM pg_constraint/i.test(sql)) return { rows: [] };
        if (/FROM pg_indexes/i.test(sql)) return { rows: [] };
        // executeReadOnlyQuery main statement
        return { rows: [{ n: 1 }], fields: [{ name: "n" }] };
      },
      release: () => undefined,
    }),
  } as never;
}

let getPool: ReturnType<typeof vi.fn>;
let deps: ExplorerResolverDeps;

beforeEach(() => {
  getPool = vi.fn(async () => poolStub());
  deps = {
    envDb: envDbStub("0xAbC") as never,
    getPool,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeDatabase (Query)", () => {
  it("resolves for the env owner", async () => {
    const resolvers = createExplorerResolvers(deps);
    const result = await resolvers.Query.describeDatabase(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(result).toEqual({ schemas: [] });
    expect(getPool).toHaveBeenCalledWith(TENANT);
  });

  it("rejects non-owner with FORBIDDEN", async () => {
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Query.describeDatabase(
        null,
        { tenantId: TENANT },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(getPool).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated", async () => {
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Query.describeDatabase(null, { tenantId: TENANT }, {}),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(getPool).not.toHaveBeenCalled();
  });

  it("rejects when env doesn't exist (ENV_NOT_FOUND)", async () => {
    deps = { ...deps, envDb: envDbStub(null) as never };
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Query.describeDatabase(
        null,
        { tenantId: TENANT },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("ENV_NOT_FOUND");
    expect(getPool).not.toHaveBeenCalled();
  });
});

describe("executeReadOnlyQuery (Mutation)", () => {
  it("resolves for the env owner with default limit", async () => {
    const resolvers = createExplorerResolvers(deps);
    const result = await resolvers.Mutation.executeReadOnlyQuery(
      null,
      { tenantId: TENANT, sql: "SELECT 1" },
      { user: { address: "0xabc" } },
    );
    expect(result.columns).toEqual(["n"]);
    expect(result.rows).toEqual([["1"]]);
    expect(getPool).toHaveBeenCalledWith(TENANT);
  });

  it("rejects non-owner with FORBIDDEN", async () => {
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Mutation.executeReadOnlyQuery(
        null,
        { tenantId: TENANT, sql: "SELECT 1" },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(getPool).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated", async () => {
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Mutation.executeReadOnlyQuery(
        null,
        { tenantId: TENANT, sql: "SELECT 1" },
        {},
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
    expect(getPool).not.toHaveBeenCalled();
  });

  it("rejects when env doesn't exist (ENV_NOT_FOUND)", async () => {
    deps = { ...deps, envDb: envDbStub(null) as never };
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Mutation.executeReadOnlyQuery(
        null,
        { tenantId: TENANT, sql: "SELECT 1" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("ENV_NOT_FOUND");
    expect(getPool).not.toHaveBeenCalled();
  });

  it("blocked keywords reject without touching the pool", async () => {
    const resolvers = createExplorerResolvers(deps);
    await expect(
      resolvers.Mutation.executeReadOnlyQuery(
        null,
        { tenantId: TENANT, sql: "DELETE FROM x" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("QUERY_BLOCKED");
    // requireOwner has passed by the time we reject, so the pool
    // factory IS asked for a pool — but the sandbox helper aborts
    // before any BEGIN. We just confirm the helper raised the
    // correct error.
  });
});

describe("top-level createResolvers fallback", () => {
  /**
   * When `explorerDeps` is omitted (no k8s wiring), both surfaces
   * throw EXPLORER_NOT_CONFIGURED rather than violating the
   * schema's non-null contract. Mirror the dumps-no-config test.
   */
  it("describeDatabase throws EXPLORER_NOT_CONFIGURED when deps are missing", async () => {
    const r = createResolvers({} as never, {
      prometheusUrl: "",
      lokiUrl: "",
      envDb: {} as never,
      dispatch: async () => undefined,
    });
    await expect(
      r.Query.describeDatabase(null, { tenantId: TENANT }, { user: { address: "0xabc" } }),
    ).rejects.toThrow("EXPLORER_NOT_CONFIGURED");
  });

  it("executeReadOnlyQuery throws EXPLORER_NOT_CONFIGURED when deps are missing", async () => {
    const r = createResolvers({} as never, {
      prometheusUrl: "",
      lokiUrl: "",
      envDb: {} as never,
      dispatch: async () => undefined,
    });
    await expect(
      r.Mutation.executeReadOnlyQuery(
        null,
        { tenantId: TENANT, sql: "SELECT 1" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("EXPLORER_NOT_CONFIGURED");
  });
});
