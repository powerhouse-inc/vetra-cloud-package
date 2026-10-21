import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  ensureAppsOrgColumn,
  ensureAppsStudioColumn,
  ensureDeploymentTriggerColumns,
  ensureStudioLaunchSecretsTable,
  ensureStudioProductColumns,
  isConcurrentIndexError,
  up,
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

describe("ensureStudioLaunchSecretsTable", () => {
  it("creates the table in the namespace schema, additively and idempotently", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const db = root.withSchema("vetra-apps");
      await ensureStudioLaunchSecretsTable(db);
      await db
        .insertInto("studio_launch_secrets")
        .values({ environment_id: "s1", secret_hash: "a".repeat(64), rotated_at: "t" })
        .execute();
      await ensureStudioLaunchSecretsTable(db);
      expect(
        await db.selectFrom("studio_launch_secrets").select("environment_id").execute(),
      ).toStrictEqual([{ environment_id: "s1" }]);
      const inPublic = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_name = 'studio_launch_secrets' AND table_schema = 'public'`.execute(root);
      expect(inPublic.rows[0].n).toBe(0);
      // One row per Studio.
      await expect(
        db
          .insertInto("studio_launch_secrets")
          .values({ environment_id: "s1", secret_hash: "b".repeat(64), rotated_at: "t" })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await root.destroy();
    }
  });
});

describe("ensureStudioLaunchSecretsTable under concurrent boots", () => {
  /** A db whose CREATE TABLE fails with `err` (as the loser of a boot race sees). */
  const failingDb = (err: unknown) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["ifNotExists", "addColumn"]) builder[m] = () => builder;
    builder.execute = () => Promise.reject(err);
    return { schema: { createTable: () => builder } } as unknown as Kysely<any>;
  };

  it("tolerates a lost race (23505 / 42P07) and rethrows anything else", async () => {
    await expect(
      ensureStudioLaunchSecretsTable(failingDb(Object.assign(new Error("dup"), { code: "23505" }))),
    ).resolves.toBeUndefined();
    await expect(
      ensureStudioLaunchSecretsTable(failingDb(Object.assign(new Error("dup"), { code: "42P07" }))),
    ).resolves.toBeUndefined();
    await expect(
      ensureStudioLaunchSecretsTable(failingDb(Object.assign(new Error("boom"), { code: "42501" }))),
    ).rejects.toThrow("boom");
  });

  it("parallel creates in one database all succeed", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const db = root.withSchema("vetra-apps");
      await Promise.all([1, 2, 3].map(() => ensureStudioLaunchSecretsTable(db)));
      expect(await db.selectFrom("studio_launch_secrets").selectAll().execute()).toStrictEqual([]);
    } finally {
      await root.destroy();
    }
  });
});

describe("ensureStudioProductColumns (Task 2.2)", () => {
  /** The apps table as production has it before this change (repository columns NOT NULL). */
  const legacyApps = sql`CREATE TABLE "vetra-apps".apps (
    id varchar(64) PRIMARY KEY,
    status varchar(32) NOT NULL,
    installation_id varchar(64) NOT NULL,
    repository_id varchar(64) NOT NULL,
    repository_full_name varchar(255) NOT NULL
  )`;

  it("makes the repository nullable and adds the product columns in the namespace schema; existing rows untouched; idempotent and concurrent-safe", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      await legacyApps.execute(root);
      const db = root.withSchema("vetra-apps");
      const github = {
        id: "a",
        status: "ACTIVE",
        installation_id: "77",
        repository_id: "4242",
        repository_full_name: "acme/shop",
      };
      await db.insertInto("apps").values(github).execute();
      await expect(
        db.insertInto("apps").values({ id: "x", status: "ACTIVE" }).execute(),
      ).rejects.toThrow();

      await ensureStudioProductColumns(db);
      await Promise.all([1, 2, 3].map(() => ensureStudioProductColumns(db)));
      await ensureStudioProductColumns(db);

      await db
        .insertInto("apps")
        .values({ id: "b", status: "ACTIVE", product_drive_id: "d1", launched_at: "t", adopted_at: null })
        .execute();
      expect(await db.selectFrom("apps").selectAll().orderBy("id").execute()).toStrictEqual([
        { ...github, product_drive_id: null, launched_at: null, adopted_at: null },
        {
          id: "b",
          status: "ACTIVE",
          installation_id: null,
          repository_id: null,
          repository_full_name: null,
          product_drive_id: "d1",
          launched_at: "t",
          adopted_at: null,
        },
      ]);
      const inPublic = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE column_name = 'product_drive_id' AND table_schema = 'public'`.execute(root);
      expect(inPublic.rows[0].n).toBe(0);
    } finally {
      await root.destroy();
    }
  });

  it("the whole up() runs twice on a fresh namespace", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const db = root.withSchema("vetra-apps");
      await up(db);
      await up(db);
      const cols = await sql<{ column_name: string; is_nullable: string }>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'vetra-apps' AND table_name = 'apps'
          AND column_name IN ('installation_id', 'repository_id', 'repository_full_name', 'product_drive_id', 'launched_at', 'adopted_at')
        ORDER BY column_name`.execute(root);
      expect(cols.rows).toStrictEqual(
        ["adopted_at", "installation_id", "launched_at", "product_drive_id", "repository_full_name", "repository_id"].map(
          (column_name) => ({ column_name, is_nullable: "YES" }),
        ),
      );
    } finally {
      await root.destroy();
    }
  });

  it("tolerates a lost race and rethrows anything else", async () => {
    const failing = (err: unknown) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["alterColumn", "addColumn"]) builder[m] = () => builder;
      builder.execute = () => Promise.reject(err as Error);
      return { schema: { alterTable: () => builder } } as unknown as Kysely<any>;
    };
    for (const c of ["42701", "42P07", "23505"]) {
      await expect(
        ensureStudioProductColumns(failing(Object.assign(new Error("dup"), { code: c }))),
      ).resolves.toBeUndefined();
    }
    await expect(
      ensureStudioProductColumns(failing(Object.assign(new Error("boom"), { code: "42501" }))),
    ).rejects.toThrow("boom");
  });
});

describe("ensureDeploymentTriggerColumns (Task 2.3)", () => {
  it("adds trigger, on_behalf_of and version_number plus the launch key in the namespace schema; existing rows untouched; idempotent and concurrent-safe", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      await sql`CREATE TABLE "vetra-apps".app_deployments (
        id varchar(64) PRIMARY KEY,
        app_id varchar(64) NOT NULL,
        sha varchar(64) NOT NULL,
        status varchar(32) NOT NULL
      )`.execute(root);
      const db = root.withSchema("vetra-apps");
      await db.insertInto("app_deployments").values({ id: "old", app_id: "a", sha: "s", status: "READY" }).execute();

      await ensureDeploymentTriggerColumns(db);
      await Promise.all([1, 2, 3].map(() => ensureDeploymentTriggerColumns(db)));
      await ensureDeploymentTriggerColumns(db);

      expect(await db.selectFrom("app_deployments").selectAll().execute()).toStrictEqual([
        { id: "old", app_id: "a", sha: "s", status: "READY", trigger: null, on_behalf_of: null, version_number: null, pre_apply_packages: null },
      ]);
      const row = (id: string, status: string, trigger = "STUDIO_LAUNCH") => ({
        id, app_id: "a", sha: "s", status, trigger, version_number: 1,
      });
      await db.insertInto("app_deployments").values(row("l1", "PENDING")).execute();
      // A second in-flight launch of the same (app, version, sha) is refused…
      await expect(db.insertInto("app_deployments").values(row("l2", "DEPLOYING")).execute()).rejects.toMatchObject({
        code: "23505",
      });
      // …READY and FAILED ones and other triggers are not in the key.
      await db.insertInto("app_deployments").values(row("d1", "READY")).execute();
      await db.insertInto("app_deployments").values(row("f1", "FAILED")).execute();
      await db.insertInto("app_deployments").values(row("r1", "PENDING", "STUDIO_ROLLBACK")).execute();
      await db.insertInto("app_deployments").values(row("r2", "PENDING", "STUDIO_ROLLBACK")).execute();

      const indexes = await sql<{ schemaname: string }>`
        SELECT schemaname FROM pg_indexes WHERE indexname = 'app_deployments_studio_launch_key'`.execute(root);
      expect(indexes.rows).toStrictEqual([{ schemaname: "vetra-apps" }]);
      const inPublic = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE column_name = 'version_number' AND table_schema = 'public'`.execute(root);
      expect(inPublic.rows[0].n).toBe(0);
    } finally {
      await root.destroy();
    }
  });

  it("tolerates a lost race and rethrows anything else", async () => {
    const failing = (columnErr: unknown, indexErr: unknown) => {
      const make = (err: unknown) => {
        const builder: Record<string, unknown> = {};
        for (const m of ["addColumn", "ifNotExists", "unique", "on", "columns", "where"]) builder[m] = () => builder;
        builder.execute = () => (err ? Promise.reject(err as Error) : Promise.resolve());
        return builder;
      };
      return {
        schema: { alterTable: () => make(columnErr), createIndex: () => make(indexErr) },
      } as unknown as Kysely<any>;
    };
    const pgError = (code: string) => Object.assign(new Error(code === "42501" ? "boom" : "dup"), { code });
    for (const c of ["42701", "42P07", "23505"]) {
      await expect(ensureDeploymentTriggerColumns(failing(pgError(c), null))).resolves.toBeUndefined();
    }
    for (const c of ["42P07", "23505"]) {
      await expect(ensureDeploymentTriggerColumns(failing(null, pgError(c)))).resolves.toBeUndefined();
    }
    await expect(ensureDeploymentTriggerColumns(failing(pgError("42501"), null))).rejects.toThrow("boom");
    await expect(ensureDeploymentTriggerColumns(failing(null, pgError("42501")))).rejects.toThrow("boom");
  });
});
