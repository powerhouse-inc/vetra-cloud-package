import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("invite_codes")
    .addColumn("code", "varchar(255)", (col) => col.notNull())
    .addColumn("label", "varchar(255)")
    .addColumn("active", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("expires_at", "varchar(255)")
    .addColumn("max_uses", "integer")
    .addColumn("created_at", "varchar(255)", (col) => col.notNull())
    .addPrimaryKeyConstraint("invite_codes_pkey", ["code"])
    .ifNotExists()
    .execute();

  // Added after the initial table shipped; ADD COLUMN IF NOT EXISTS keeps the
  // boot-time runner idempotent on databases created before this column.
  await sql`ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS anthropic_key_ciphertext text`.execute(
    db,
  );

  await db.schema
    .createTable("invite_redemptions")
    .addColumn("code", "varchar(255)", (col) => col.notNull())
    .addColumn("user_did", "varchar(255)", (col) => col.notNull())
    .addColumn("redeemed_at", "varchar(255)", (col) => col.notNull())
    .addColumn("access_expires", "varchar(255)")
    .addPrimaryKeyConstraint("invite_redemptions_pkey", ["code", "user_did"])
    .ifNotExists()
    .execute();

  await db.schema
    .createIndex("invite_redemptions_user_did_idx")
    .on("invite_redemptions")
    .column("user_did")
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("invite_redemptions").execute();
  await db.schema.dropTable("invite_codes").execute();
}
