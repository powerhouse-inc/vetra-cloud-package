import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLlmDB } from "../db/schema.js";

/**
 * The subgraph's db exactly as the switchboard hands it over: a "vetra-llm"
 * schema reached through withSchema, with nothing in public.
 */
export async function openLlmDb(): Promise<{
  root: Kysely<any>;
  db: Kysely<VetraLlmDB>;
  destroy(): Promise<void>;
}> {
  const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`CREATE SCHEMA "vetra-llm"`.execute(root);
  const db = root.withSchema("vetra-llm") as unknown as Kysely<VetraLlmDB>;
  await up(db as unknown as Kysely<any>);
  return { root, db, destroy: () => root.destroy() };
}
