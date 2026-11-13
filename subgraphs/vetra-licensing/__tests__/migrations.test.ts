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

  it("lowercases grant addresses (old backfilled rows), so the licence gate's exact match on its index finds them", async () => {
    const d = await open();
    const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    await d.insertInto("app_license_grants").values({
      license_id: "l1", app_id: "a", license_type_id: "", user_address: mixed,
      issued_by: "backfill", created_at: "2026-01-01T00:00:00.000Z", kind: "starter", user_did: null,
    }).execute();
    await up(d as Kysely<any>);
    const row = await d.selectFrom("app_license_grants").selectAll().executeTakeFirstOrThrow();
    expect(row.user_address).toBe(mixed.toLowerCase());
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

  it("runs entirely inside a namespace schema, with no tables in public", async () => {
    // Production namespaces never have these tables in public: every statement,
    // including the grants backfill's subquery, must resolve through the schema.
    const pg = new PGlite();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(pg) });
    await pg.exec(`CREATE SCHEMA ns_only`);
    const ns = db.withSchema("ns_only") as unknown as Kysely<any>;
    await up(ns);
    await ns
      .insertInto("app_user_environments")
      .values({ app_id: "a1", user_address: "0xabc", environment_id: "e1", license_id: "l1", template_hash: "h", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" })
      .execute();
    await up(ns);
    const grants = await pg.query<{ license_id: string }>(`SELECT license_id FROM ns_only.app_license_grants`);
    expect(grants.rows.map((r) => r.license_id)).toStrictEqual(["l1"]);
    const publicTables = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(publicTables.rows).toStrictEqual([]);
  });

  it("adds invite_codes.llm_budget_usd inside a namespace schema and reads it back as a number", async () => {
    const pg = new PGlite();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(pg) });
    await pg.exec(`CREATE SCHEMA ns_budget`);
    const ns = db.withSchema("ns_budget") as unknown as Kysely<any>;
    await up(ns);
    await up(ns);
    await ns
      .insertInto("invite_codes")
      .values({ code: "code-ns-01", app_id: "a", kind: "k", active: true, created_at: "2026-10-15T00:00:00.000Z", llm_budget_usd: 12.5 })
      .execute();
    const row = await ns
      .selectFrom("invite_codes")
      .select("llm_budget_usd")
      .where("code", "=", "code-ns-01")
      .executeTakeFirstOrThrow();
    expect(row.llm_budget_usd).toBe(12.5);
    const publicTables = await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(publicTables.rows).toStrictEqual([]);
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
      anthropic_key_ciphertext: null, created_at: "t", legacy_case_insensitive: false,
    }).execute();
    await d.insertInto("invite_redemptions").values({ code: "c", user_did: "u", redeemed_at: "t", access_expires: null, license_id: null }).execute();
    await d.insertInto("environment_reporting_tokens").values({ environment_id: "e", token_hash: "h", created_at: "t" }).execute();
    await d.insertInto("licensing_migration_type_map").values({
      license_type_id: "lt", app_id: "a", kind: "k", template_id: "tp", term_id: "tm", created_at: "t",
    }).execute();
    await d.insertInto("licensing_migration_steps").values({ step: "complete", completed_at: "t", detail: null }).execute();
    await d.insertInto("app_licensing_state").values({ app_id: "a", state_hash: "h", updated_at: "t" }).execute();
    await d.insertInto("license_lifecycle").values({ license_id: "l", status: "ACTIVE", end_at: null, replaced_by: null, updated_at: "t" }).execute();
    await expect(
      d.insertInto("app_licensing_state").values({ app_id: "a", state_hash: "h2", updated_at: "t" }).execute(),
    ).rejects.toThrow(/duplicate key|unique/i);
    await expect(down(d as Kysely<any>)).resolves.toBeUndefined();
    await expect(up(d as Kysely<any>)).resolves.toBeUndefined();
    for (const t of [
      "license_chain", "license_environments", "app_allow_list", "invite_codes", "invite_redemptions",
      "environment_reporting_tokens", "licensing_migration_type_map", "licensing_migration_steps",
      "app_licensing_state", "license_lifecycle",
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

  it("creates app_warm_pool and re-running up() is a no-op", async () => {
    const d = await open();
    await up(d as Kysely<any>);
    await d
      .insertInto("app_warm_pool")
      .values({
        environment_id: "w1", app_id: "app-1", template_id: "t", template_hash: "h",
        state: "WARMING", created_at: "2026-11-01T00:00:00.000Z",
        ready_at: null, claimed_at: null, deleted_at: null, root_license_id: null,
      })
      .execute();
    expect(await d.selectFrom("app_warm_pool").selectAll().execute()).toHaveLength(1);
  });

  it("adds app_warm_pool.env_deleted_at to a table created without it, keeping its rows", async () => {
    const pg = new PGlite();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(pg) });
    await pg.exec(`
      CREATE TABLE app_warm_pool (environment_id varchar(255) NOT NULL, app_id varchar(255) NOT NULL,
        template_id varchar(255) NOT NULL, template_hash varchar(64) NOT NULL, state varchar(16) NOT NULL,
        created_at varchar(255) NOT NULL, ready_at varchar(255), claimed_at varchar(255), deleted_at varchar(255),
        root_license_id varchar(255), CONSTRAINT app_warm_pool_pkey PRIMARY KEY (environment_id));
      INSERT INTO app_warm_pool VALUES ('w1','app-1','t','h','WARMING','t',NULL,NULL,'t2',NULL);
    `);
    await up(db as Kysely<any>);
    await up(db as Kysely<any>);
    expect(await db.selectFrom("app_warm_pool").select(["environment_id", "deleted_at", "env_deleted_at", "pool_size", "timed_out_at"]).execute()).toStrictEqual([
      { environment_id: "w1", deleted_at: "t2", env_deleted_at: null, pool_size: null, timed_out_at: null },
    ]);
    const { rows } = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'app_warm_pool' AND indexname = 'app_warm_pool_created_idx'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("vetra-licensing migrations: app release rollout tables", () => {
  let db: Kysely<VetraLicensingDB> | undefined;
  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });
  const update = (id: string, rollout_id: string | null, environment_id = "e1") => ({
    id, rollout_id, environment_id, app_id: "a", from_version: "1.0.0", to_version: "1.1.0", status: "PENDING" as const,
    due_at: "t", requested_at: null, started_at: null, finished_at: null, pre_update_dump_id: null, error: null,
    forced_at: null, created_at: "t",
  });

  it("defaults a settings row to AUTO with 72 hours' notice", async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await (db as Kysely<any>).insertInto("app_release_settings").values({ app_id: "a", updated_at: "t" }).execute();
    expect(await db.selectFrom("app_release_settings").selectAll().executeTakeFirstOrThrow())
      .toStrictEqual({ app_id: "a", policy: "AUTO", default_notice_hours: 72, updated_at: "t", frozen_reason: null, frozen_at: null });
  });

  it("adds channel_override to license_environments, null on existing rows", async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    // A database from before the column: the row exists when up() adds it.
    await db.schema.alterTable("license_environments").dropColumn("channel_override").execute();
    await db.insertInto("license_environments").values({
      environment_id: "e", root_license_id: "l", app_id: "a", user_did: "u", license_id: "l", template_id: null,
      label: null, template_hash: "h", ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t",
    }).execute();
    await up(db as Kysely<any>);
    const row = await db.selectFrom("license_environments").selectAll().executeTakeFirstOrThrow();
    expect(row.channel_override).toBeNull();
  });

  it("allows one update per (rollout, environment), and any number without a rollout", async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await db.insertInto("environment_updates").values(update("u1", "r1")).execute();
    await expect(db.insertInto("environment_updates").values(update("u2", "r1")).execute())
      .rejects.toThrow(/duplicate key|unique/i);
    await db.insertInto("environment_updates").values(update("u3", "r1", "e2")).execute();
    await db.insertInto("environment_updates").values(update("u4", null)).execute();
    await db.insertInto("environment_updates").values(update("u5", null)).execute();
    expect(await db.selectFrom("environment_updates").select("id").execute()).toHaveLength(4);
  });

  it("drops the release tables on down() and recreates them on up()", async () => {
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);
    await db.insertInto("app_release_settings")
      .values({ app_id: "a", policy: "GATED", default_notice_hours: 24, updated_at: "t" }).execute();
    await db.insertInto("app_rollouts").values({
      id: "r1", app_id: "a", artifact_name: "host", version: "1.1.0", status: "ACTIVE", apply_after: "t",
      promoted_by: "p", promoted_at: "t", paused_at: null, paused_reason: null,
    }).execute();
    await db.insertInto("environment_updates").values(update("u1", "r1")).execute();
    for (const t of ["app_release_settings", "app_rollouts", "environment_updates"] as const) {
      expect(await db.selectFrom(t).selectAll().execute()).toHaveLength(1);
    }
    await down(db as Kysely<any>);
    await up(db as Kysely<any>);
    for (const t of ["app_release_settings", "app_rollouts", "environment_updates"] as const) {
      expect(await db.selectFrom(t).selectAll().execute()).toHaveLength(0);
    }
  });
});
