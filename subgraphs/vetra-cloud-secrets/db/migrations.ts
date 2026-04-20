import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("tenant_env_vars")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("key", "varchar(255)")
    .addColumn("value", "text")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("tenant_env_vars_pkey", ["tenantId", "key"])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("tenant_secrets")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("key", "varchar(255)")
    .addColumn("updatedAt", "varchar(255)")
    .addPrimaryKeyConstraint("tenant_secrets_pkey", ["tenantId", "key"])
    .ifNotExists()
    .execute();

  await sql`ALTER TABLE tenant_secrets ADD COLUMN IF NOT EXISTS ciphertext TEXT`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tenant_secrets").execute();
  await db.schema.dropTable("tenant_env_vars").execute();
}
