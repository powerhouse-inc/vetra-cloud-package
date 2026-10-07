import { describe, it, expect, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up, down } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";

const row = (environment_id: string, template_hash: string) => ({
  app_id: "app-1",
  user_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  environment_id,
  license_id: "lic-1",
  template_hash,
  created_at: "2026-10-06T00:00:00.000Z",
  updated_at: "2026-10-06T00:00:00.000Z",
});

describe("vetra-licensing migrations (real PGlite)", () => {
  let db: Kysely<VetraLicensingDB> | undefined;
  const open = async () => {
    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    await up(db as Kysely<any>);
    return db;
  };
  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  // The composite primary key IS the claim lock: claimRow in resolvers.ts
  // issues ON CONFLICT (app_id, user_address) DO NOTHING, which Postgres
  // rejects outright when no matching unique constraint exists, and which
  // would silently keep both rows if the key were weaker.
  it("makes (app_id, user_address) a claim lock that keeps the first writer", async () => {
    const d = await open();
    await d.insertInto("app_user_environments").values(row("env-first", "unapplied")).execute();

    await d
      .insertInto("app_user_environments")
      .values(row("env-second", "other"))
      .onConflict((oc) => oc.columns(["app_id", "user_address"]).doNothing())
      .execute();

    const rows = await d.selectFrom("app_user_environments").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].environment_id).toBe("env-first");
    expect(rows[0].template_hash).toBe("unapplied");
  });

  it("rejects a plain duplicate insert for the same (app_id, user_address)", async () => {
    const d = await open();
    await d.insertInto("app_user_environments").values(row("env-1", "a")).execute();
    await expect(
      d.insertInto("app_user_environments").values(row("env-2", "b")).execute(),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("keeps a different user of the same app as a separate row", async () => {
    const d = await open();
    await d.insertInto("app_user_environments").values(row("env-1", "a")).execute();
    await d
      .insertInto("app_user_environments")
      .values({ ...row("env-2", "a"), user_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
      .execute();
    expect(await d.selectFrom("app_user_environments").selectAll().execute()).toHaveLength(2);
  });

  it("allows app_environment_limits to be keyed by app_id only", async () => {
    const d = await open();
    await d.insertInto("app_environment_limits").values({ app_id: "app-1", max_environments: 3 }).execute();
    await expect(
      d.insertInto("app_environment_limits").values({ app_id: "app-1", max_environments: 4 }).execute(),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("is clean to run up() again, and down() then up()", async () => {
    const d = await open();
    await expect(up(d as Kysely<any>)).resolves.toBeUndefined();
    await d.insertInto("app_user_environments").values(row("env-1", "a")).execute();
    await expect(down(d as Kysely<any>)).resolves.toBeUndefined();
    await expect(up(d as Kysely<any>)).resolves.toBeUndefined();
    // Tables are back, empty, and the key still holds.
    expect(await d.selectFrom("app_user_environments").selectAll().execute()).toHaveLength(0);
    await d.insertInto("app_user_environments").values(row("env-1", "a")).execute();
    await d
      .insertInto("app_user_environments")
      .values(row("env-2", "b"))
      .onConflict((oc) => oc.columns(["app_id", "user_address"]).doNothing())
      .execute();
    expect(await d.selectFrom("app_user_environments").selectAll().execute()).toHaveLength(1);
  });
});
