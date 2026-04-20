import { type Kysely } from "kysely";

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

  // Schema-aware idempotent ADD COLUMN: Kysely's alterTable honours the
  // Kysely instance's schema binding (withSchema()), which raw `ALTER TABLE`
  // SQL does not — so this works whether or not the subgraph's hashed schema
  // is in search_path.
  try {
    await db.schema
      .alterTable("tenant_secrets")
      .addColumn("ciphertext", "text")
      .execute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) throw err;
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("tenant_secrets").execute();
  await db.schema.dropTable("tenant_env_vars").execute();
}
