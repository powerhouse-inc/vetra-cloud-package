import { describe, expect, it, vi } from "vitest";
import { describeDatabase } from "../explorer/describe.js";

/**
 * Build a stub `pg.Pool` whose `connect()` returns a client matching
 * the subset of the API used by `describeDatabase`. Each query string
 * is matched by substring against the supplied handler map; matching
 * is order-independent so the test reads naturally.
 */
type QueryFn = () => Promise<{ rows: unknown[] }>;
function poolStub(handlers: { match: RegExp; handler: QueryFn }[]) {
  const setStatementTimeout = vi.fn(async () => ({ rows: [] }));
  const release = vi.fn();
  const captured: string[] = [];
  const queryImpl = (text: string) => {
    captured.push(text);
    const normalized = text.trim().toUpperCase();
    if (
      normalized.startsWith("BEGIN") ||
      normalized === "COMMIT" ||
      normalized === "ROLLBACK"
    ) {
      return Promise.resolve({ rows: [] });
    }
    if (/SET LOCAL statement_timeout/i.test(text)) {
      return setStatementTimeout();
    }
    for (const { match, handler } of handlers) {
      if (match.test(text)) return handler();
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  const client = {
    query: queryImpl,
    release,
  };
  return {
    pool: { connect: async () => client } as never,
    setStatementTimeout,
    release,
    captured,
  };
}

describe("describeDatabase", () => {
  it("returns schemas with tables, columns, indexes shaped correctly", async () => {
    const { pool } = poolStub([
      {
        match: /FROM information_schema\.tables/i,
        handler: async () => ({
          rows: [
            { table_schema: "public", table_name: "users" },
            { table_schema: "public", table_name: "orders" },
            { table_schema: "audit", table_name: "events" },
          ],
        }),
      },
      {
        match: /FROM information_schema\.columns/i,
        handler: async () => ({
          rows: [
            {
              table_schema: "public",
              table_name: "users",
              column_name: "id",
              data_type: "uuid",
              is_nullable: "NO",
              column_default: null,
            },
            {
              table_schema: "public",
              table_name: "users",
              column_name: "email",
              data_type: "text",
              is_nullable: "YES",
              column_default: null,
            },
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "id",
              data_type: "bigint",
              is_nullable: "NO",
              column_default: "nextval('orders_id_seq')",
            },
            {
              table_schema: "audit",
              table_name: "events",
              column_name: "at",
              data_type: "timestamptz",
              is_nullable: "NO",
              column_default: "now()",
            },
          ],
        }),
      },
      {
        match: /FROM pg_constraint/i,
        handler: async () => ({
          rows: [
            {
              table_schema: "public",
              table_name: "users",
              column_name: "id",
            },
            {
              table_schema: "public",
              table_name: "orders",
              column_name: "id",
            },
          ],
        }),
      },
      {
        match: /FROM pg_indexes/i,
        handler: async () => ({
          rows: [
            {
              schemaname: "public",
              tablename: "users",
              indexname: "users_pkey",
              indexdef:
                "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
            },
            {
              schemaname: "public",
              tablename: "users",
              indexname: "users_email_idx",
              indexdef:
                "CREATE INDEX users_email_idx ON public.users USING btree (email)",
            },
          ],
        }),
      },
    ]);

    const result = await describeDatabase(pool);

    expect(result.schemas.map((s) => s.name)).toEqual(["audit", "public"]);
    const pub = result.schemas.find((s) => s.name === "public")!;
    expect(pub.truncated).toBeUndefined();
    expect(pub.tables.map((t) => t.name)).toEqual(["orders", "users"]);

    const users = pub.tables.find((t) => t.name === "users")!;
    expect(users.columns).toEqual([
      {
        name: "id",
        type: "uuid",
        nullable: false,
        default: null,
        isPrimaryKey: true,
      },
      {
        name: "email",
        type: "text",
        nullable: true,
        default: null,
        isPrimaryKey: false,
      },
    ]);
    expect(users.indexes).toEqual([
      { name: "users_pkey", columns: ["id"], unique: true },
      { name: "users_email_idx", columns: ["email"], unique: false },
    ]);

    const orders = pub.tables.find((t) => t.name === "orders")!;
    expect(orders.columns[0].default).toBe("nextval('orders_id_seq')");
    expect(orders.columns[0].isPrimaryKey).toBe(true);

    const audit = result.schemas.find((s) => s.name === "audit")!;
    expect(audit.tables[0].columns[0]).toEqual({
      name: "at",
      type: "timestamptz",
      nullable: false,
      default: "now()",
      isPrimaryKey: false,
    });
  });

  it("truncates schemas with more than 500 tables and flags truncated=true", async () => {
    // Build 501 tables, deliberately unsorted in source order so we can
    // verify the helper sorts alphabetically before slicing.
    const tables: { table_schema: string; table_name: string }[] = [];
    for (let i = 0; i < 501; i++) {
      // Pad so lexicographic order matches numeric.
      tables.push({
        table_schema: "public",
        table_name: `t${String(i).padStart(4, "0")}`,
      });
    }
    tables.reverse();

    const { pool } = poolStub([
      {
        match: /FROM information_schema\.tables/i,
        handler: async () => ({ rows: tables }),
      },
      {
        match: /FROM information_schema\.columns/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM pg_constraint/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM pg_indexes/i,
        handler: async () => ({ rows: [] }),
      },
    ]);

    const result = await describeDatabase(pool);
    expect(result.schemas).toHaveLength(1);
    const pub = result.schemas[0];
    expect(pub.truncated).toBe(true);
    expect(pub.tables).toHaveLength(500);
    // First and last surviving tables = lex-smallest 500.
    expect(pub.tables[0].name).toBe("t0000");
    expect(pub.tables[499].name).toBe("t0499");
  });

  it("returns an empty schemas array when there are no user tables", async () => {
    const { pool } = poolStub([
      {
        match: /FROM information_schema\.tables/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM information_schema\.columns/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM pg_constraint/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM pg_indexes/i,
        handler: async () => ({ rows: [] }),
      },
    ]);

    const result = await describeDatabase(pool);
    expect(result.schemas).toEqual([]);
  });

  it("releases the client even when a query throws", async () => {
    const release = vi.fn();
    const client = {
      query: async (text: string) => {
        const normalized = text.trim().toUpperCase();
        if (
          normalized.startsWith("BEGIN") ||
          normalized === "COMMIT" ||
          normalized === "ROLLBACK"
        ) {
          return { rows: [] };
        }
        if (/SET LOCAL/i.test(text)) return { rows: [] };
        throw new Error("BOOM");
      },
      release,
    };
    const pool = { connect: async () => client } as never;
    await expect(describeDatabase(pool)).rejects.toThrow("BOOM");
    expect(release).toHaveBeenCalled();
  });

  it("wraps the introspection in BEGIN READ ONLY ... COMMIT around SET LOCAL", async () => {
    const { pool, captured } = poolStub([
      {
        match: /FROM information_schema\.tables/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM information_schema\.columns/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM pg_constraint/i,
        handler: async () => ({ rows: [] }),
      },
      {
        match: /FROM pg_indexes/i,
        handler: async () => ({ rows: [] }),
      },
    ]);

    await describeDatabase(pool);

    // Find each landmark in the order it was issued.
    const beginIdx = captured.findIndex((q) => /^\s*BEGIN(\s|$)/i.test(q));
    const setLocalIdx = captured.findIndex((q) =>
      /SET LOCAL statement_timeout/i.test(q),
    );
    const commitIdx = captured.findIndex((q) => /^\s*COMMIT\s*$/i.test(q));
    const rollbackIdx = captured.findIndex((q) => /^\s*ROLLBACK\s*$/i.test(q));
    const lastTxIdx = commitIdx >= 0 ? commitIdx : rollbackIdx;

    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(setLocalIdx).toBeGreaterThan(beginIdx);
    expect(lastTxIdx).toBeGreaterThan(setLocalIdx);
    // The first BEGIN matched explicitly: confirms it is a READ ONLY
    // transaction (not a default read-write one).
    expect(captured[beginIdx]).toMatch(/^BEGIN\s+READ\s+ONLY$/i);
  });

  it("issues ROLLBACK before releasing the client on error", async () => {
    const captured: string[] = [];
    const release = vi.fn();
    const client = {
      query: async (text: string) => {
        captured.push(text);
        const normalized = text.trim().toUpperCase();
        if (normalized.startsWith("BEGIN") || normalized === "ROLLBACK") {
          return { rows: [] };
        }
        if (/SET LOCAL/i.test(text)) return { rows: [] };
        throw new Error("BOOM");
      },
      release,
    };
    const pool = { connect: async () => client } as never;
    await expect(describeDatabase(pool)).rejects.toThrow("BOOM");

    const rollbackIdx = captured.findIndex((q) => /^\s*ROLLBACK\s*$/i.test(q));
    expect(rollbackIdx).toBeGreaterThanOrEqual(0);
    // release() runs in the outer `finally`, after ROLLBACK is issued.
    expect(release).toHaveBeenCalled();
    // No COMMIT on the error path.
    expect(captured.some((q) => /^\s*COMMIT\s*$/i.test(q))).toBe(false);
  });
});
