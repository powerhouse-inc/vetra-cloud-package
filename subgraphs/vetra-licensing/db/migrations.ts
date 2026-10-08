import { type Kysely } from "kysely";

/** Postgres SQLSTATE for "column already exists". */
const DUPLICATE_COLUMN = "42701";

/** addColumn has no IF NOT EXISTS; the boot-time runner calls up() on every start. */
async function addColumnIfMissing(
  db: Kysely<any>,
  table: string,
  column: string,
  type: "varchar(255)" | "text",
): Promise<void> {
  try {
    await db.schema.alterTable(table).addColumn(column, type).execute();
  } catch (error) {
    if ((error as { code?: string })?.code !== DUPLICATE_COLUMN) throw error;
  }
}

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

  await addColumnIfMissing(db, "app_license_grants", "kind", "varchar(255)");
  await addColumnIfMissing(db, "app_license_grants", "user_did", "varchar(255)");
  await db.schema.createIndex("app_license_grants_user_did_idx").on("app_license_grants")
    .column("user_did").ifNotExists().execute();

  await db.schema.createTable("license_chain")
    .addColumn("license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("root_license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("label", "varchar(255)")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("license_chain_pkey", ["license_id"])
    .ifNotExists().execute();
  await db.schema.createIndex("license_chain_root_idx").on("license_chain")
    .column("root_license_id").ifNotExists().execute();

  await db.schema.createTable("license_environments")
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("root_license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("template_id", "varchar(255)")
    .addColumn("label", "varchar(255)")
    .addColumn("template_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("ended_at", "varchar(255)")
    .addColumn("stopped_at", "varchar(255)")
    .addColumn("delete_after", "varchar(255)")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addColumn("updated_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("license_environments_pkey", ["environment_id"])
    .addUniqueConstraint("license_environments_root_key", ["root_license_id"])
    .ifNotExists().execute();
  for (const col of ["app_id", "license_id"] as const) {
    await db.schema.createIndex(`license_environments_${col}_idx`).on("license_environments")
      .column(col).ifNotExists().execute();
  }

  await db.schema.createTable("app_allow_list")
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("added_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_allow_list_pkey", ["app_id", "user_did"])
    .ifNotExists().execute();

  await db.schema.createTable("invite_codes")
    .addColumn("code", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("kind", "varchar(255)", (c) => c.notNull())
    .addColumn("label", "varchar(255)")
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("expires_at", "varchar(255)")
    .addColumn("max_uses", "integer")
    .addColumn("anthropic_key_ciphertext", "text")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("invite_codes_pkey", ["code"])
    .ifNotExists().execute();
  await db.schema.createIndex("invite_codes_app_id_idx").on("invite_codes")
    .column("app_id").ifNotExists().execute();

  await db.schema.createTable("invite_redemptions")
    .addColumn("code", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("redeemed_at", "varchar(255)", (c) => c.notNull())
    .addColumn("access_expires", "varchar(255)")
    .addColumn("license_id", "varchar(255)")
    .addPrimaryKeyConstraint("invite_redemptions_pkey", ["code", "user_did"])
    .ifNotExists().execute();
  await db.schema.createIndex("invite_redemptions_user_did_idx").on("invite_redemptions")
    .column("user_did").ifNotExists().execute();

  await db.schema.createTable("environment_reporting_tokens")
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("token_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("environment_reporting_tokens_pkey", ["environment_id"])
    .addUniqueConstraint("environment_reporting_tokens_hash_key", ["token_hash"])
    .ifNotExists().execute();

  await db.schema.createTable("licensing_migration_type_map")
    .addColumn("license_type_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("kind", "varchar(255)", (c) => c.notNull())
    .addColumn("template_id", "varchar(255)", (c) => c.notNull())
    .addColumn("term_id", "varchar(255)", (c) => c.notNull())
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("licensing_migration_type_map_pkey", ["license_type_id"])
    .ifNotExists().execute();

  await db.schema.createTable("licensing_migration_steps")
    .addColumn("step", "varchar(64)", (c) => c.notNull())
    .addColumn("completed_at", "varchar(255)", (c) => c.notNull())
    .addColumn("detail", "text")
    .addPrimaryKeyConstraint("licensing_migration_steps_pkey", ["step"])
    .ifNotExists().execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [
    "licensing_migration_steps",
    "licensing_migration_type_map",
    "environment_reporting_tokens",
    "invite_redemptions",
    "invite_codes",
    "app_allow_list",
    "license_environments",
    "license_chain",
  ]) {
    await db.schema.dropTable(t).ifExists().execute();
  }
  await db.schema.dropTable("app_license_grants").execute();
  await db.schema.dropTable("app_environment_limits").execute();
  await db.schema.dropTable("app_user_environments").execute();
}
