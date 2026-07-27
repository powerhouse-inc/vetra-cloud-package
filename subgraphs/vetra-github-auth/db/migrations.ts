import { type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("github_installations")
    .addColumn("user_did", "varchar(255)", (col) => col.notNull())
    .addColumn("environment_id", "varchar(255)", (col) => col.notNull())
    .addColumn("repo_full_name", "varchar(255)", (col) => col.notNull())
    .addColumn("created_at", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("github_installations_pkey", [
      "user_did",
      "environment_id",
    ])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("github_identities")
    .addColumn("user_did", "varchar(255)", (col) => col.notNull())
    .addColumn("github_login", "varchar(255)", (col) => col.notNull())
    .addColumn("github_user_id", "varchar(255)", (col) => col.notNull())
    .addColumn("created_at", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("github_identities_pkey", ["user_did"])
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("github_identities").execute();
  await db.schema.dropTable("github_installations").execute();
}
