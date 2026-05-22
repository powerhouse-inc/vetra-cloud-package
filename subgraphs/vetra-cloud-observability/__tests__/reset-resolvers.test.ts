import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResetResolvers,
  type ResetResolverDeps,
} from "../reset/resolvers.js";
import type { ResetK8sClient } from "../reset/service.js";
import { createResolvers } from "../resolvers.js";

const TENANT = "tenant-1";

/**
 * Minimal envDb stub matching the chain used by `loadEnv`:
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
 * Pool stub recording every SQL string the resolver pushes through
 * `truncateUserTables`. Returns one user table so the helper exercises
 * its BEGIN/TRUNCATE/COMMIT path.
 */
function poolStub(opts: { tables?: number; failTruncate?: boolean } = {}) {
  const count = opts.tables ?? 1;
  const rows = Array.from({ length: count }, (_, i) => ({
    table_schema: "public",
    table_name: `t${i}`,
  }));
  const calls: string[] = [];
  return {
    calls,
    pool: {
      connect: async () => ({
        query: async (sql: string) => {
          calls.push(sql);
          if (opts.failTruncate && /^TRUNCATE TABLE/.test(sql)) {
            throw new Error("truncate boom");
          }
          if (/FROM information_schema\.tables/i.test(sql)) {
            return { rows };
          }
          return { rows: [] };
        },
        release: () => undefined,
      }),
    } as never,
  };
}

function makeK8s(
  deployments: Array<{
    name: string;
    component: string;
    labels: Record<string, string>;
  }>,
  opts: { failPatch?: (name: string) => boolean } = {},
): { k8s: ResetK8sClient; patches: string[] } {
  const patches: string[] = [];
  return {
    patches,
    k8s: {
      listAppDeployments: vi.fn(async () => deployments),
      patchDeploymentRestart: vi.fn(async (_ns, name) => {
        if (opts.failPatch?.(name)) {
          throw new Error(`patch failed: ${name}`);
        }
        patches.push(name);
      }),
    },
  };
}

let deps: ResetResolverDeps;
let pool: ReturnType<typeof poolStub>;
let k8s: ReturnType<typeof makeK8s>;

beforeEach(() => {
  pool = poolStub();
  k8s = makeK8s([
    { name: "connect", component: "connect", labels: {} },
    { name: "switchboard", component: "switchboard", labels: {} },
  ]);
  deps = {
    envDb: envDbStub("0xAbC") as never,
    getPool: vi.fn(async () => pool.pool),
    k8s: k8s.k8s,
  };
});
afterEach(() => vi.restoreAllMocks());

describe("resetEnvironment", () => {
  it("truncates user tables and restarts every app deployment for the owner", async () => {
    const resolvers = createResetResolvers(deps);
    const res = await resolvers.Mutation.resetEnvironment(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(res).toEqual({
      ok: true,
      tablesCleared: 1,
      deploymentsRestarted: 2,
      message: null,
    });
    // BEGIN/TRUNCATE/COMMIT executed in order.
    expect(pool.calls.find((s) => /^TRUNCATE TABLE/.test(s))).toBeDefined();
    expect(k8s.patches.sort()).toEqual(["connect", "switchboard"]);
  });

  it("returns tablesCleared=0 and still restarts when the DB is empty", async () => {
    // Re-stub pool to return 0 tables.
    pool = poolStub({ tables: 0 });
    deps.getPool = vi.fn(async () => pool.pool);

    const resolvers = createResetResolvers(deps);
    const res = await resolvers.Mutation.resetEnvironment(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(res.tablesCleared).toBe(0);
    expect(res.deploymentsRestarted).toBe(2);
    expect(res.message).toBeNull();
    // No TRUNCATE issued when the schema is empty.
    expect(pool.calls.find((s) => /^TRUNCATE TABLE/.test(s))).toBeUndefined();
  });

  it("returns RESTART_PARTIAL when some deployment patches fail", async () => {
    k8s = makeK8s(
      [
        { name: "connect", component: "connect", labels: {} },
        { name: "switchboard", component: "switchboard", labels: {} },
      ],
      { failPatch: (n) => n === "switchboard" },
    );
    deps.k8s = k8s.k8s;

    const resolvers = createResetResolvers(deps);
    const res = await resolvers.Mutation.resetEnvironment(
      null,
      { tenantId: TENANT },
      { user: { address: "0xabc" } },
    );
    expect(res.ok).toBe(true);
    expect(res.deploymentsRestarted).toBe(1);
    expect(res.message).toMatch(/^RESTART_PARTIAL:/);
    expect(res.message).toContain("switchboard");
  });

  it("wraps a truncate failure as TRUNCATE_FAILED", async () => {
    pool = poolStub({ failTruncate: true });
    deps.getPool = vi.fn(async () => pool.pool);

    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.resetEnvironment(
        null,
        { tenantId: TENANT },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow(/^TRUNCATE_FAILED:/);
    // No deployments restarted when truncate failed.
    expect(k8s.patches).toEqual([]);
  });

  it("rejects non-owner with FORBIDDEN", async () => {
    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.resetEnvironment(
        null,
        { tenantId: TENANT },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(k8s.patches).toEqual([]);
  });

  it("rejects unauthenticated with UNAUTHENTICATED", async () => {
    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.resetEnvironment(null, { tenantId: TENANT }, {}),
    ).rejects.toThrow("UNAUTHENTICATED");
  });

  it("rejects unknown tenant with ENV_NOT_FOUND", async () => {
    deps.envDb = envDbStub(null) as never;
    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.resetEnvironment(
        null,
        { tenantId: TENANT },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("ENV_NOT_FOUND");
  });
});

describe("restartEnvironmentService", () => {
  it("restarts the named service for the owner and returns its deployment name", async () => {
    const resolvers = createResetResolvers(deps);
    const res = await resolvers.Mutation.restartEnvironmentService(
      null,
      { tenantId: TENANT, service: "CONNECT" },
      { user: { address: "0xabc" } },
    );
    expect(res).toEqual({
      ok: true,
      deploymentName: "connect",
      message: null,
    });
    expect(k8s.patches).toEqual(["connect"]);
  });

  it("filters CLINT by agentPrefix", async () => {
    k8s = makeK8s([
      {
        name: "clint-agent-a",
        component: "clint",
        labels: { "clint.vetra.io/agent": "a" },
      },
      {
        name: "clint-agent-b",
        component: "clint",
        labels: { "clint.vetra.io/agent": "b" },
      },
    ]);
    deps.k8s = k8s.k8s;
    const resolvers = createResetResolvers(deps);
    const res = await resolvers.Mutation.restartEnvironmentService(
      null,
      { tenantId: TENANT, service: "CLINT", agentPrefix: "b" },
      { user: { address: "0xabc" } },
    );
    expect(res.deploymentName).toBe("clint-agent-b");
    expect(k8s.patches).toEqual(["clint-agent-b"]);
  });

  it("rejects non-owner with FORBIDDEN", async () => {
    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CONNECT" },
        { user: { address: "0xdef" } },
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(k8s.patches).toEqual([]);
  });

  it("bubbles DEPLOYMENT_NOT_FOUND from the helper", async () => {
    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "FUSION" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("DEPLOYMENT_NOT_FOUND");
  });

  it("bubbles AMBIGUOUS_SERVICE when CLINT is restarted without an agent prefix", async () => {
    k8s = makeK8s([
      {
        name: "clint-agent-a",
        component: "clint",
        labels: { "clint.vetra.io/agent": "a" },
      },
    ]);
    deps.k8s = k8s.k8s;
    const resolvers = createResetResolvers(deps);
    await expect(
      resolvers.Mutation.restartEnvironmentService(
        null,
        { tenantId: TENANT, service: "CLINT" },
        { user: { address: "0xabc" } },
      ),
    ).rejects.toThrow("AMBIGUOUS_SERVICE");
  });
});

describe("reset fallback (no resetDeps)", () => {
  it("resetEnvironment throws RESET_NOT_CONFIGURED", async () => {
    // Build the outer resolver without resetDeps.
    const resolvers = createResolvers({} as never, {
      prometheusUrl: "http://prom.test",
      lokiUrl: "http://loki.test",
    } as never);
    await expect(
      resolvers.Mutation.resetEnvironment(
        undefined,
        { tenantId: TENANT },
        { user: { address: "0xabc" } } as never,
      ),
    ).rejects.toThrow("RESET_NOT_CONFIGURED");
  });

  it("restartEnvironmentService throws RESTART_NOT_CONFIGURED", async () => {
    const resolvers = createResolvers({} as never, {
      prometheusUrl: "http://prom.test",
      lokiUrl: "http://loki.test",
    } as never);
    await expect(
      resolvers.Mutation.restartEnvironmentService(
        undefined,
        { tenantId: TENANT, service: "CONNECT" },
        { user: { address: "0xabc" } } as never,
      ),
    ).rejects.toThrow("RESTART_NOT_CONFIGURED");
  });
});
