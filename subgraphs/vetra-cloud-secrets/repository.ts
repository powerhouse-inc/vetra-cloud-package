import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";

export interface SecretsRepository {
  envVarsForTenant(
    tenantId: string,
  ): Promise<Array<{ key: string; value: string }>>;
  secretsForTenant(
    tenantId: string,
  ): Promise<Array<{ key: string; ciphertext: string | null }>>;
  allTenantIds(): Promise<string[]>;
}

export function createRepository(
  db: Kysely<SecretsDB>,
): SecretsRepository {
  return {
    async envVarsForTenant(tenantId) {
      return db
        .selectFrom("tenant_env_vars")
        .select(["key", "value"])
        .where("tenantId", "=", tenantId)
        .orderBy("key", "asc")
        .execute();
    },

    async secretsForTenant(tenantId) {
      return db
        .selectFrom("tenant_secrets")
        .select(["key", "ciphertext"])
        .where("tenantId", "=", tenantId)
        .orderBy("key", "asc")
        .execute();
    },

    async allTenantIds() {
      const envIds = await db
        .selectFrom("tenant_env_vars")
        .select("tenantId")
        .distinct()
        .execute();
      const secretIds = await db
        .selectFrom("tenant_secrets")
        .select("tenantId")
        .distinct()
        .execute();
      const all = new Set<string>();
      for (const r of envIds) all.add(r.tenantId);
      for (const r of secretIds) all.add(r.tenantId);
      return [...all].sort();
    },
  };
}
