import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { DB } from "./schema.js";
import { removeEnvironmentRecord } from "./cleanup.js";

let db: Kysely<DB>;

/**
 * Mirror of the processor's `environments` table, kept minimal to the columns
 * exercised here (same PGlite approach as the observability resolver tests).
 */
async function createEnvTable(database: Kysely<DB>): Promise<void> {
  await database.schema
    .createTable("environments")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)")
    .addColumn("subdomain", "varchar(255)")
    .addColumn("tenantId", "varchar(255)")
    .addColumn("customDomain", "varchar(255)")
    .addColumn("packages", "text")
    .addColumn("services", "text")
    .addColumn("status", "varchar(64)")
    .addColumn("owner", "varchar(255)")
    .addColumn("claimedBy", "varchar(255)")
    .addColumn("poolState", "varchar(64)")
    .ifNotExists()
    .execute();
}

async function seedEnv(id: string, subdomain: string | null, name: string | null): Promise<void> {
  await db
    .insertInto("environments")
    .values({
      id,
      name,
      subdomain,
      tenantId: null,
      customDomain: null,
      packages: null,
      services: null,
      status: "RUNNING",
      owner: null,
      claimedBy: null,
      poolState: null,
    } as never)
    .execute();
}

async function countRows(): Promise<number> {
  const rows = await db.selectFrom("environments").select("id").execute();
  return rows.length;
}

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<DB>({ dialect: new PGliteDialect(pglite) });
  await createEnvTable(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("removeEnvironmentRecord", () => {
  it("deletes the matching row and returns its {subdomain, name}", async () => {
    await seedEnv("env-1", "studio-a", "Studio A");

    const result = await removeEnvironmentRecord(db, "env-1");

    expect(result).toEqual({ subdomain: "studio-a", name: "Studio A" });
    expect(await countRows()).toBe(0);
  });

  it("returns null when no row exists for the id (no throw)", async () => {
    const result = await removeEnvironmentRecord(db, "missing");
    expect(result).toBeNull();
  });

  it("only deletes the targeted row, leaving others intact", async () => {
    await seedEnv("env-1", "studio-a", "Studio A");
    await seedEnv("env-2", "studio-b", "Studio B");
    await seedEnv("env-3", "studio-c", "Studio C");

    const result = await removeEnvironmentRecord(db, "env-2");

    expect(result).toEqual({ subdomain: "studio-b", name: "Studio B" });

    const remaining = await db
      .selectFrom("environments")
      .select("id")
      .orderBy("id")
      .execute();
    expect(remaining.map((r) => r.id)).toEqual(["env-1", "env-3"]);
  });

  it("returns subdomain/name as null when the row stored nulls", async () => {
    await seedEnv("env-null", null, null);

    const result = await removeEnvironmentRecord(db, "env-null");

    expect(result).toEqual({ subdomain: null, name: null });
    expect(await countRows()).toBe(0);
  });
});
