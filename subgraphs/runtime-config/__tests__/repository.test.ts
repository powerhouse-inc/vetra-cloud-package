import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { RuntimeConfigDB } from "../db/schema.js";
import { createRepository } from "../repository.js";

let db: Kysely<RuntimeConfigDB>;
let repo: ReturnType<typeof createRepository>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<RuntimeConfigDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);
  repo = createRepository(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("runtimeConfigForTenant", () => {
  it("returns null for unknown tenant", async () => {
    expect(await repo.runtimeConfigForTenant("unknown")).toBeNull();
  });

  it("returns the row when set", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values({
        tenantId: "t1",
        value: JSON.stringify({ branding: { appName: "Acme" } }),
        updatedAt: "2026-05-28T00:00:00Z",
      })
      .execute();
    const row = await repo.runtimeConfigForTenant("t1");
    expect(row).not.toBeNull();
    expect(row?.updatedAt).toBe("2026-05-28T00:00:00Z");
    expect(JSON.parse(row!.value)).toEqual({
      branding: { appName: "Acme" },
    });
  });

  it("isolates tenants", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values([
        {
          tenantId: "t1",
          value: JSON.stringify({ branding: { appName: "A" } }),
          updatedAt: "2026-05-28T00:00:00Z",
        },
        {
          tenantId: "t2",
          value: JSON.stringify({ branding: { appName: "B" } }),
          updatedAt: "2026-05-28T00:00:00Z",
        },
      ])
      .execute();

    const a = await repo.runtimeConfigForTenant("t1");
    const b = await repo.runtimeConfigForTenant("t2");
    expect(JSON.parse(a!.value).branding.appName).toBe("A");
    expect(JSON.parse(b!.value).branding.appName).toBe("B");
  });
});

describe("allTenantIds", () => {
  it("returns [] when empty", async () => {
    expect(await repo.allTenantIds()).toEqual([]);
  });

  it("returns all distinct tenant ids sorted", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values([
        { tenantId: "b", value: "{}", updatedAt: "2026-05-28T00:00:00Z" },
        { tenantId: "a", value: "{}", updatedAt: "2026-05-28T00:00:00Z" },
        { tenantId: "c", value: "{}", updatedAt: "2026-05-28T00:00:00Z" },
      ])
      .execute();
    expect(await repo.allTenantIds()).toEqual(["a", "b", "c"]);
  });
});
