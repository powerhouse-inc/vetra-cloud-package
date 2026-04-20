import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { hashNamespace } from "@powerhousedao/shared/processors";
import type { SecretsDB } from "../subgraphs/vetra-cloud-secrets/db/schema.js";

export interface SecretsRepository {
  envVarsForTenant(
    tenantId: string,
  ): Promise<Array<{ key: string; value: string }>>;
  secretsForTenant(
    tenantId: string,
  ): Promise<Array<{ key: string; ciphertext: string | null }>>;
  allTenantIds(): Promise<string[]>;
  close(): Promise<void>;
}

export interface CreateRepositoryOptions {
  databaseUrl: string;
  namespace: string;
}

export function resolveSchema(namespace: string): string {
  return hashNamespace(namespace);
}

export function createRepository(
  opts: CreateRepositoryOptions,
): SecretsRepository & { schema: string } {
  const schema = resolveSchema(opts.namespace);
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const baseDb = new Kysely<SecretsDB>({
    dialect: new PostgresDialect({ pool }),
  });
  const db = baseDb.withSchema(schema);

  return {
    schema,
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

    async close() {
      await baseDb.destroy();
    },
  };
}
