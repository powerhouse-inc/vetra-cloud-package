import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ensureEnvironmentHoldsTable, up } from "../db/migrations.js";
import { deleteHold, getHold, insertHold } from "../holds/repo.js";
import type { VetraAppsDB } from "../db/schema.js";

async function holdsDb(): Promise<{ db: Kysely<VetraAppsDB>; root: Kysely<any> }> {
  const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
  const any = root.withSchema("vetra-apps");
  await up(any);
  return { db: any as unknown as Kysely<VetraAppsDB>, root };
}

const row = (over: Partial<{ reason: string; created_by: string }> = {}) => ({
  environment_id: "env-1",
  reason: over.reason ?? "licence ended",
  switchover_id: null,
  created_by: over.created_by ?? "vetra",
  created_at: "2026-11-12T00:00:00.000Z",
});

describe("environment holds repo", () => {
  it("keeps the first hold when an environment is held twice", async () => {
    const { db, root } = await holdsDb();
    try {
      const first = await insertHold(db, row());
      expect(first).toMatchObject({ environment_id: "env-1", reason: "licence ended" });
      const second = await insertHold(db, row({ reason: "switch-over", created_by: "0xaa" }));
      expect(second).toStrictEqual(first);
      expect(await getHold(db, "env-1")).toStrictEqual(first);
      expect(await getHold(db, "env-2")).toBeNull();
    } finally {
      await root.destroy();
    }
  });

  it("deletes a hold once", async () => {
    const { db, root } = await holdsDb();
    try {
      await insertHold(db, row());
      expect(await deleteHold(db, "env-1")).toBe(true);
      expect(await deleteHold(db, "env-1")).toBe(false);
      expect(await getHold(db, "env-1")).toBeNull();
    } finally {
      await root.destroy();
    }
  });

  it("creates the table idempotently and concurrently in the namespace schema", async () => {
    const { db, root } = await holdsDb();
    try {
      const any = db as unknown as Kysely<any>;
      await up(any);
      await Promise.all([1, 2, 3].map(() => ensureEnvironmentHoldsTable(any)));
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'vetra-apps' AND table_name = 'environment_holds'`.execute(root);
      expect(rows[0].n).toBe(1);
    } finally {
      await root.destroy();
    }
  });
});
