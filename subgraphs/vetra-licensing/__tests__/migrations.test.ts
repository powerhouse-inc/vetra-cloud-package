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

  it("adds kind and user_did to app_license_grants and keeps old rows", async () => {
    const d = await open();
    await d.insertInto("app_license_grants").values({
      license_id: "l1", app_id: "a", license_type_id: "t", user_address: "0x1",
      issued_by: "0x2", created_at: "2026-01-01T00:00:00.000Z", kind: null, user_did: null,
    }).execute();
    await up(d as Kysely<any>); // second run: duplicate-column swallowed
    const row = await d.selectFrom("app_license_grants").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ license_id: "l1", kind: null, user_did: null });
  });

  it("issues no ALTER TABLE when the columns already exist", async () => {
    const pg = new PGlite();
    const executed: string[] = [];
    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(pg),
      log: (e) => { executed.push(e.query.sql); },
    });
    await up(db as Kysely<any>);
    executed.length = 0;
    await up(db as Kysely<any>);
    expect(executed.filter((q) => /alter table/i.test(q))).toStrictEqual([]);
  });

  it("checks columns in the namespace schema, not another schema with the same table", async () => {
    const pg = new PGlite();
    const executed: string[] = [];
    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(pg),
      log: (e) => { executed.push(e.query.sql); },
    });
    // public.app_license_grants already has the new columns; the namespace's does not.
    await up(db as Kysely<any>);
    await pg.exec(`CREATE SCHEMA ns`);
    const ns = db.withSchema("ns") as unknown as Kysely<any>;
    await up(ns);
    executed.length = 0;
    await up(ns);
    expect(executed.filter((q) => /alter table/i.test(q))).toStrictEqual([]);
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'ns' AND table_name = 'app_license_grants' AND column_name IN ('kind', 'user_did')`,
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toStrictEqual(["kind", "user_did"]);
  });

  it("migrates a production database that already holds old-shape rows", async () => {
    const pg = new PGlite();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(pg) });
    await pg.exec(`
      CREATE TABLE app_user_environments (app_id varchar(255) NOT NULL, user_address varchar(255) NOT NULL,
        environment_id varchar(255) NOT NULL, license_id varchar(255) NOT NULL, template_hash varchar(64) NOT NULL,
        created_at varchar(255) NOT NULL, updated_at varchar(255) NOT NULL,
        CONSTRAINT app_user_environments_pkey PRIMARY KEY (app_id, user_address));
      CREATE TABLE app_environment_limits (app_id varchar(255) NOT NULL, max_environments integer NOT NULL,
        CONSTRAINT app_environment_limits_pkey PRIMARY KEY (app_id));
      CREATE TABLE app_license_grants (license_id varchar(255) NOT NULL, app_id varchar(255) NOT NULL,
        license_type_id varchar(255) NOT NULL, user_address varchar(255) NOT NULL, issued_by varchar(255) NOT NULL,
        created_at varchar(255) NOT NULL, CONSTRAINT app_license_grants_pkey PRIMARY KEY (license_id));
      INSERT INTO app_user_environments VALUES ('app-1','0xaa','env-1','lic-0','h','t','t');
      INSERT INTO app_environment_limits VALUES ('app-1', 3);
      INSERT INTO app_license_grants VALUES ('lic-1','app-1','type-1','0xbb','0xcc','t');
    `);
    await up(db as Kysely<any>);
    await up(db as Kysely<any>);
    const grants = await db.selectFrom("app_license_grants").selectAll().orderBy("license_id").execute();
    expect(grants.map((g) => [g.license_id, g.kind, g.user_did])).toStrictEqual([
      ["lic-0", null, null],
      ["lic-1", null, null],
    ]);
    expect(await db.selectFrom("app_user_environments").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("app_environment_limits").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("license_environments").selectAll().execute()).toHaveLength(0);
  });

  it("makes root_license_id the license_environments claim lock", async () => {
    const d = await open();
    const env = (environment_id: string) => ({
      environment_id, root_license_id: "root", app_id: "a", user_did: "did:pkh:eip155:1:0x1",
      license_id: "root", template_id: null, label: null, template_hash: "unapplied",
      ended_at: null, stopped_at: null, delete_after: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    });
    await d.insertInto("license_environments").values(env("e1")).execute();
    await d.insertInto("license_environments").values(env("e2"))
      .onConflict((oc) => oc.column("root_license_id").doNothing()).execute();
    const rows = await d.selectFrom("license_environments").selectAll().execute();
    expect(rows.map((r) => r.environment_id)).toStrictEqual(["e1"]);
  });

  it("keys redemptions on (code, user_did) and allow-list on (app_id, user_did)", async () => {
    const d = await open();
    const r = { code: "c", user_did: "u", redeemed_at: "t", access_expires: null, license_id: null };
    await d.insertInto("invite_redemptions").values(r).execute();
    await expect(d.insertInto("invite_redemptions").values(r).execute()).rejects.toThrow(/duplicate key|unique/i);
    const a = { app_id: "a", user_did: "u", added_at: "t" };
    await d.insertInto("app_allow_list").values(a).execute();
    await expect(d.insertInto("app_allow_list").values(a).execute()).rejects.toThrow(/duplicate key|unique/i);
  });

  it("makes reporting token hashes unique", async () => {
    const d = await open();
    await d.insertInto("environment_reporting_tokens").values({ environment_id: "e1", token_hash: "h", created_at: "t" }).execute();
    await expect(
      d.insertInto("environment_reporting_tokens").values({ environment_id: "e2", token_hash: "h", created_at: "t" }).execute(),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("is clean to run up() again, and down() then up()", async () => {
    const d = await open();
    await expect(up(d as Kysely<any>)).resolves.toBeUndefined();
    await d.insertInto("app_user_environments").values(row("env-1", "a")).execute();
    await d.insertInto("license_chain").values({ license_id: "l", root_license_id: "l", app_id: "a", label: null, created_at: "t" }).execute();
    await d.insertInto("license_environments").values({
      environment_id: "e", root_license_id: "l", app_id: "a", user_did: "u", license_id: "l", template_id: null,
      label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t",
    }).execute();
    await d.insertInto("app_allow_list").values({ app_id: "a", user_did: "u", added_at: "t" }).execute();
    await d.insertInto("invite_codes").values({
      code: "c", app_id: "a", kind: "k", label: null, active: true, expires_at: null, max_uses: null,
      anthropic_key_ciphertext: null, created_at: "t",
    }).execute();
    await d.insertInto("invite_redemptions").values({ code: "c", user_did: "u", redeemed_at: "t", access_expires: null, license_id: null }).execute();
    await d.insertInto("environment_reporting_tokens").values({ environment_id: "e", token_hash: "h", created_at: "t" }).execute();
    await d.insertInto("licensing_migration_type_map").values({
      license_type_id: "lt", app_id: "a", kind: "k", template_id: "tp", term_id: "tm", created_at: "t",
    }).execute();
    await d.insertInto("licensing_migration_steps").values({ step: "complete", completed_at: "t", detail: null }).execute();
    await expect(down(d as Kysely<any>)).resolves.toBeUndefined();
    await expect(up(d as Kysely<any>)).resolves.toBeUndefined();
    for (const t of [
      "license_chain", "license_environments", "app_allow_list", "invite_codes", "invite_redemptions",
      "environment_reporting_tokens", "licensing_migration_type_map", "licensing_migration_steps",
    ] as const) {
      expect(await d.selectFrom(t).selectAll().execute()).toHaveLength(0);
    }
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
