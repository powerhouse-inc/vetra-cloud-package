import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("environments")
    .addColumn("id", "varchar(255)")
    .addColumn("name", "varchar(255)")
    .addColumn("domain", "varchar(255)")
    .addColumn("packages", "varchar(255)")
    .addColumn("services", "varchar(255)")
    .addColumn("status", "varchar(255)")
    .addPrimaryKeyConstraint("environments_pkey", ["id"])
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("environments").execute();
}
