import { type Kysely } from "kysely";

/** Postgres SQLSTATE for "column already exists". */
const DUPLICATE_COLUMN = "42701";

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

  // Added after the initial table shipped. Use the schema-aware builder (not a
  // raw `sql` template) so the statement targets this subgraph's namespaced
  // schema — a raw ALTER runs against the connection search_path and fails with
  // 42P01 "relation invite_codes does not exist". addColumn has no
  // IF NOT EXISTS, so swallow the duplicate-column error to stay idempotent
  // across the boot-time runner's repeated invocations.
  try {
    await db.schema
      .alterTable("invite_codes")
      .addColumn("anthropic_key_ciphertext", "text")
      .execute();
  } catch (error) {
    if ((error as { code?: string })?.code !== DUPLICATE_COLUMN) throw error;
  }

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
