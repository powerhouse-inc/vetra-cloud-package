import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "./migrations.js";
import { appLinkColumns } from "./processor.js";
import type { DB } from "./schema.js";

describe("environments read model — App link columns", () => {
  it("adds appId / appRole / prNumber (idempotently)", async () => {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await up(db as Kysely<any>); // second run must not throw
    await db
      .insertInto("environments")
      .values({
        id: "e1",
        appId: "app-1",
        appRole: "PREVIEW",
        prNumber: 42,
      } as never)
      .execute();
    const row = await db
      .selectFrom("environments")
      .select(["appId", "appRole", "prNumber"])
      .where("id", "=", "e1")
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ appId: "app-1", appRole: "PREVIEW", prNumber: 42 });
    await db.destroy();
  });

  it("maps state.app to the row columns", () => {
    expect(
      appLinkColumns({
        app: {
          appId: "app-1",
          role: "PREVIEW",
          prNumber: 7,
          gitRef: "refs/pull/7/merge",
          imageProject: "app-x",
        },
      }),
    ).toStrictEqual({ appId: "app-1", appRole: "PREVIEW", prNumber: 7 });
  });

  it("maps a missing or null link to NULLs (standalone env)", () => {
    const nulls = { appId: null, appRole: null, prNumber: null };
    expect(appLinkColumns({ app: null })).toStrictEqual(nulls);
    expect(appLinkColumns({})).toStrictEqual(nulls);
  });
});
