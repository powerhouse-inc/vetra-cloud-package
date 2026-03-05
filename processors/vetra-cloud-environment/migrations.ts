import { type IRelationalDbLegacy } from "document-drive/processors/types";

export async function up(db: IRelationalDbLegacy<any>): Promise<void> {
  // Create table
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

export async function down(db: IRelationalDbLegacy<any>): Promise<void> {
  // drop table
  await db.schema.dropTable("environments").execute();
}
