import { type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("app_user_environments")
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("user_address", "varchar(255)", (col) => col.notNull())
    .addColumn("environment_id", "varchar(255)", (col) => col.notNull())
    .addColumn("license_id", "varchar(255)", (col) => col.notNull())
    .addColumn("template_hash", "varchar(64)", (col) => col.notNull())
    .addColumn("created_at", "varchar(255)", (col) => col.notNull())
    .addColumn("updated_at", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_user_environments_pkey", [
      "app_id",
      "user_address",
    ])
    .ifNotExists()
    .execute();

  await db.schema
    .createTable("app_environment_limits")
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("max_environments", "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_environment_limits_pkey", ["app_id"])
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("app_user_environments_app_id_idx")
    .on("app_user_environments")
    .column("app_id")
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("app_environment_limits").execute();
  await db.schema.dropTable("app_user_environments").execute();
}
