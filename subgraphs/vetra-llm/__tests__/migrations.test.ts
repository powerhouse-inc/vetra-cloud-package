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
