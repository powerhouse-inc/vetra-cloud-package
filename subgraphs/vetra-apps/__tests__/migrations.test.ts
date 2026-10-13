import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ensureAppsOrgColumn } from "../db/migrations.js";

describe("ensureAppsOrgColumn (m4)", () => {
  it("adds owner_org_id to an apps table that lacks it; idempotent; no table is fine", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await ensureAppsOrgColumn(db);
      await sql`CREATE TABLE apps (id varchar(64) PRIMARY KEY)`.execute(db);
      await ensureAppsOrgColumn(db);
      await ensureAppsOrgColumn(db);
      await db.insertInto("apps").values({ id: "a", owner_org_id: "o1" }).execute();
      expect(await db.selectFrom("apps").select(["id", "owner_org_id"]).execute()).toStrictEqual([
        { id: "a", owner_org_id: "o1" },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
