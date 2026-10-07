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
    .createTable("app_license_grants")
    .addColumn("license_id", "varchar(255)", (col) => col.notNull())
    .addColumn("app_id", "varchar(255)", (col) => col.notNull())
    .addColumn("license_type_id", "varchar(255)", (col) => col.notNull())
    .addColumn("user_address", "varchar(255)", (col) => col.notNull())
    .addColumn("issued_by", "varchar(255)", (col) => col.notNull())
    .addColumn("created_at", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("app_license_grants_pkey", ["license_id"])
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("app_license_grants_app_id_idx")
    .on("app_license_grants")
    .column("app_id")
    .ifNotExists()
    .execute();

  // Backfill: every environment the keeper has already built was created from a
  // licence that existed before this table did. Without this, those licences
  // would look unauthorised on the first tick after deploy. They are still only
  // HELD rather than released, but backfilling keeps them reconciling normally.
  await db
    .insertInto("app_license_grants")
    .columns([
      "license_id",
      "app_id",
      "license_type_id",
      "user_address",
      "issued_by",
      "created_at",
    ])
    .expression((eb: any) =>
      eb
        .selectFrom("app_user_environments")
        .select([
          "license_id",
          "app_id",
          eb.val("").as("license_type_id"),
          "user_address",
          eb.val("backfill").as("issued_by"),
          "created_at",
        ]),
    )
    .onConflict((oc: any) => oc.column("license_id").doNothing())
    .execute();

  await db.schema
    .createIndex("app_user_environments_app_id_idx")
    .on("app_user_environments")
    .column("app_id")
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("app_license_grants").execute();
  await db.schema.dropTable("app_environment_limits").execute();
  await db.schema.dropTable("app_user_environments").execute();
}
