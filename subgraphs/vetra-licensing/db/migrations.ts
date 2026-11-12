import { type ColumnDefinitionBuilderCallback, type Kysely, sql } from "kysely";
import { ensureLedgerTables } from "../licensing-ledger.js";

/** Postgres SQLSTATE for "column already exists". */
const DUPLICATE_COLUMN = "42701";

/**
 * The schema `db` writes to. A namespaced db (relationalDb.createNamespace) is
 * `withSchema(<hash>)`, which qualifies table names at query-build time and
 * leaves the session's search_path alone, so current_schema() would name the
 * wrong schema. Read it off the transformed query instead; an unqualified db
 * falls back to current_schema().
 */
function namespaceSchema(db: Kysely<any>, table: string): string | null {
  const node = db.selectFrom(table).selectAll().toOperationNode() as {
    from?: { froms?: { kind?: string; table?: { schema?: { name?: string } } }[] };
  };
  const from = node.from?.froms?.[0];
  return from?.kind === "TableNode" ? (from.table?.schema?.name ?? null) : null;
}

/**
 * addColumn has no IF NOT EXISTS; the boot-time runner calls up() on every
 * start. ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it then fails
 * with "column already exists", so look first: a no-op boot must not queue
 * behind (and block) live traffic on the table. The 42701 swallow stays for a
 * race with another replica booting at the same time.
 */
async function addColumnIfMissing(
  db: Kysely<any>,
  table: string,
  column: string,
  type: "varchar(255)" | "text" | "boolean" | "double precision" | "integer",
  build?: ColumnDefinitionBuilderCallback,
): Promise<void> {
  const schema = namespaceSchema(db, table);
  const { rows } = await sql<{ present: number }>`
    SELECT 1 AS present FROM information_schema.columns
    WHERE table_schema = COALESCE(${schema}::text, current_schema())
      AND table_name = ${table}
      AND column_name = ${column}
  `.execute(db);
  if (rows.length > 0) return;
  try {
    await db.schema.alterTable(table).addColumn(column, type, build).execute();
  } catch (error) {
    if ((error as { code?: string })?.code !== DUPLICATE_COLUMN) throw error;
  }
}

/**
 * Must not run inside a transaction: each ALTER TABLE's lock is held until
 * commit, and a swallowed 42701 aborts the surrounding transaction.
 */
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
    // Built with the query builder, not raw SQL: the namespace schema (withSchema)
    // only qualifies table names the builder emits. A raw `from app_user_environments`
    // resolves against search_path and fails on a real namespaced database.
    .expression((eb) =>
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
    .onConflict((oc) => oc.column("license_id").doNothing())
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

  await db.schema.createTable("app_warm_pool")
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("template_id", "varchar(255)", (c) => c.notNull())
    .addColumn("template_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("state", "varchar(16)", (c) => c.notNull())
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addColumn("ready_at", "varchar(255)")
    .addColumn("claimed_at", "varchar(255)")
    .addColumn("deleted_at", "varchar(255)")
    .addColumn("root_license_id", "varchar(255)")
    .addPrimaryKeyConstraint("app_warm_pool_pkey", ["environment_id"])
    .ifNotExists().execute();
  await db.schema.createIndex("app_warm_pool_key_idx").on("app_warm_pool")
    .columns(["app_id", "template_id", "state"]).ifNotExists().execute();
  // When the retired row's environment document was deleted: until then the
  // keeper retries the deletion (a retired row whose delete failed was an
  // orphan nobody swept). Rows retired before this column existed have it
  // null and are swept once; deleting a document already gone is a no-op.
  await addColumnIfMissing(db, "app_warm_pool", "env_deleted_at", "varchar(255)");
  // The pool size the row was created for: a run of WARMING timeouts halts a
  // pool only for one (template hash, size). Older rows have none and count
  // for no streak.
  await addColumnIfMissing(db, "app_warm_pool", "pool_size", "integer");
  // Set, in the same update that retires the row, only when the keeper
  // retired it for not becoming READY within MAX_WARMING_MS: what the
  // timeout streak counts (an old row drained or trimmed is not a timeout).
  await addColumnIfMissing(db, "app_warm_pool", "timed_out_at", "varchar(255)");
  // The timeout streak reads a pool's newest rows.
  await db.schema.createIndex("app_warm_pool_created_idx").on("app_warm_pool")
    .columns(["app_id", "template_id", "created_at"]).ifNotExists().execute();

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
  // Codes moved from vetra-access-codes, which trimmed and lowercased every
  // input: those (and only those) still match case-insensitively.
  await addColumnIfMissing(db, "invite_codes", "legacy_case_insensitive", "boolean", (c) =>
    c.notNull().defaultTo(false),
  );
  // The monthly LLM budget (USD) a licence redeemed from this code gets for
  // its Studio's OpenRouter key; null = the deployment default. double
  // precision, not numeric: it must read back as a number.
  await addColumnIfMissing(db, "invite_codes", "llm_budget_usd", "double precision");

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

  await db.schema.createTable("license_lifecycle")
    .addColumn("license_id", "varchar(255)", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull())
    .addColumn("end_at", "varchar(255)")
    .addColumn("replaced_by", "varchar(255)")
    .addColumn("updated_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("license_lifecycle_pkey", ["license_id"])
    .ifNotExists().execute();

  // Also created by vetra-apps, which writes the ledger too (licensing-ledger.ts).
  await ensureLedgerTables(db);

  // App release rollout (spec 2026-11-10 §4): the release policy, the canary
  // flag, promotions and every environment's FUSION version moves.
  await db.schema.createTable("app_release_settings")
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("policy", "varchar(16)", (c) => c.notNull().defaultTo("AUTO"))
    .addColumn("default_notice_hours", "integer", (c) => c.notNull().defaultTo(72))
    .addColumn("updated_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_release_settings_pkey", ["app_id"])
    .ifNotExists().execute();
  await addColumnIfMissing(db, "license_environments", "channel_override", "varchar(255)");
  await db.schema.createTable("app_rollouts")
    .addColumn("id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("artifact_name", "varchar(255)", (c) => c.notNull())
    .addColumn("version", "varchar(255)", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull())
    .addColumn("apply_after", "varchar(255)", (c) => c.notNull())
    .addColumn("promoted_by", "varchar(255)", (c) => c.notNull())
    .addColumn("promoted_at", "varchar(255)", (c) => c.notNull())
    .addColumn("paused_at", "varchar(255)")
    .addColumn("paused_reason", "text")
    .addPrimaryKeyConstraint("app_rollouts_pkey", ["id"])
    .ifNotExists().execute();
  await db.schema.createIndex("app_rollouts_artifact_idx").on("app_rollouts")
    .columns(["app_id", "artifact_name", "status"]).ifNotExists().execute();
  await db.schema.createTable("environment_updates")
    .addColumn("id", "varchar(255)", (c) => c.notNull())
    .addColumn("rollout_id", "varchar(255)")
    .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
    .addColumn("app_id", "varchar(255)", (c) => c.notNull())
    .addColumn("from_version", "varchar(255)", (c) => c.notNull())
    .addColumn("to_version", "varchar(255)", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull())
    .addColumn("due_at", "varchar(255)", (c) => c.notNull())
    .addColumn("requested_at", "varchar(255)")
    .addColumn("started_at", "varchar(255)")
    .addColumn("finished_at", "varchar(255)")
    .addColumn("pre_update_dump_id", "varchar(255)")
    .addColumn("error", "text")
    .addColumn("forced_at", "varchar(255)")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addPrimaryKeyConstraint("environment_updates_pkey", ["id"])
    // NULL rollout ids are distinct: a canary or AUTO app may have many.
    .addUniqueConstraint("environment_updates_rollout_env_key", ["rollout_id", "environment_id"])
    .ifNotExists().execute();
  await db.schema.createIndex("environment_updates_env_idx").on("environment_updates")
    .columns(["environment_id", "created_at"]).ifNotExists().execute();
  await db.schema.createIndex("environment_updates_app_status_idx").on("environment_updates")
    .columns(["app_id", "status"]).ifNotExists().execute();
  // The licence gate asks per (App, holder) on every check (releases phase 3 slice 5).
  try {
    await db.schema.createIndex("app_license_grants_app_user_idx").on("app_license_grants")
      .columns(["app_id", "user_address"]).ifNotExists().execute();
  } catch (error) {
    // Another replica booting at the same time created it first.
    const code = (error as { code?: string })?.code;
    if (code !== "42P07" && code !== "23505") throw error;
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [
    "environment_updates",
    "app_rollouts",
    "app_release_settings",
    "license_lifecycle",
    "app_licensing_intent",
    "app_licensing_state",
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
