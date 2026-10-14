import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { DB } from "./schema.js";
import { removeEnvironmentRecord, tenantIdOwner } from "./cleanup.js";

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

async function seedEnv(
  id: string,
  subdomain: string | null,
  name: string | null,
  tenantId: string | null = null,
): Promise<void> {
  await db
    .insertInto("environments")
    .values({
      id,
      name,
      subdomain,
      tenantId,
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

describe("removeEnvironmentRecord: the tenant's env vars and secrets go with the last environment", () => {
  it("purges the tenant (stored tenantId) when no other environment is deployed as it", async () => {
    await seedEnv("env-1", "studio-a", "A", "studio-a-env1");
    const purgeTenant = vi.fn(async () => undefined);
    await removeEnvironmentRecord(db, "env-1", { purgeTenant });
    expect(purgeTenant).toHaveBeenCalledExactlyOnceWith("studio-a-env1");
  });

  it("derives the tenantId from subdomain + document id for legacy rows", async () => {
    await seedEnv("abcd1234-ffff", "legacy", "L", null);
    const purgeTenant = vi.fn(async () => undefined);
    await removeEnvironmentRecord(db, "abcd1234-ffff", { purgeTenant });
    expect(purgeTenant).toHaveBeenCalledExactlyOnceWith("legacy-abcd1234");
  });

  it("keeps the tenant while another environment is still deployed as it", async () => {
    await seedEnv("env-1", "s", "A", "shared-t");
    await seedEnv("env-2", "s", "B", "shared-t");
    const purgeTenant = vi.fn(async () => undefined);
    await removeEnvironmentRecord(db, "env-1", { purgeTenant });
    expect(purgeTenant).not.toHaveBeenCalled();
  });

  it("purges nothing for an unknown id, or a row with no tenant", async () => {
    await seedEnv("env-null", null, null, null);
    const purgeTenant = vi.fn(async () => undefined);
    expect(await removeEnvironmentRecord(db, "missing", { purgeTenant })).toBeNull();
    await removeEnvironmentRecord(db, "env-null", { purgeTenant });
    expect(purgeTenant).not.toHaveBeenCalled();
  });

  it("still removes the row when the purge fails (the orphan sweep retries it)", async () => {
    await seedEnv("env-1", "studio-a", "A", "t-1");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await removeEnvironmentRecord(db, "env-1", {
        purgeTenant: async () => {
          throw new Error("secrets db down");
        },
      });
      expect(out).toEqual({ subdomain: "studio-a", name: "A" });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(await countRows()).toBe(0);
  });
});

describe("tenantIdOwner", () => {
  it("names another environment already deployed as the tenant, never the document itself", async () => {
    await seedEnv("victim", "s", "V", "s-12345678");
    expect(await tenantIdOwner(db, "s-12345678", "attacker")).toBe("victim");
    expect(await tenantIdOwner(db, "s-12345678", "victim")).toBeNull();
    expect(await tenantIdOwner(db, "s-other", "attacker")).toBeNull();
  });
});
