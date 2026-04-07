import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import type { OpenBaoKVClient } from "./openbao-kv.js";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid key "${key}": key must match ^[A-Z][A-Z0-9_]*$ (e.g. MY_VAR, API_KEY)`,
    );
  }
}

export interface GitopsSyncFns {
  syncEnvVarsToGitops(
    tenantId: string,
    envVars: Array<{ key: string; value: string }>,
  ): Promise<void>;
  syncSecretsToGitops(
    tenantId: string,
    secretKeys: string[],
  ): Promise<void>;
}

export function createResolvers(
  db: Kysely<SecretsDB>,
  openbao: OpenBaoKVClient,
  gitops: GitopsSyncFns,
): Record<string, any> {
  async function getAllEnvVars(
    tenantId: string,
  ): Promise<Array<{ key: string; value: string }>> {
    const rows = await db
      .selectFrom("tenant_env_vars")
      .select(["key", "value"])
      .where("tenantId", "=", tenantId)
      .orderBy("key", "asc")
      .execute();
    return rows;
  }

  async function getAllSecretKeys(tenantId: string): Promise<string[]> {
    const rows = await db
      .selectFrom("tenant_secrets")
      .select("key")
      .where("tenantId", "=", tenantId)
      .orderBy("key", "asc")
      .execute();
    return rows.map((r) => r.key);
  }

  return {
    Query: {
      envVars: async (_parent: unknown, { tenantId }: { tenantId: string }) =>
        getAllEnvVars(tenantId),

      secrets: async (_parent: unknown, { tenantId }: { tenantId: string }) => {
        const rows = await db
          .selectFrom("tenant_secrets")
          .select("key")
          .where("tenantId", "=", tenantId)
          .orderBy("key", "asc")
          .execute();
        return rows.map((r) => ({ key: r.key }));
      },
    },

    Mutation: {
      setEnvVar: async (
        _parent: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
      ) => {
        validateKey(key);
        const now = new Date().toISOString();

        await db
          .insertInto("tenant_env_vars")
          .values({ tenantId, key, value, updatedAt: now })
          .onConflict((oc) =>
            oc.columns(["tenantId", "key"]).doUpdateSet({ value, updatedAt: now }),
          )
          .execute();

        const allEnvVars = await getAllEnvVars(tenantId);
        await gitops.syncEnvVarsToGitops(tenantId, allEnvVars);

        return { key, value };
      },

      deleteEnvVar: async (
        _parent: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => {
        const result = await db
          .deleteFrom("tenant_env_vars")
          .where("tenantId", "=", tenantId)
          .where("key", "=", key)
          .executeTakeFirst();

        const deleted = Number(result.numDeletedRows) > 0;

        if (deleted) {
          const allEnvVars = await getAllEnvVars(tenantId);
          await gitops.syncEnvVarsToGitops(tenantId, allEnvVars);
        }

        return deleted;
      },

      setSecret: async (
        _parent: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
      ) => {
        validateKey(key);

        const existing = await openbao.readSecrets(tenantId);
        await openbao.writeSecrets(tenantId, { ...existing, [key]: value });

        const now = new Date().toISOString();
        await db
          .insertInto("tenant_secrets")
          .values({ tenantId, key, updatedAt: now })
          .onConflict((oc) =>
            oc.columns(["tenantId", "key"]).doUpdateSet({ updatedAt: now }),
          )
          .execute();

        const allKeys = await getAllSecretKeys(tenantId);
        await gitops.syncSecretsToGitops(tenantId, allKeys);

        return { key };
      },

      deleteSecret: async (
        _parent: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => {
        const result = await db
          .deleteFrom("tenant_secrets")
          .where("tenantId", "=", tenantId)
          .where("key", "=", key)
          .executeTakeFirst();

        const deleted = Number(result.numDeletedRows) > 0;

        if (deleted) {
          await openbao.deleteSecret(tenantId, key);
          const allKeys = await getAllSecretKeys(tenantId);
          await gitops.syncSecretsToGitops(tenantId, allKeys);
        }

        return deleted;
      },
    },
  };
}
