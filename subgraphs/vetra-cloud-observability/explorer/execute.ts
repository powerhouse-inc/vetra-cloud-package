import type { Pool } from "pg";

/**
 * Result shape — strings + nulls in cells, ready for JSON transport.
 */
export type DatabaseQueryResult = {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  truncatedAt: number | null;
  executionMs: number;
};

/**
 * Default and ceiling for the LIMIT clause appended/capped by the
 * resolver. Default 1 000 matches the UI's default select; the hard
 * ceiling 10 000 is the upper bound of the user-bumpable select.
 *
 * Both are static rather than env-driven so they can't be widened by
 * misconfiguration. A change requires a code review.
 */
export const DEFAULT_LIMIT = 1_000;
export const MAX_LIMIT = 10_000;

/**
 * Payload cap on the JSON-stringified rows array. Above this we
 * truncate rows back to `truncatedAt`. 4 MB is the rough boundary
 * past which switchboard's HTTP response handling starts to balloon
 * memory + render latency in the browser; the row-count cap usually
 * catches things first, but a single SELECT * over a wide table with
 * large jsonb columns can blow past 10 000 rows × tiny size.
 */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Statement keywords that imply a write or admin operation. The check
 * is defence-in-depth on top of `BEGIN READ ONLY`; we want to reject
 * these before they hit the database (so we can surface a clean
 * QUERY_BLOCKED message instead of a Postgres error). Case is
 * normalised before the lookup.
 */
const BLOCKED_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "CALL",
  "DO",
  "EXECUTE",
]);

/**
 * Strip line (`-- …`) and block (`/* … *\/`) comments from SQL before
 * keyword detection. Returning the cleaned string for the keyword
 * scan only; the original (un-comment-stripped) SQL is what we
 * actually execute, since Postgres handles comments fine and the user
 * may rely on them. The point of stripping here is purely to prevent
 * a comment-prefixed write from sneaking past the keyword check.
 */
function stripComments(sql: string): string {
  // Order matters: block comments first so a `--` inside `/* */`
  // isn't mistaken for a line comment.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*(?:\n|$)/g, "\n");
}

/**
 * Detect whether the (already-cleaned + trimmed) SQL ends with a
 * `LIMIT <n>` clause. The regex is intentionally narrow: a `LIMIT`
 * inside a subquery is fine because the outer query still needs a
 * cap — we add an outer `LIMIT n` regardless, and Postgres composes
 * them correctly.
 *
 * Returns the parsed limit value when matched, otherwise null.
 */
function detectTrailingLimit(sql: string): number | null {
  // Allow trailing semicolons / whitespace.
  const trimmed = sql.replace(/[;\s]+$/g, "");
  const m = trimmed.match(/\bLIMIT\s+(\d+)\s*$/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Returns the first non-empty statement from a `;`-delimited string.
 * Subsequent statements are discarded — the resolver UI surfaces this
 * as an inline notice.
 */
function firstStatement(sql: string): string {
  const parts = sql.split(";");
  for (const part of parts) {
    const t = part.trim();
    if (t.length > 0) return t;
  }
  return "";
}

/**
 * Cell serializer. Postgres-side types are JS objects after node-pg
 * parses them; we collapse everything to a string for JSON transport
 * with NULL preserved as null.
 *
 * Why string-only: the UI renders a tabular view of arbitrary query
 * output; preserving JS numeric/Date/object types in the GraphQL
 * payload would require a Scalar union type and force the UI to
 * branch on every cell. Stringifying server-side gives a simple
 * `[[String]!]!` shape that's portable and JSON-safe.
 */
function serializeCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return `\\x${value.toString("hex")}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Pure helper: sandbox-execute a single read-only SQL statement
 * against the supplied `pg.Pool`. The security layer lives here in
 * one place; the resolver is a thin auth wrapper around this.
 *
 * Execution path:
 *   1. Take only the first statement (split on `;`)
 *   2. Reject empty input as QUERY_EMPTY
 *   3. Strip comments + check the leading keyword against the
 *      blocklist; reject as QUERY_BLOCKED on hit.
 *   4. Compute the effective LIMIT: min(user-or-default, MAX). If
 *      the statement has no trailing LIMIT, append one.
 *   5. Open a transaction with READ ONLY + 5s statement_timeout +
 *      2s lock_timeout, run the query, ROLLBACK.
 *   6. Serialize rows to strings and truncate to fit the 4 MB
 *      payload cap.
 *
 * Errors:
 *   - QUERY_EMPTY: empty after first-statement extraction.
 *   - QUERY_BLOCKED: leading keyword is on the blocklist.
 *   - QUERY_TIMEOUT: Postgres `57014` (`query_canceled`).
 *   - QUERY_ERROR: any other Postgres error; original message
 *     attached on `.cause` for the resolver to log.
 *
 * Connection-string leakage: errors thrown by `pg` may include the
 * pool's host/user; we never include them in the user-visible
 * message so a misconfigured factory can't accidentally leak the
 * tenant pg-pooler URL.
 */
export async function executeReadOnlyQuery(
  pool: Pool,
  sql: string,
  limit: number,
): Promise<DatabaseQueryResult> {
  const first = firstStatement(sql);
  if (!first) {
    throw new Error("QUERY_EMPTY");
  }
  const cleaned = stripComments(first).trim();
  if (!cleaned) {
    throw new Error("QUERY_EMPTY");
  }
  // Leading keyword: word characters at the very start of the
  // cleaned SQL. Matches case-insensitively against the blocklist.
  const headMatch = cleaned.match(/^[A-Za-z][A-Za-z_]*/);
  const head = headMatch ? headMatch[0].toUpperCase() : "";
  if (BLOCKED_KEYWORDS.has(head)) {
    throw new Error("QUERY_BLOCKED");
  }

  // Resolve effective limit. Clamp into [1, MAX]. The caller has
  // already mapped a missing GraphQL `limit` to DEFAULT_LIMIT, but
  // be defensive — a 0 or negative value would otherwise drop all
  // rows server-side.
  let effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, limit));
  const userLimit = detectTrailingLimit(first);
  if (userLimit !== null) {
    effectiveLimit = Math.min(effectiveLimit, userLimit);
  }

  // Strip trailing semicolons from the executed statement (we
  // already chose the first one) so an `outer ... LIMIT n` append
  // is syntactically valid.
  const baseStatement = first.replace(/[;\s]+$/g, "");
  const finalStatement =
    userLimit === null
      ? `${baseStatement} LIMIT ${effectiveLimit}`
      : // Already had a LIMIT; the user's number may exceed
        // MAX_LIMIT, but Postgres respects the smaller of two
        // composed limits, so wrap rather than rewrite to avoid
        // mangling complex queries.
        userLimit > effectiveLimit
        ? `SELECT * FROM (${baseStatement}) AS _vetra_explorer_wrap LIMIT ${effectiveLimit}`
        : baseStatement;

  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");

    let result: { rows: Record<string, unknown>[]; fields?: { name: string }[] };
    const startedAt = Date.now();
    try {
      result = (await client.query(finalStatement)) as {
        rows: Record<string, unknown>[];
        fields?: { name: string }[];
      };
    } catch (err) {
      // Always roll back, even on failure — the doc says "ROLLBACK is
      // unconditional, preventing any side-effects". Postgres would
      // auto-abort the transaction on error, but issuing it
      // explicitly keeps the connection state predictable for
      // pool reuse.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow — connection may already be in failed state */
      }
      const e = err as { code?: string; message?: string };
      if (e?.code === "57014") {
        throw new Error("QUERY_TIMEOUT");
      }
      // Generic PG error. We carry the message but not the
      // connection string. node-pg's error messages are typically
      // short and don't include connection info, but we route
      // through a `String(msg)` boundary for safety.
      const msg = typeof e?.message === "string" ? e.message : "query failed";
      const wrapped = new Error(`QUERY_ERROR: ${msg}`);
      (wrapped as { cause?: unknown }).cause = err;
      throw wrapped;
    }
    const executionMs = Date.now() - startedAt;
    await client.query("ROLLBACK");

    const columns: string[] = (result.fields ?? []).map((f) => f.name);
    // Walk rows in field order so the cells line up with
    // `columns` even when node-pg returns them as keyed objects.
    let serialized: (string | null)[][] = result.rows.map((row) => {
      return columns.map((col) => serializeCell(row[col]));
    });

    // Enforce the 4 MB payload cap. Stringify, measure, and trim
    // from the tail until we're under the budget. We do this in a
    // simple linear loop — the inputs are bounded by MAX_LIMIT so
    // the worst case is 10 000 iterations of JSON.stringify on a
    // shrinking array.
    let truncatedAt: number | null = null;
    if (serialized.length > 0) {
      let bytes = Buffer.byteLength(JSON.stringify(serialized), "utf8");
      if (bytes > MAX_PAYLOAD_BYTES) {
        // Binary-search-ish: halve until we fit, then nudge up.
        let lo = 0;
        let hi = serialized.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const slice = serialized.slice(0, mid);
          bytes = Buffer.byteLength(JSON.stringify(slice), "utf8");
          if (bytes <= MAX_PAYLOAD_BYTES) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        truncatedAt = lo;
        serialized = serialized.slice(0, lo);
      }
    }

    return {
      columns,
      rows: serialized,
      rowCount: serialized.length,
      truncatedAt,
      executionMs,
    };
  } finally {
    client.release();
  }
}
