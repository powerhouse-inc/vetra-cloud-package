import type { Kysely } from "kysely";
import type { RuntimeConfigDB } from "./db/schema.js";

export interface RuntimeConfigRow {
  /** JSON-encoded `connect.*` subtree. */
  value: string;
  /** ISO-8601 timestamp of the most recent write. */
  updatedAt: string;
}

export interface RuntimeConfigRepository {
  /** Returns the stored row for `tenantId`, or `null` when no overrides exist. */
  runtimeConfigForTenant(tenantId: string): Promise<RuntimeConfigRow | null>;

  /** Returns every tenantId that has a runtime-config row. */
  allTenantIds(): Promise<string[]>;
}

export function createRepository(
  db: Kysely<RuntimeConfigDB>,
): RuntimeConfigRepository {
  return {
    async runtimeConfigForTenant(tenantId) {
      const row = await db
        .selectFrom("tenant_runtime_config")
        .select(["value", "updatedAt"])
        .where("tenantId", "=", tenantId)
        .executeTakeFirst();
      return row ?? null;
    },

    async allTenantIds() {
      const rows = await db
        .selectFrom("tenant_runtime_config")
        .select("tenantId")
        .distinct()
        .execute();
      return rows.map((r) => r.tenantId).sort();
    },
  };
}
