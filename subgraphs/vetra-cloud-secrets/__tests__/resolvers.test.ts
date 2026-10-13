import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";
import type { OpenBaoTransitClient } from "../openbao-transit.js";

let db: Kysely<SecretsDB>;

const mockTransit: OpenBaoTransitClient = {
  authenticate: vi.fn(),
  ensureTenantKey: vi.fn().mockResolvedValue(undefined),
  keyFor: vi.fn().mockImplementation((tenantId: string) => `vetra-tenant-${tenantId}`),
  encrypt: vi
    .fn()
    .mockImplementation(
      async (tenantId: string, plaintext: string) =>
        `vault:v1:${tenantId}:${plaintext}`,
    ),
  decrypt: vi
    .fn()
    .mockImplementation(async (_tenantId: string, ciphertext: string) =>
      ciphertext.replace(/^vault:v\d+:[^:]+:/, ""),
    ),
} as any;

let resolvers: ReturnType<typeof createResolvers>;

const OWNER = "0x00000000000000000000000000000000000000aa";
const OTHER = "0x00000000000000000000000000000000000000bb";
const ADMIN = "0x00000000000000000000000000000000000000cc";

/** tenantId -> owners, as the environments projection would return them. */
let tenantOwners: Record<string, (string | null)[]>;

const ownerCtx = { user: { address: OWNER.toUpperCase().replace("0X", "0x") } };

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);

  vi.clearAllMocks();

  // Existing behaviour tests run as the owner of every tenant they touch.
  tenantOwners = new Proxy({} as Record<string, (string | null)[]>, {
    get: () => [OWNER],
  });
  resolvers = createResolvers(db, mockTransit, {
    tenantOwners: async (tenantId) => tenantOwners[tenantId] ?? [],
    tenantWait: { timeoutMs: 0, intervalMs: 1 },
  });
});

afterEach(async () => {
  await db.destroy();
});

/** Resolvers called as the tenant owner (the auth-agnostic behaviour tests). */
const asOwner = (type: Record<string, any>) =>
  new Proxy(type, {
    get:
      (target, name: string) =>
      (parent: unknown, args: unknown) =>
        target[name](parent, args, ownerCtx),
  });
const query = () => asOwner(resolvers.Query);
const mutation = () => asOwner(resolvers.Mutation);

describe("Query", () => {
  describe("envVars", () => {
    it("returns empty array for unknown tenant", async () => {
      const result = await query().envVars(undefined, { tenantId: "unknown" });
      expect(result).toEqual([]);
    });

    it("returns all env vars for tenant", async () => {
      await db
        .insertInto("tenant_env_vars")
        .values([
          {
            tenantId: "t1",
            key: "NODE_ENV",
            value: "production",
            updatedAt: "2026-04-07T00:00:00Z",
          },
          {
            tenantId: "t1",
            key: "PORT",
            value: "3000",
            updatedAt: "2026-04-07T00:00:00Z",
          },
        ])
        .execute();

      const result = await query().envVars(undefined, { tenantId: "t1" });
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ key: "NODE_ENV", value: "production" });
      expect(result).toContainEqual({ key: "PORT", value: "3000" });
    });
  });

  describe("secrets", () => {
    it("returns empty array for unknown tenant", async () => {
      const result = await query().secrets(undefined, { tenantId: "unknown" });
      expect(result).toEqual([]);
    });

    it("returns secret keys only (no values)", async () => {
      await db
        .insertInto("tenant_secrets")
        .values([
          {
            tenantId: "t1",
            key: "API_KEY",
            updatedAt: "2026-04-07T00:00:00Z",
            ciphertext: "vault:v1:xxx",
          },
          {
            tenantId: "t1",
            key: "DB_PASS",
            updatedAt: "2026-04-07T00:00:00Z",
            ciphertext: "vault:v1:yyy",
          },
        ])
        .execute();

      const result = await query().secrets(undefined, { tenantId: "t1" });
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ key: "API_KEY" });
      expect(result).toContainEqual({ key: "DB_PASS" });
    });
  });
});

describe("Mutation", () => {
  describe("setEnvVar", () => {
    it("inserts a new env var", async () => {
      const result = await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "NODE_ENV",
        value: "production",
      });
      expect(result).toEqual({ key: "NODE_ENV", value: "production" });

      const rows = await db
        .selectFrom("tenant_env_vars")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("production");
    });

    it("updates an existing env var", async () => {
      await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "NODE_ENV",
        value: "development",
      });
      await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "NODE_ENV",
        value: "production",
      });

      const rows = await db
        .selectFrom("tenant_env_vars")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("production");
    });

    it("rejects invalid key names", async () => {
      await expect(
        mutation().setEnvVar(undefined, {
          tenantId: "t1",
          key: "invalid-key",
          value: "val",
        }),
      ).rejects.toThrow("key must match");
    });
  });

  describe("deleteEnvVar", () => {
    it("returns true when key existed", async () => {
      await mutation().setEnvVar(undefined, {
        tenantId: "t1",
        key: "MY_VAR",
        value: "val",
      });
      const result = await mutation().deleteEnvVar(undefined, {
        tenantId: "t1",
        key: "MY_VAR",
      });
      expect(result).toBe(true);
    });

    it("returns false when key did not exist", async () => {
      const result = await mutation().deleteEnvVar(undefined, {
        tenantId: "t1",
        key: "NOPE",
      });
      expect(result).toBe(false);
    });
  });

  describe("setSecret", () => {
    it("ensures the tenant key, encrypts via transit, and stores ciphertext", async () => {
      const result = await mutation().setSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
        value: "secret-val",
      });
      expect(result).toEqual({ key: "API_KEY" });

      expect(mockTransit.ensureTenantKey).toHaveBeenCalledWith("t1");
      expect(mockTransit.encrypt).toHaveBeenCalledWith("t1", "secret-val");

      const rows = await db
        .selectFrom("tenant_secrets")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].ciphertext).toBe("vault:v1:t1:secret-val");
    });

    it("re-encrypts on update", async () => {
      await mutation().setSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
        value: "v1",
      });
      await mutation().setSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
        value: "v2",
      });

      expect(mockTransit.encrypt).toHaveBeenCalledTimes(2);
      const rows = await db
        .selectFrom("tenant_secrets")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].ciphertext).toBe("vault:v1:t1:v2");
    });

    it("isolates tenants: different tenantIds use different keys", async () => {
      await mutation().setSecret(undefined, {
        tenantId: "tenant-a",
        key: "X",
        value: "alpha",
      });
      await mutation().setSecret(undefined, {
        tenantId: "tenant-b",
        key: "X",
        value: "beta",
      });

      expect(mockTransit.ensureTenantKey).toHaveBeenCalledWith("tenant-a");
      expect(mockTransit.ensureTenantKey).toHaveBeenCalledWith("tenant-b");
      expect(mockTransit.encrypt).toHaveBeenCalledWith("tenant-a", "alpha");
      expect(mockTransit.encrypt).toHaveBeenCalledWith("tenant-b", "beta");
    });

    it("rejects invalid key names", async () => {
      await expect(
        mutation().setSecret(undefined, {
          tenantId: "t1",
          key: "bad key!",
          value: "val",
        }),
      ).rejects.toThrow("key must match");
    });
  });

  describe("deleteSecret", () => {
    it("returns true and removes the row", async () => {
      await mutation().setSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
        value: "val",
      });

      const result = await mutation().deleteSecret(undefined, {
        tenantId: "t1",
        key: "API_KEY",
      });
      expect(result).toBe(true);

      const rows = await db
        .selectFrom("tenant_secrets")
        .selectAll()
        .where("tenantId", "=", "t1")
        .execute();
      expect(rows).toHaveLength(0);
    });

    it("returns false when key did not exist", async () => {
      const result = await mutation().deleteSecret(undefined, {
        tenantId: "t1",
        key: "NOPE",
      });
      expect(result).toBe(false);
    });
  });
});

describe("authorization", () => {
  const vetraToken = () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "ES256K" })}.${b64({ sub: "did:pkh:x", vetra: { ref: "refs/heads/main" } })}.sig`;
  };

  const ops: Array<[string, "Query" | "Mutation", Record<string, string>]> = [
    ["envVars", "Query", { tenantId: "t1" }],
    ["secrets", "Query", { tenantId: "t1" }],
    ["setEnvVar", "Mutation", { tenantId: "t1", key: "K", value: "v" }],
    ["deleteEnvVar", "Mutation", { tenantId: "t1", key: "K" }],
    ["setSecret", "Mutation", { tenantId: "t1", key: "K", value: "v" }],
    ["deleteSecret", "Mutation", { tenantId: "t1", key: "K" }],
  ];
  const call = (op: (typeof ops)[number], ctx: unknown, tenantId = "t1") =>
    resolvers[op[1]][op[0]](undefined, { ...op[2], tenantId }, ctx);

  const DENIED = "Not allowed to manage this tenant's configuration";

  beforeEach(() => {
    tenantOwners = { t1: [OWNER], legacy: [null] };
    process.env.ADMINS = ADMIN;
  });
  afterEach(() => {
    delete process.env.ADMINS;
  });

  const expectDenied = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e as { message: string; extensions?: { code?: string } },
    );
    expect(err?.message).toBe(DENIED);
    expect(err?.extensions?.code).toBe("FORBIDDEN");
  };

  it.each(ops)("%s refuses anonymous callers", async (...op) => {
    await expectDenied(call(op, {}));
    await expectDenied(call(op, undefined));
  });

  it.each(ops)("%s refuses a caller who does not own the tenant", async (...op) => {
    await expectDenied(call(op, { user: { address: OTHER } }));
  });

  it.each(ops)("%s refuses an unknown tenant with the same error", async (...op) => {
    await expectDenied(call(op, { user: { address: OWNER } }, "nope"));
    await expectDenied(call(op, { user: { address: ADMIN } }, "nope"));
  });

  it.each(ops)("%s refuses workload (CI) tokens, even the owner's", async (...op) => {
    await expectDenied(
      call(op, {
        user: { address: OWNER },
        headers: { authorization: `Bearer ${vetraToken()}` },
      }),
    );
  });

  it.each(ops)("%s allows the owner", async (...op) => {
    await expect(call(op, { user: { address: OWNER } })).resolves.toBeDefined();
  });

  it.each(ops)("%s allows a platform admin", async (...op) => {
    await expect(call(op, { user: { address: ADMIN } })).resolves.toBeDefined();
  });

  it("refuses non-admins on an unowned (legacy) tenant", async () => {
    await expectDenied(call(ops[0], { user: { address: OWNER } }, "legacy"));
  });

  it("refuses when any environment on the tenant belongs to someone else", async () => {
    tenantOwners.t1 = [OWNER, OTHER];
    await expectDenied(call(ops[4], { user: { address: OWNER } }));
  });

  it("does not touch storage when refused", async () => {
    await expectDenied(call(ops[4], { user: { address: OTHER } }));
    expect(mockTransit.encrypt).not.toHaveBeenCalled();
    const rows = await db.selectFrom("tenant_secrets").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("fails closed when the projection is unreadable", async () => {
    const r = createResolvers(db, mockTransit, {
      tenantOwners: async () => {
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
      tenantWait: { timeoutMs: 0, intervalMs: 1 },
    });
    await expectDenied(r.Query.envVars(undefined, { tenantId: "t1" }, { user: { address: OWNER } }));
  });

  it("waits for a just-created tenant to be projected", async () => {
    let calls = 0;
    const r = createResolvers(db, mockTransit, {
      tenantOwners: async () => (++calls < 3 ? [] : [OWNER]),
      tenantWait: { timeoutMs: 50, intervalMs: 5 },
    });
    await expect(
      r.Mutation.setEnvVar(undefined, { tenantId: "t1", key: "K", value: "v" }, { user: { address: OWNER } }),
    ).resolves.toBeDefined();
    expect(calls).toBe(3);
  });

  const mk = (owners: (t: string) => Promise<(string | null)[]>, extra = {}) =>
    createResolvers(db, mockTransit, {
      tenantOwners: owners,
      tenantWait: { timeoutMs: 50, intervalMs: 5 },
      ...extra,
    });
  const asOwner = { user: { address: OWNER } };
  const setVar = (r: ReturnType<typeof createResolvers>, tenantId: string) =>
    r.Mutation.setEnvVar(undefined, { tenantId, key: "K", value: "v" }, asOwner);

  it("queries refuse an unknown tenant immediately, without waiting", async () => {
    let calls = 0;
    const r = mk(async () => (++calls, []));
    await expectDenied(r.Query.envVars(undefined, { tenantId: "x" }, asOwner));
    await expectDenied(r.Query.secrets(undefined, { tenantId: "x" }, asOwner));
    expect(calls).toBe(2);
  });

  it("shares one in-flight wait per tenant", async () => {
    let calls = 0;
    const r = mk(async () => (++calls < 4 ? [] : [OWNER]));
    const res = await Promise.all([setVar(r, "t1"), setVar(r, "t1"), setVar(r, "t1")]);
    expect(res).toHaveLength(3);
    // 3 initial checks + one shared poll (<= 4 more), not 3 independent polls
    expect(calls).toBeLessThanOrEqual(8);
  });

  it("caps concurrent waiters and refuses immediately beyond the cap", async () => {
    let calls = 0;
    const r = mk(async () => (++calls, []), { maxWaiters: 2 });
    const waiting = [setVar(r, "a"), setVar(r, "b")];
    const t0 = Date.now();
    await expectDenied(setVar(r, "c"));
    expect(Date.now() - t0).toBeLessThan(40);
    for (const p of waiting) await expectDenied(p);
    // slots are released afterwards
    const r2calls = calls;
    await expectDenied(setVar(r, "d"));
    expect(calls).toBeGreaterThan(r2calls);
  });

  it("logs projection errors (code only, no values) and still denies", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = mk(async () => {
      throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
    });
    await expectDenied(r.Query.envVars(undefined, { tenantId: "t1" }, asOwner));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].join(" ")).toContain("42P01");
    spy.mockRestore();
  });

  it.each([
    ["lowercase scheme", (t: string) => `bearer ${t}`],
    ["other scheme", (t: string) => `Token ${t}`],
    ["trailing parts", (t: string) => `Bearer ${t} x`],
  ])("refuses workload tokens sent with %s", async (_n, fmt) => {
    await expectDenied(
      call(ops[0], {
        user: { address: OWNER },
        headers: { Authorization: fmt(vetraToken()) },
      }),
    );
  });
});
