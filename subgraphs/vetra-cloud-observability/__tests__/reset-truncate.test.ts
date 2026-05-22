import { describe, expect, it, vi } from "vitest";
import { truncateUserTables } from "../reset/service.js";

type QueryCall = { sql: string };

/**
 * Pool stub that records every query and returns canned results for
 * the information_schema lookup. The helper only needs `connect()` →
 * `query()` / `release()` so we don't bother with the rest of the
 * pg.Pool surface.
 */
function poolStub(
  tables: Array<{ table_schema: string; table_name: string }>,
  opts: { failOn?: RegExp } = {},
) {
  const calls: QueryCall[] = [];
  return {
    calls,
    pool: {
      connect: async () => ({
        query: async (sql: string) => {
          calls.push({ sql });
          if (opts.failOn && opts.failOn.test(sql)) {
            throw new Error("boom");
          }
          if (/FROM information_schema\.tables/i.test(sql)) {
            return { rows: tables };
          }
          return { rows: [] };
        },
        release: vi.fn(),
      }),
    } as never,
  };
}

describe("truncateUserTables", () => {
  it("returns 0 and runs no TRUNCATE when there are no user tables", async () => {
    const { pool, calls } = poolStub([]);
    const n = await truncateUserTables(pool);
    expect(n).toBe(0);
    // Only the information_schema lookup runs — no BEGIN/TRUNCATE/COMMIT.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/information_schema\.tables/i);
  });

  it("issues a single TRUNCATE wrapped in BEGIN/COMMIT for all tables", async () => {
    const { pool, calls } = poolStub([
      { table_schema: "public", table_name: "users" },
      { table_schema: "public", table_name: "posts" },
      { table_schema: "audit", table_name: "events" },
    ]);

    const n = await truncateUserTables(pool);

    expect(n).toBe(3);
    const sqls = calls.map((c) => c.sql);
    // information_schema lookup, BEGIN, TRUNCATE, COMMIT — in that order.
    expect(sqls[0]).toMatch(/information_schema\.tables/i);
    expect(sqls[1]).toBe("BEGIN");
    expect(sqls[2]).toMatch(/^TRUNCATE TABLE /);
    expect(sqls[2]).toContain(`"public"."users"`);
    expect(sqls[2]).toContain(`"public"."posts"`);
    expect(sqls[2]).toContain(`"audit"."events"`);
    expect(sqls[2]).toMatch(/RESTART IDENTITY CASCADE$/);
    expect(sqls[3]).toBe("COMMIT");
  });

  it("escapes embedded double quotes in schema and table names", async () => {
    const { pool, calls } = poolStub([
      { table_schema: 'weird"schema', table_name: 'odd"name' },
    ]);
    const n = await truncateUserTables(pool);
    expect(n).toBe(1);
    const truncate = calls.find((c) => /^TRUNCATE TABLE /.test(c.sql))!;
    // Escaped via doubled quotes — Postgres' standard identifier escape.
    expect(truncate.sql).toContain(`"weird""schema"."odd""name"`);
  });

  it("rolls back and rethrows when the TRUNCATE fails", async () => {
    const { pool, calls } = poolStub(
      [{ table_schema: "public", table_name: "users" }],
      { failOn: /^TRUNCATE TABLE/ },
    );
    await expect(truncateUserTables(pool)).rejects.toThrow("boom");
    const sqls = calls.map((c) => c.sql);
    // BEGIN ran, TRUNCATE failed, ROLLBACK ran. No COMMIT.
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
  });
});
