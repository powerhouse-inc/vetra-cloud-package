import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  ensureAppsOrgColumn,
  ensureAppsStudioColumn,
  isConcurrentIndexError,
} from "../db/migrations.js";

describe("ensureAppsOrgColumn (m4)", () => {
  it("adds owner_org_id to an apps table that lacks it; idempotent; no table is fine", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await ensureAppsOrgColumn(db);
      await sql`CREATE TABLE apps (id varchar(64) PRIMARY KEY)`.execute(db);
      await ensureAppsOrgColumn(db);
      await ensureAppsOrgColumn(db);
      await db
        .insertInto("apps")
        .values({ id: "a", owner_org_id: "o1" })
        .execute();
      expect(
        await db.selectFrom("apps").select(["id", "owner_org_id"]).execute(),
      ).toStrictEqual([{ id: "a", owner_org_id: "o1" }]);
    } finally {
      await db.destroy();
    }
  });
});

describe("ensureAppsStudioColumn", () => {
  it("works in the subgraph's namespace schema, not only in public", async () => {
    // The switchboard hands the subgraph db.withSchema("vetra-apps"): a raw
    // `ON apps` would resolve against public and crash the boot.
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      await sql`CREATE TABLE "vetra-apps".apps (id varchar(64) PRIMARY KEY, status varchar(32) NOT NULL)`.execute(
        root,
      );
      const db = root.withSchema("vetra-apps");
      await ensureAppsStudioColumn(db);
      await ensureAppsStudioColumn(db);
      await db
        .insertInto("apps")
        .values({ id: "a", status: "ACTIVE", studio_environment_id: "s1" })
        .execute();
      await expect(
        db
          .insertInto("apps")
          .values({ id: "b", status: "ACTIVE", studio_environment_id: "s1" })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await root.destroy();
    }
  });

  it("adds studio_environment_id with one live App per Studio; idempotent", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE TABLE apps (id varchar(64) PRIMARY KEY, status varchar(32) NOT NULL)`.execute(
        db,
      );
      await ensureAppsStudioColumn(db);
      await ensureAppsStudioColumn(db);
      const row = (id: string, status: string, studio: string | null) => ({
        id,
        status,
        studio_environment_id: studio,
      });
      await db
        .insertInto("apps")
        .values([
          row("a", "DELETED", "s1"),
          row("b", "ACTIVE", "s1"),
          row("c", "ACTIVE", null),
          row("d", "ACTIVE", null),
        ])
        .execute();
      await expect(
        db
          .insertInto("apps")
          .values(row("e", "PENDING_IDENTITY", "s1"))
          .execute(),
      ).rejects.toThrow();
    } finally {
      await db.destroy();
    }
  });
});

describe("isConcurrentIndexError", () => {
  it("accepts duplicate-relation and unique-violation, rejects the rest", () => {
    expect(isConcurrentIndexError({ code: "42P07" })).toBe(true);
    expect(isConcurrentIndexError({ code: "23505" })).toBe(true);
    expect(isConcurrentIndexError({ code: "42601" })).toBe(false);
    expect(isConcurrentIndexError(new Error("boom"))).toBe(false);
    expect(isConcurrentIndexError(null)).toBe(false);
  });
});
