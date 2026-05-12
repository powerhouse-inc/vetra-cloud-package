import { describe, expect, it, vi } from "vitest";
import {
  executeReadOnlyQuery,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../explorer/execute.js";

/**
 * Build a stub `pg.Pool` whose `connect()` returns a client capturing
 * the executed statements and returning a configurable result.
 *
 * The `onMainQuery` callback fires for the *first* non-transactional
 * query (i.e. the actual user statement, after BEGIN/SET LOCAL). It
 * receives the executed SQL string and returns the rows + fields
 * result; it can also throw to simulate a Postgres error.
 */
type MainResult = {
  rows: Record<string, unknown>[];
  fields?: { name: string }[];
};
function poolStub(
  onMainQuery: (sql: string) => Promise<MainResult> | MainResult,
) {
  const captured: string[] = [];
  const release = vi.fn();
  const client = {
    query: async (sql: string) => {
      captured.push(sql);
      const normalized = sql.trim().toUpperCase();
      if (
        normalized.startsWith("BEGIN") ||
        normalized.startsWith("SET LOCAL") ||
        normalized.startsWith("ROLLBACK")
      ) {
        return { rows: [] };
      }
      return await onMainQuery(sql);
    },
    release,
  };
  return {
    pool: { connect: async () => client } as never,
    captured,
    release,
  };
}

describe("executeReadOnlyQuery — happy path", () => {
  it("returns rows + columns + executionMs for a SELECT", async () => {
    const { pool, captured } = poolStub(() => ({
      rows: [
        { n: 1, s: "hello" },
        { n: 2, s: "world" },
      ],
      fields: [{ name: "n" }, { name: "s" }],
    }));
    const result = await executeReadOnlyQuery(
      pool,
      "SELECT n, s FROM t",
      DEFAULT_LIMIT,
    );
    expect(result.columns).toEqual(["n", "s"]);
    expect(result.rows).toEqual([
      ["1", "hello"],
      ["2", "world"],
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.truncatedAt).toBeNull();
    expect(typeof result.executionMs).toBe("number");
    expect(result.executionMs).toBeGreaterThanOrEqual(0);

    // Confirms the wrapping discipline: BEGIN READ ONLY → SET LOCAL
    // statement_timeout / lock_timeout → statement → ROLLBACK.
    expect(captured[0]).toBe("BEGIN READ ONLY");
    expect(captured[1]).toMatch(/SET LOCAL statement_timeout/);
    expect(captured[2]).toMatch(/SET LOCAL lock_timeout/);
    expect(captured[3]).toMatch(/^SELECT n, s FROM t LIMIT 1000$/);
    expect(captured[4]).toBe("ROLLBACK");
  });

  it("preserves null as null and stringifies booleans/numbers/Date/jsonb", async () => {
    const now = new Date("2026-05-12T00:00:00Z");
    const { pool } = poolStub(() => ({
      rows: [
        {
          a: null,
          b: 42,
          c: true,
          d: now,
          e: { nested: "ok" },
          f: "literal",
        },
      ],
      fields: [
        { name: "a" },
        { name: "b" },
        { name: "c" },
        { name: "d" },
        { name: "e" },
        { name: "f" },
      ],
    }));
    const result = await executeReadOnlyQuery(pool, "SELECT *", DEFAULT_LIMIT);
    expect(result.rows[0]).toEqual([
      null,
      "42",
      "true",
      now.toISOString(),
      JSON.stringify({ nested: "ok" }),
      "literal",
    ]);
  });
});

describe("executeReadOnlyQuery — first statement only", () => {
  it("runs only the first statement when multiple are provided", async () => {
    const seen: string[] = [];
    const { pool } = poolStub((sql) => {
      seen.push(sql);
      return { rows: [{ n: 1 }], fields: [{ name: "n" }] };
    });
    await executeReadOnlyQuery(
      pool,
      "SELECT 1; SELECT 2; DROP TABLE users",
      DEFAULT_LIMIT,
    );
    expect(seen).toHaveLength(1);
    // Note: LIMIT got appended even though the second statement is a DROP —
    // because we never look at the trailing statements at all.
    expect(seen[0]).toMatch(/^SELECT 1 LIMIT 1000$/);
  });
});

describe("executeReadOnlyQuery — comment stripping", () => {
  it("strips line comments before keyword detection so SELECT after -- INSERT runs", async () => {
    const { pool } = poolStub(() => ({
      rows: [{ n: 1 }],
      fields: [{ name: "n" }],
    }));
    const sql = "-- INSERT INTO bad VALUES (1)\nSELECT 1";
    const result = await executeReadOnlyQuery(pool, sql, DEFAULT_LIMIT);
    expect(result.rows).toEqual([["1"]]);
  });

  it("strips block comments before keyword detection", async () => {
    const { pool } = poolStub(() => ({
      rows: [{ n: 1 }],
      fields: [{ name: "n" }],
    }));
    const sql = "/* DROP TABLE secrets */ SELECT 1";
    const result = await executeReadOnlyQuery(pool, sql, DEFAULT_LIMIT);
    expect(result.rows).toEqual([["1"]]);
  });

  it("still blocks a write keyword that follows the comment", async () => {
    const { pool, captured } = poolStub(() => ({ rows: [] }));
    await expect(
      executeReadOnlyQuery(pool, "-- SELECT 1\nDROP TABLE x", DEFAULT_LIMIT),
    ).rejects.toThrow("QUERY_BLOCKED");
    // Should never have hit the database (no BEGIN issued).
    expect(captured).toHaveLength(0);
  });
});

describe("executeReadOnlyQuery — blocked keywords", () => {
  const KEYWORDS = [
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
  ];

  for (const kw of KEYWORDS) {
    it(`rejects ${kw} with QUERY_BLOCKED`, async () => {
      const { pool, captured } = poolStub(() => ({ rows: [] }));
      await expect(
        executeReadOnlyQuery(pool, `${kw} something FROM x`, DEFAULT_LIMIT),
      ).rejects.toThrow("QUERY_BLOCKED");
      // Defence-in-depth: nothing reached the database.
      expect(captured).toHaveLength(0);
    });
  }

  it("the keyword check is case-insensitive", async () => {
    const { pool } = poolStub(() => ({ rows: [] }));
    await expect(
      executeReadOnlyQuery(pool, "delete from x", DEFAULT_LIMIT),
    ).rejects.toThrow("QUERY_BLOCKED");
    await expect(
      executeReadOnlyQuery(pool, "DeLeTe from x", DEFAULT_LIMIT),
    ).rejects.toThrow("QUERY_BLOCKED");
  });
});

describe("executeReadOnlyQuery — empty input", () => {
  it("throws QUERY_EMPTY on empty input", async () => {
    const { pool } = poolStub(() => ({ rows: [] }));
    await expect(executeReadOnlyQuery(pool, "", DEFAULT_LIMIT)).rejects.toThrow(
      "QUERY_EMPTY",
    );
  });

  it("throws QUERY_EMPTY on whitespace-only / semicolon-only input", async () => {
    const { pool } = poolStub(() => ({ rows: [] }));
    await expect(
      executeReadOnlyQuery(pool, "   ;  ;  ", DEFAULT_LIMIT),
    ).rejects.toThrow("QUERY_EMPTY");
  });

  it("throws QUERY_EMPTY when only a comment is supplied", async () => {
    const { pool } = poolStub(() => ({ rows: [] }));
    await expect(
      executeReadOnlyQuery(pool, "/* comment */", DEFAULT_LIMIT),
    ).rejects.toThrow("QUERY_EMPTY");
  });
});

describe("executeReadOnlyQuery — LIMIT injection", () => {
  it("appends LIMIT 1000 when the SQL has none", async () => {
    const { pool, captured } = poolStub(() => ({
      rows: [],
      fields: [],
    }));
    await executeReadOnlyQuery(pool, "SELECT * FROM users", DEFAULT_LIMIT);
    expect(captured.some((s) => /LIMIT 1000$/.test(s.trim()))).toBe(true);
  });

  it("caps a user-supplied LIMIT 50000 down to MAX_LIMIT (10000)", async () => {
    const { pool, captured } = poolStub(() => ({
      rows: [],
      fields: [],
    }));
    await executeReadOnlyQuery(
      pool,
      "SELECT * FROM users LIMIT 50000",
      MAX_LIMIT,
    );
    const main = captured.find((s) => /SELECT/i.test(s) && !/SET LOCAL/i.test(s));
    expect(main).toBeDefined();
    // The wrap form preserves the user's LIMIT inside the subquery
    // while imposing the cap outside.
    expect(main).toContain("LIMIT 10000");
  });

  it("leaves a user-supplied LIMIT within the cap alone", async () => {
    const { pool, captured } = poolStub(() => ({
      rows: [],
      fields: [],
    }));
    await executeReadOnlyQuery(pool, "SELECT * FROM users LIMIT 50", MAX_LIMIT);
    const main = captured.find((s) => /SELECT/i.test(s) && !/SET LOCAL/i.test(s));
    // No wrap added — kept verbatim because 50 <= cap.
    expect(main).toBe("SELECT * FROM users LIMIT 50");
  });

  it("forces a minimum effective limit of 1 even when caller passes 0", async () => {
    const { pool, captured } = poolStub(() => ({
      rows: [],
      fields: [],
    }));
    await executeReadOnlyQuery(pool, "SELECT 1", 0);
    expect(captured.some((s) => /LIMIT 1$/.test(s.trim()))).toBe(true);
  });
});

describe("executeReadOnlyQuery — payload truncation", () => {
  it("truncates rows when the JSON payload exceeds 4 MB", async () => {
    // Build a 5 000-row result where each row's single cell is a
    // ~1 KB string. 5 000 × 1 KB ≈ 5 MB — past the 4 MB cap.
    const bigString = "x".repeat(1024);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 5000; i++) {
      rows.push({ v: bigString });
    }
    const { pool } = poolStub(() => ({
      rows,
      fields: [{ name: "v" }],
    }));
    const result = await executeReadOnlyQuery(pool, "SELECT v", MAX_LIMIT);
    expect(result.truncatedAt).not.toBeNull();
    expect(result.rows.length).toBeLessThan(5000);
    expect(result.rowCount).toBe(result.rows.length);
    // Confirm the surviving slice fits the budget.
    const bytes = Buffer.byteLength(JSON.stringify(result.rows), "utf8");
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("does not truncate when the result fits the budget", async () => {
    const { pool } = poolStub(() => ({
      rows: [{ v: "small" }],
      fields: [{ name: "v" }],
    }));
    const result = await executeReadOnlyQuery(pool, "SELECT v", DEFAULT_LIMIT);
    expect(result.truncatedAt).toBeNull();
    expect(result.rowCount).toBe(1);
  });
});

describe("executeReadOnlyQuery — Postgres errors", () => {
  it("maps Postgres code 57014 to QUERY_TIMEOUT", async () => {
    const { pool, captured } = poolStub(() => {
      const e = new Error("canceling statement due to statement timeout");
      (e as { code?: string }).code = "57014";
      throw e;
    });
    await expect(
      executeReadOnlyQuery(pool, "SELECT pg_sleep(10)", DEFAULT_LIMIT),
    ).rejects.toThrow("QUERY_TIMEOUT");
    // ROLLBACK still issued even though the statement errored.
    expect(captured[captured.length - 1]).toBe("ROLLBACK");
  });

  it("wraps other Postgres errors as QUERY_ERROR with the original message", async () => {
    const { pool } = poolStub(() => {
      const e = new Error('relation "no_such_table" does not exist');
      (e as { code?: string }).code = "42P01";
      throw e;
    });
    await expect(
      executeReadOnlyQuery(pool, "SELECT * FROM no_such_table", DEFAULT_LIMIT),
    ).rejects.toThrow(/QUERY_ERROR.*does not exist/);
  });

  it("releases the client even when the statement errors", async () => {
    const release = vi.fn();
    const client = {
      query: async (sql: string) => {
        const u = sql.trim().toUpperCase();
        if (u.startsWith("BEGIN") || u.startsWith("SET LOCAL")) {
          return { rows: [] };
        }
        if (u === "ROLLBACK") return { rows: [] };
        throw new Error("nope");
      },
      release,
    };
    const pool = { connect: async () => client } as never;
    await expect(
      executeReadOnlyQuery(pool, "SELECT 1", DEFAULT_LIMIT),
    ).rejects.toThrow(/QUERY_ERROR/);
    expect(release).toHaveBeenCalled();
  });
});
