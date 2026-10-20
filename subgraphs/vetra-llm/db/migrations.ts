import type { Kysely } from "kysely";
import { isConcurrentIndexError } from "../../vetra-apps/db/migrations.js";

/**
 * Schema builder only: the switchboard hands the subgraph
 * db.withSchema("vetra-llm"), and only builder table refs are qualified. Also
 * run by vetra-studio-pool at its setup (boot order is not fixed), so two boots
 * may race: a lost race (42P07 / 23505) is fine.
 */
export async function up(db: Kysely<any>): Promise<void> {
  try {
    await db.schema
      .createTable("studio_llm_keys")
      .addColumn("environment_id", "varchar(255)", (c) => c.primaryKey())
      .addColumn("source", "varchar(16)", (c) => c.notNull())
      .addColumn("key_hash", "varchar(128)")
      .addColumn("key_ciphertext", "text")
      .addColumn("limit_usd", "double precision")
      .addColumn("limit_reset", "varchar(16)", (c) =>
        c.notNull().defaultTo("monthly"),
      )
      .addColumn("model", "varchar(255)", (c) => c.notNull())
      .addColumn("owner_did", "varchar(255)", (c) => c.notNull())
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("created_at", "varchar(64)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .ifNotExists()
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createIndex("studio_llm_keys_status_idx")
      .ifNotExists()
      .on("studio_llm_keys")
      .column("status")
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createTable("studio_llm_budget_overrides")
      .addColumn("environment_id", "varchar(255)", (c) => c.primaryKey())
      .addColumn("limit_usd", "double precision", (c) => c.notNull())
      .addColumn("set_by", "varchar(255)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(64)", (c) => c.notNull())
      .ifNotExists()
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createTable("studio_llm_budget_requests")
      .addColumn("id", "varchar(64)", (c) => c.primaryKey())
      .addColumn("environment_id", "varchar(255)", (c) => c.notNull())
      .addColumn("requested_by", "varchar(255)", (c) => c.notNull())
      .addColumn("requested_at", "varchar(64)", (c) => c.notNull())
      .addColumn("handled_at", "varchar(64)")
      .ifNotExists()
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
  try {
    await db.schema
      .createIndex("studio_llm_budget_requests_env_idx")
      .ifNotExists()
      .on("studio_llm_budget_requests")
      .column("environment_id")
      .execute();
  } catch (err) {
    if (!isConcurrentIndexError(err)) throw err;
  }
}
