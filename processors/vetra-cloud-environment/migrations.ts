import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("environments")
    .addColumn("id", "varchar(255)")
    .addColumn("name", "varchar(255)")
    .addColumn("subdomain", "varchar(255)")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("customDomain", "varchar(255)")
    .addColumn("packages", "text")
    .addColumn("services", "text")
    .addColumn("status", "varchar(50)")
    .addPrimaryKeyConstraint("environments_pkey", ["id"])
    .ifNotExists()
    .execute();

  // Migrate from old schema: add columns that may not exist yet
  for (const column of ["subdomain", "tenantId", "customDomain"] as const) {
    try {
      await db.schema
        .alterTable("environments")
        .addColumn(column, "varchar(255)")
        .execute();
    } catch {
      // Column already exists — expected for fresh installs
    }
  }

  // Drop legacy "domain" column if present
  try {
    await db.schema
      .alterTable("environments")
      .dropColumn("domain")
      .execute();
  } catch {
    // Column doesn't exist — expected for fresh installs
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("environments").execute();
}
