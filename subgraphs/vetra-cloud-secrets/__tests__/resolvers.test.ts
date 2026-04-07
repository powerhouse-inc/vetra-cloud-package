import { vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";
import type { OpenBaoKVClient } from "../openbao-kv.js";

let db: Kysely<SecretsDB>;

const mockOpenbao: OpenBaoKVClient = {
  authenticate: vi.fn(),
  readSecrets: vi.fn().mockResolvedValue({}),
  writeSecrets: vi.fn().mockResolvedValue(undefined),
  deleteSecret: vi.fn().mockResolvedValue({}),
} as any;

const mockGitopsSync = {
  syncEnvVarsToGitops: vi.fn().mockResolvedValue(undefined),
  syncSecretsToGitops: vi.fn().mockResolvedValue(undefined),
};

let resolvers: ReturnType<typeof createResolvers>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);

  vi.clearAllMocks();

  resolvers = createResolvers(db, mockOpenbao, mockGitopsSync);
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
          { tenantId: "t1", key: "NODE_ENV", value: "production", updatedAt: "2026-04-07T00:00:00Z" },
          { tenantId: "t1", key: "PORT", value: "3000", updatedAt: "2026-04-07T00:00:00Z" },
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
          { tenantId: "t1", key: "API_KEY", updatedAt: "2026-04-07T00:00:00Z" },
          { tenantId: "t1", key: "DB_PASS", updatedAt: "2026-04-07T00:00:00Z" },
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
    it("inserts a new env var and syncs to gitops", async () => {
      const result = await mutation().setEnvVar(undefined, {
        tenantId: "t1", key: "NODE_ENV", value: "production",
      });
      expect(result).toEqual({ key: "NODE_ENV", value: "production" });

      const rows = await db.selectFrom("tenant_env_vars").selectAll().where("tenantId", "=", "t1").execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("production");

      expect(mockGitopsSync.syncEnvVarsToGitops).toHaveBeenCalledWith("t1", [
        { key: "NODE_ENV", value: "production" },
      ]);
    });

    it("updates an existing env var", async () => {
      await mutation().setEnvVar(undefined, { tenantId: "t1", key: "NODE_ENV", value: "development" });
      await mutation().setEnvVar(undefined, { tenantId: "t1", key: "NODE_ENV", value: "production" });

      const rows = await db.selectFrom("tenant_env_vars").selectAll().where("tenantId", "=", "t1").execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe("production");
    });

    it("rejects invalid key names", async () => {
      await expect(
        mutation().setEnvVar(undefined, { tenantId: "t1", key: "invalid-key", value: "val" }),
      ).rejects.toThrow("key must match");
    });
  });

  describe("deleteEnvVar", () => {
    it("returns true when key existed", async () => {
      await mutation().setEnvVar(undefined, { tenantId: "t1", key: "MY_VAR", value: "val" });
      const result = await mutation().deleteEnvVar(undefined, { tenantId: "t1", key: "MY_VAR" });
      expect(result).toBe(true);
      expect(mockGitopsSync.syncEnvVarsToGitops).toHaveBeenLastCalledWith("t1", []);
    });

    it("returns false when key did not exist", async () => {
      const result = await mutation().deleteEnvVar(undefined, { tenantId: "t1", key: "NOPE" });
      expect(result).toBe(false);
    });
  });

  describe("setSecret", () => {
    it("writes to OpenBao, saves metadata, syncs to gitops", async () => {
      vi.mocked(mockOpenbao.readSecrets).mockResolvedValueOnce({});

      const result = await mutation().setSecret(undefined, {
        tenantId: "t1", key: "API_KEY", value: "secret-val",
      });
      expect(result).toEqual({ key: "API_KEY" });

      expect(mockOpenbao.readSecrets).toHaveBeenCalledWith("t1");
      expect(mockOpenbao.writeSecrets).toHaveBeenCalledWith("t1", { API_KEY: "secret-val" });

      const rows = await db.selectFrom("tenant_secrets").selectAll().where("tenantId", "=", "t1").execute();
      expect(rows).toHaveLength(1);

      expect(mockGitopsSync.syncSecretsToGitops).toHaveBeenCalledWith("t1", ["API_KEY"]);
    });

    it("rejects invalid key names", async () => {
      await expect(
        mutation().setSecret(undefined, { tenantId: "t1", key: "bad key!", value: "val" }),
      ).rejects.toThrow("key must match");
    });
  });

  describe("deleteSecret", () => {
    it("removes from OpenBao, deletes metadata, syncs to gitops", async () => {
      vi.mocked(mockOpenbao.readSecrets).mockResolvedValueOnce({});
      await mutation().setSecret(undefined, { tenantId: "t1", key: "API_KEY", value: "val" });

      vi.clearAllMocks();
      vi.mocked(mockOpenbao.deleteSecret).mockResolvedValueOnce({});

      const result = await mutation().deleteSecret(undefined, { tenantId: "t1", key: "API_KEY" });
      expect(result).toBe(true);
      expect(mockOpenbao.deleteSecret).toHaveBeenCalledWith("t1", "API_KEY");
      expect(mockGitopsSync.syncSecretsToGitops).toHaveBeenCalledWith("t1", []);
    });

    it("returns false when key did not exist", async () => {
      vi.mocked(mockOpenbao.deleteSecret).mockResolvedValueOnce({});
      const result = await mutation().deleteSecret(undefined, { tenantId: "t1", key: "NOPE" });
      expect(result).toBe(false);
    });
  });
});
