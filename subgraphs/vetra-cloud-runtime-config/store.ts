import { sql } from "kysely";
import type { Kysely } from "kysely";
import { RUNTIME_CONFIG_ENV_KEY } from "./types.js";
import type { EnvVarsStore } from "./types.js";

type EnvVarRow = {
  tenant_id: string;
  key: string;
  value: string;
  updated_at: Date;
};

export type EnvVarsTable = { env_vars: EnvVarRow };

export class InMemoryEnvVarsStore implements EnvVarsStore {
  private rows = new Map<string, { value: string; updatedAt: Date }>();

  async getRuntimeConfigOverrides(tenantId: string) {
    const row = this.rows.get(tenantId);
    return row ? { value: row.value, updatedAt: row.updatedAt } : null;
  }

  async setRuntimeConfigOverrides(tenantId: string, value: string | null) {
    if (value === null) {
      this.rows.delete(tenantId);
      return { updatedAt: null };
    }
    const updatedAt = new Date();
    this.rows.set(tenantId, { value, updatedAt });
    return { updatedAt };
  }
}

export class KyselyEnvVarsStore implements EnvVarsStore {
  constructor(
    private readonly db: Kysely<EnvVarsTable>,
    private readonly tableName: string = "env_vars",
    private readonly notifyChannel: string = "env_vars_changed",
  ) {}

  /**
   * Idempotent schema setup for environments that don't have the table yet
   * (tests, dev). Production deployments rely on the existing
   * vetra-cloud-secrets / secrets-controller migration that creates the
   * shared env_vars table.
   */
  async ensureSchema(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql.ref(this.tableName)} (
        tenant_id  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, key)
      )
    `.execute(this.db);
  }

  async getRuntimeConfigOverrides(tenantId: string) {
    const row = await this.db
      .selectFrom(this.tableName as "env_vars")
      .select(["value", "updated_at"])
      .where("tenant_id", "=", tenantId)
      .where("key", "=", RUNTIME_CONFIG_ENV_KEY)
      .executeTakeFirst();
    if (!row) return null;
    return {
      value: row.value,
      updatedAt: row.updated_at instanceof Date
        ? row.updated_at
        : new Date(row.updated_at as unknown as string),
    };
  }

  async setRuntimeConfigOverrides(tenantId: string, value: string | null) {
    if (value === null) {
      await this.db
        .deleteFrom(this.tableName as "env_vars")
        .where("tenant_id", "=", tenantId)
        .where("key", "=", RUNTIME_CONFIG_ENV_KEY)
        .execute();
      await this.notify(tenantId);
      return { updatedAt: null };
    }

    const inserted = await this.db
      .insertInto(this.tableName as "env_vars")
      .values({
        tenant_id: tenantId,
        key: RUNTIME_CONFIG_ENV_KEY,
        value,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "key"]).doUpdateSet((eb) => ({
          value: eb.ref("excluded.value"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .returning("updated_at")
      .executeTakeFirstOrThrow();
    await this.notify(tenantId);
    const ts = inserted.updated_at as unknown;
    return {
      updatedAt: ts instanceof Date ? ts : new Date(ts as string),
    };
  }

  private async notify(tenantId: string): Promise<void> {
    try {
      await sql`SELECT pg_notify(${sql.lit(this.notifyChannel)}, ${tenantId})`.execute(
        this.db,
      );
    } catch {
      // pg_notify failure should not abort the write; the secrets-controller
      // also has polling. Production logging hooks can be wired by the
      // deployment.
    }
  }
}
