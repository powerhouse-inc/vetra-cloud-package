import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up, down } from "../db/migrations.js";
import type { SecretsDB } from "../db/schema.js";

let db: Kysely<SecretsDB>;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<SecretsDB>({
    dialect: new PGliteDialect(pglite),
  });
  await up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("db migrations", () => {
  it("creates both tables", async () => {
    const envRows = await db
      .selectFrom("tenant_env_vars")
      .selectAll()
      .execute();
    const secretRows = await db
      .selectFrom("tenant_secrets")
      .selectAll()
      .execute();

    expect(envRows).toEqual([]);
    expect(secretRows).toEqual([]);
  });

  it("inserts and selects tenant_env_vars", async () => {
    await db
      .insertInto("tenant_env_vars")
      .values({
        tenantId: "tenant-1",
        key: "NODE_ENV",
        value: "production",
        updatedAt: "2026-04-07T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("tenant_env_vars")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("NODE_ENV");
    expect(rows[0].value).toBe("production");
  });

  it("inserts and selects tenant_secrets", async () => {
    await db
      .insertInto("tenant_secrets")
      .values({
        tenantId: "tenant-1",
        key: "STRIPE_KEY",
        updatedAt: "2026-04-07T00:00:00Z",
      })
      .execute();

    const rows = await db
      .selectFrom("tenant_secrets")
      .selectAll()
      .where("tenantId", "=", "tenant-1")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("STRIPE_KEY");
  });

  it("enforces composite primary key on tenant_env_vars", async () => {
    await db
      .insertInto("tenant_env_vars")
      .values({
        tenantId: "tenant-1",
        key: "MY_VAR",
        value: "v1",
        updatedAt: "2026-04-07T00:00:00Z",
      })
      .execute();

    await expect(
      db
        .insertInto("tenant_env_vars")
        .values({
          tenantId: "tenant-1",
          key: "MY_VAR",
          value: "v2",
          updatedAt: "2026-04-07T00:00:00Z",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("up is idempotent", async () => {
    await expect(up(db)).resolves.not.toThrow();
  });

  it("down drops all tables", async () => {
    await down(db);

    await expect(
      db.selectFrom("tenant_env_vars").selectAll().execute(),
    ).rejects.toThrow();
  });
});
