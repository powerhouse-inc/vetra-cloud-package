import { type Kysely } from "kysely";

/**
 * Idempotent migration. PK is just `tenantId` because runtime config is one
 * document per tenant (cf. tenant_env_vars which has PK (tenantId, key)).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("tenant_runtime_config")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("value", "text")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("tenant_runtime_config_pkey", ["tenantId"])
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tenant_runtime_config").execute();
}
