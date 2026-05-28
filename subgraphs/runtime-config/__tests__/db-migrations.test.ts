import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up, down } from "../db/migrations.js";
import type { RuntimeConfigDB } from "../db/schema.js";

let db: Kysely<RuntimeConfigDB>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<RuntimeConfigDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("db migrations", () => {
  it("creates tenant_runtime_config table", async () => {
    const rows = await db
      .selectFrom("tenant_runtime_config")
      .selectAll()
      .execute();
    expect(rows).toEqual([]);
  });

  it("inserts and selects tenant_runtime_config", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values({
        tenantId: "tenant-1",
        value: JSON.stringify({ branding: { appName: "Acme" } }),
        updatedAt: "2026-05-28T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("tenant_runtime_config")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value)).toEqual({
      branding: { appName: "Acme" },
    });
  });

  it("enforces tenantId as primary key (one row per tenant)", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values({
        tenantId: "tenant-1",
        value: "{}",
        updatedAt: "2026-05-28T00:00:00Z",
      })
      .execute();

    await expect(
      db
        .insertInto("tenant_runtime_config")
        .values({
          tenantId: "tenant-1",
          value: "{}",
          updatedAt: "2026-05-28T00:00:00Z",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("allows distinct tenant rows", async () => {
    await db
      .insertInto("tenant_runtime_config")
      .values([
        {
          tenantId: "t1",
          value: "{}",
          updatedAt: "2026-05-28T00:00:00Z",
        },
        {
          tenantId: "t2",
          value: "{}",
          updatedAt: "2026-05-28T00:00:00Z",
        },
      ])
      .execute();

    const rows = await db
      .selectFrom("tenant_runtime_config")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(2);
  });

  it("up is idempotent", async () => {
    await expect(up(db)).resolves.not.toThrow();
  });

  it("down drops the table", async () => {
    await down(db);

    await expect(
      db.selectFrom("tenant_runtime_config").selectAll().execute(),
    ).rejects.toThrow();
  });
});
