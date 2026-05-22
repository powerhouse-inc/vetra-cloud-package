import type { Pool } from "pg";

/**
 * Pure helpers for the Reset Environment + Restart Service feature.
 *
 * The resolver layer wires owner-checks, `getTenantPool`, and the
 * existing tenant k8s client into these helpers; the helpers themselves
 * don't know about GraphQL, auth, or the subgraph host. That separation
 * mirrors the dumps and explorer modules, and makes the SQL/k8s parts
 * trivially unit-testable with stubs.
 */

/**
 * TRUNCATE every user-schema base table in a single transaction.
 *
 * The whole operation is wrapped in BEGIN/COMMIT so a failure on any
 * one table rolls back the lot — partial truncation would leave the
 * database in a state where some app data is missing while related
 * rows are still present, defeating the "clean slate" goal.
 *
 *   - `information_schema.tables` is queried with the standard
 *     exclusions (pg_catalog, information_schema, temp schemas).
 *   - Only BASE TABLEs are touched; views, foreign tables, and
 *     materialised views are deliberately left alone (they can't be
 *     TRUNCATEd anyway, and dropping them is out of scope).
 *   - Identifiers are double-quoted with embedded `"` escaped to `""`
 *     so a malicious schema/table name can't break out of the literal.
 *   - RESTART IDENTITY resets any owned sequences so the next insert
 *     starts at 1 — matches the freshly-provisioned env experience.
 *   - CASCADE walks FK chains so we don't have to topologically sort
 *     the table list; with the whole user schema being truncated at
 *     once this is the simplest correct option.
 *
 * Returns the number of tables truncated; 0 when the schema is empty
 * (in which case we don't run anything — TRUNCATE TABLE with zero
 * targets is a syntax error).
 */
export async function truncateUserTables(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_schema NOT LIKE 'pg_temp_%'
          AND table_type = 'BASE TABLE'`,
    );
    const tables = res.rows;
    if (tables.length === 0) return 0;

    const list = tables
      .map((row) => `${quoteIdent(row.table_schema)}.${quoteIdent(row.table_name)}`)
      .join(", ");
    const truncate = `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`;

    await client.query("BEGIN");
    try {
      await client.query(truncate);
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Best-effort rollback — surface the original error regardless.
      }
      throw err;
    }
    return tables.length;
  } finally {
    client.release();
  }
}

/** Double-quote a Postgres identifier, escaping embedded quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
