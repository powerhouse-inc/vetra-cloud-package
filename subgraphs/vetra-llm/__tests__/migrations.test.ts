import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";

describe("vetra-llm migrations", () => {
  it("creates studio_llm_keys inside the namespace schema only, idempotently", async () => {
    const pg = new PGlite();
    const root = new Kysely<any>({ dialect: new PGliteDialect(pg) });
    try {
      await sql`CREATE SCHEMA "vetra-llm"`.execute(root);
      const ns = root.withSchema("vetra-llm");
      await up(ns);
      await up(ns);
      const tables = await pg.query<{
        table_schema: string;
        table_name: string;
      }>(
        `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'studio_llm_keys'`,
      );
      expect(tables.rows).toStrictEqual([
        { table_schema: "vetra-llm", table_name: "studio_llm_keys" },
      ]);
      const publicTables = await pg.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(publicTables.rows).toStrictEqual([]);
    } finally {
      await root.destroy();
    }
  });

  it("creates the budget override and request tables in the namespace, idempotently", async () => {
    const pg = new PGlite();
    const root = new Kysely<any>({ dialect: new PGliteDialect(pg) });
    try {
      await sql`CREATE SCHEMA "vetra-llm"`.execute(root);
      const ns = root.withSchema("vetra-llm");
      await up(ns);
      await up(ns);
      const cols = await pg.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'vetra-llm' AND table_name LIKE 'studio_llm_budget_%'
         ORDER BY table_name, ordinal_position`,
      );
      expect(
        cols.rows.map((r) => `${r.table_name}.${r.column_name}`),
      ).toStrictEqual([
        "studio_llm_budget_overrides.environment_id",
        "studio_llm_budget_overrides.limit_usd",
        "studio_llm_budget_overrides.set_by",
        "studio_llm_budget_overrides.updated_at",
        "studio_llm_budget_requests.id",
        "studio_llm_budget_requests.environment_id",
        "studio_llm_budget_requests.requested_by",
        "studio_llm_budget_requests.requested_at",
        "studio_llm_budget_requests.handled_at",
      ]);
      const publicTables = await pg.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(publicTables.rows).toStrictEqual([]);
    } finally {
      await root.destroy();
    }
  });

  it("survives two boots racing on the same schema", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-llm"`.execute(root);
      const ns = root.withSchema("vetra-llm");
      await Promise.all([up(ns), up(ns)]);
      await expect(up(ns)).resolves.toBeUndefined();
    } finally {
      await root.destroy();
    }
  });
});
