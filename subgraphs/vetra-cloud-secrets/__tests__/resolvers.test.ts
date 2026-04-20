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

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);

  vi.clearAllMocks();

  resolvers = createResolvers(db, mockTransit);
});

afterEach(async () => {
  await db.destroy();
});

const query = () => resolvers.Query;
const mutation = () => resolvers.Mutation;

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
