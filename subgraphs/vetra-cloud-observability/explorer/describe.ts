import type { Pool } from "pg";

/**
 * Schema-introspection types — same shape as the GraphQL types so the
 * resolver can return the helper's result directly.
 */
export type DatabaseColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
};

export type DatabaseIndexInfo = {
  name: string;
  columns: string[];
  unique: boolean;
};

export type DatabaseTableInfo = {
  name: string;
  columns: DatabaseColumnInfo[];
  indexes: DatabaseIndexInfo[];
};

export type DatabaseSchemaInfo = {
  name: string;
  tables: DatabaseTableInfo[];
  truncated?: boolean;
};

export type DatabaseSchema = {
  schemas: DatabaseSchemaInfo[];
};

/**
 * Server-side cap on the number of tables per schema returned. Schemas
 * with more than this many tables get `truncated: true` flagged and the
 * first MAX_TABLES_PER_SCHEMA tables alphabetically. Bounds payload
 * size; matches the spec's 500-row note.
 */
const MAX_TABLES_PER_SCHEMA = 500;

/**
 * Hard timeout for every introspection query (`statement_timeout` set
 * on the connection). 10s is generous — `information_schema` queries
 * over reasonable databases finish in tens of milliseconds — but
 * avoids hanging the resolver if `information_schema` is wedged by a
 * long-running DDL lock.
 */
const STATEMENT_TIMEOUT_MS = 10_000;

type ColumnRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

type IndexRow = {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
};

type TableRow = {
  table_schema: string;
  table_name: string;
};

type PkRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
};

/**
 * Parses the column list out of a `pg_indexes.indexdef`. The string
 * format is fixed by Postgres:
 *   `CREATE [UNIQUE] INDEX <name> ON <schema>.<table> USING <method> (col1, col2)`
 * We extract the parenthesised column list, strip quoting/whitespace,
 * and split on commas. Expressions like `(lower(col))` survive verbatim
 * since the UI treats columns as display strings.
 */
function parseIndexDef(indexdef: string): {
  columns: string[];
  unique: boolean;
} {
  const unique = /^CREATE\s+UNIQUE\s+INDEX/i.test(indexdef);
  const match = indexdef.match(/\((.+)\)\s*$/);
  if (!match) return { columns: [], unique };
  const inner = match[1];
  // Split on commas not inside nested parens. Index expressions like
  // `lower(col), other_col` would otherwise be misparsed.
  const cols: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      cols.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    cols.push(current.trim().replace(/^"|"$/g, ""));
  }
  return { columns: cols, unique };
}

/**
 * Pure helper: introspects a Postgres database's user schemas and
 * returns a `DatabaseSchema` snapshot. Three queries are issued:
 *
 *   1. `information_schema.tables` — list every base table outside
 *      the `pg_catalog`/`information_schema` schemas.
 *   2. `information_schema.columns` joined with `pg_constraint` /
 *      `pg_attribute` to surface column types, defaults, nullability,
 *      and primary-key membership.
 *   3. `pg_indexes` for index metadata (name, columns, unique).
 *
 * Results are combined in-memory; each schema's tables list is
 * truncated at MAX_TABLES_PER_SCHEMA (sorted by name asc) and the
 * `truncated` flag is set when the cap was hit.
 *
 * The pool is left alone — caller is responsible for its lifecycle.
 * Every query runs on a freshly-checked-out client with
 * `statement_timeout` set explicitly so the introspection can't hang
 * the resolver indefinitely.
 */
export async function describeDatabase(pool: Pool): Promise<DatabaseSchema> {
  const client = await pool.connect();
  try {
    // `SET LOCAL` only behaves predictably inside a transaction —
    // outside one, Postgres treats it as undefined behaviour and has
    // historically silently promoted the setting to session scope,
    // leaking the timeout into subsequent queries on the same pooled
    // connection. Mirror execute.ts: open a READ ONLY transaction,
    // run the introspection, COMMIT on success / ROLLBACK on error.
    await client.query("BEGIN READ ONLY");
    try {
      await client.query(
        `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
      );

      const [tablesRes, columnsRes, pksRes, indexesRes] = await Promise.all([
        client.query<TableRow>(
          `SELECT table_schema, table_name
             FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND table_type = 'BASE TABLE'
            ORDER BY table_schema ASC, table_name ASC`,
        ),
        client.query<ColumnRow>(
          `SELECT table_schema, table_name, column_name, data_type,
                  is_nullable, column_default
             FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema ASC, table_name ASC, ordinal_position ASC`,
        ),
        // Primary-key columns via pg_constraint → pg_attribute. The
        // information_schema.key_column_usage view is the textbook source
        // but it scales poorly on large databases; pg_constraint joins are
        // O(constraints).
        client.query<PkRow>(
          `SELECT n.nspname AS table_schema,
                  c.relname AS table_name,
                  a.attname AS column_name
             FROM pg_constraint con
             JOIN pg_class c        ON c.oid = con.conrelid
             JOIN pg_namespace n    ON n.oid = c.relnamespace
             JOIN pg_attribute a    ON a.attrelid = c.oid
                                    AND a.attnum = ANY(con.conkey)
            WHERE con.contype = 'p'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
        ),
        client.query<IndexRow>(
          `SELECT schemaname, tablename, indexname, indexdef
             FROM pg_indexes
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY schemaname ASC, tablename ASC, indexname ASC`,
        ),
      ]);

      // Build the PK set (`schema|table|column`) for O(1) lookup
      // while we iterate columns.
      const pkSet = new Set<string>();
      for (const r of pksRes.rows) {
        pkSet.add(`${r.table_schema}|${r.table_name}|${r.column_name}`);
      }

      // Per-schema → per-table grouping. Use plain Maps keyed by name;
      // the surface is small enough that the overhead of a more
      // sophisticated structure isn't worth it.
      const schemas = new Map<
        string,
        Map<
          string,
          { columns: DatabaseColumnInfo[]; indexes: DatabaseIndexInfo[] }
        >
      >();

      for (const t of tablesRes.rows) {
        let bySchema = schemas.get(t.table_schema);
        if (!bySchema) {
          bySchema = new Map();
          schemas.set(t.table_schema, bySchema);
        }
        if (!bySchema.has(t.table_name)) {
          bySchema.set(t.table_name, { columns: [], indexes: [] });
        }
      }

      for (const c of columnsRes.rows) {
        const bySchema = schemas.get(c.table_schema);
        if (!bySchema) continue;
        const table = bySchema.get(c.table_name);
        if (!table) continue;
        table.columns.push({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === "YES",
          default: c.column_default,
          isPrimaryKey: pkSet.has(
            `${c.table_schema}|${c.table_name}|${c.column_name}`,
          ),
        });
      }

      for (const i of indexesRes.rows) {
        const bySchema = schemas.get(i.schemaname);
        if (!bySchema) continue;
        const table = bySchema.get(i.tablename);
        if (!table) continue;
        const { columns, unique } = parseIndexDef(i.indexdef);
        table.indexes.push({ name: i.indexname, columns, unique });
      }

      const result: DatabaseSchemaInfo[] = [];
      // Stable schema ordering: alphabetical.
      const orderedSchemaNames = Array.from(schemas.keys()).sort();
      for (const schemaName of orderedSchemaNames) {
        const bySchema = schemas.get(schemaName)!;
        const tableNames = Array.from(bySchema.keys()).sort();
        const truncated = tableNames.length > MAX_TABLES_PER_SCHEMA;
        const kept = truncated
          ? tableNames.slice(0, MAX_TABLES_PER_SCHEMA)
          : tableNames;
        const tables: DatabaseTableInfo[] = kept.map((name) => {
          const t = bySchema.get(name)!;
          return { name, columns: t.columns, indexes: t.indexes };
        });
        result.push({
          name: schemaName,
          tables,
          ...(truncated ? { truncated: true } : {}),
        });
      }

      await client.query("COMMIT");
      return { schemas: result };
    } catch (err) {
      // Unconditional ROLLBACK on any failure. Postgres would
      // auto-abort the transaction on a query error, but issuing it
      // explicitly keeps the connection state predictable so the
      // pool can hand the client back out cleanly.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow — connection may already be in failed state */
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
