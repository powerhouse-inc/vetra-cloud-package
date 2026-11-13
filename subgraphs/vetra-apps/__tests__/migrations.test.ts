import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  ensureAppAuditTable,
  ensureAppRolesTable,
  ensureAppsOrgColumn,
  ensureAppsStudioColumn,
  ensureDeploymentTriggerColumns,
  ensureAppsReleaseBranchesColumn,
  ensureExternalChangesColumns,
  ensureInstanceBackupTables,
  ensureInstanceGateTokensTable,
  ensureInstancesPlanColumns,
  ensurePlansTable,
  ensureStudioLaunchSecretsTable,
  ensureRolloutColumns,
  ensureRolloutTables,
  ensureStudioProductColumns,
  isConcurrentIndexError,
  up,
} from "../db/migrations.js";
import {
  deleteAppSetting,
  deleteAppSettings,
  listAppSettings,
  upsertAppSetting,
} from "../settings/repo.js";
import { getPlan, insertPlan, listPlans, updatePlan } from "../plans/repo.js";
import { listAudit, recordAudit, sweepAudit } from "../audit/repo.js";
import {
  deleteAppRole,
  getAppRole,
  hasAppRole,
  listAppRoles,
  upsertAppRole,
} from "../roles/repo.js";
import type { VetraAppsDB } from "../db/schema.js";

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
        schema: {
          alterTable: () => make(columnErr),
          createIndex: () => make(indexErr),
          dropIndex: () => ({
            ifExists: () => ({ compile: () => ({ sql: 'drop index if exists "x"' }), execute: () => Promise.resolve() }),
          }),
        },
        // The stale-index probe finds nothing.
        getExecutor: () => ({
          transformQuery: (n: unknown) => n,
          compileQuery: () => ({ sql: "", parameters: [], query: {} }),
          executeQuery: () => Promise.resolve({ rows: [] }),
        }),
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

describe("the first launch key definition (READY included) is replaced", () => {
  it("drops the stale index in the namespace only and recreates it in-flight only; concurrent boots are fine", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const db = root.withSchema("vetra-apps");
      await up(db);
      // The definition 2d97524 created, as a dev database may have it.
      await sql`DROP INDEX "vetra-apps".app_deployments_studio_launch_key`.execute(root);
      await sql`CREATE UNIQUE INDEX app_deployments_studio_launch_key ON "vetra-apps".app_deployments (app_id, version_number, sha)
        WHERE trigger = 'STUDIO_LAUNCH' AND status IN ('PENDING', 'DEPLOYING', 'READY')`.execute(root);
      // A same-named index in another schema is not ours.
      await sql`CREATE TABLE public.app_deployments (app_id text, version_number int, sha text, trigger text, status text)`.execute(root);
      await sql`CREATE UNIQUE INDEX app_deployments_studio_launch_key ON public.app_deployments (app_id, version_number, sha)
        WHERE status IN ('READY')`.execute(root);

      await Promise.all([1, 2, 3].map(() => up(db)));
      await up(db);

      const defs = await sql<{ schemaname: string; indexdef: string }>`
        SELECT schemaname, indexdef FROM pg_indexes
        WHERE indexname = 'app_deployments_studio_launch_key' ORDER BY schemaname`.execute(root);
      expect(defs.rows.map((r) => r.schemaname)).toStrictEqual(["public", "vetra-apps"]);
      expect(defs.rows[0].indexdef).toContain("'READY'");
      expect(defs.rows[1].indexdef).not.toContain("'READY'");

      // Launching a version again after a Go back: a READY row no longer blocks it.
      const row = (id: string, status: string) => ({
        id, app_id: "a", environment_id: "e", kind: "PRODUCTION", git_ref: "refs/tags/v2", sha: "s",
        packages: "[]", status, trigger: "STUDIO_LAUNCH", version_number: 2, created_at: "t", updated_at: "t",
      });
      await db.insertInto("app_deployments").values(row("ready", "READY")).execute();
      await db.insertInto("app_deployments").values(row("again", "PENDING")).execute();
      await expect(db.insertInto("app_deployments").values(row("dup", "DEPLOYING")).execute()).rejects.toMatchObject({
        code: "23505",
      });
    } finally {
      await root.destroy();
    }
  });
});

describe("ensureExternalChangesColumns (Task 4.2)", () => {
  it("adds the push columns in the namespace schema; existing rows untouched; idempotent and concurrent-safe", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      await sql`CREATE TABLE "vetra-apps".apps (id varchar(64) PRIMARY KEY)`.execute(root);
      await sql`CREATE TABLE "vetra-apps".app_deployments (id varchar(64) PRIMARY KEY)`.execute(root);
      const db = root.withSchema("vetra-apps");
      await db.insertInto("apps").values({ id: "a" }).execute();
      await db.insertInto("app_deployments").values({ id: "d" }).execute();
      await Promise.all([1, 2, 3].map(() => ensureExternalChangesColumns(db)));
      await ensureExternalChangesColumns(db);
      expect(
        await db.selectFrom("apps").select(["id", "external_changes_sha", "mirror_sha"]).execute(),
      ).toStrictEqual([{ id: "a", external_changes_sha: null, mirror_sha: null }]);
      expect(
        await db.selectFrom("app_deployments").select(["id", "mirror_sha"]).execute(),
      ).toStrictEqual([{ id: "d", mirror_sha: null }]);
    } finally {
      await root.destroy();
    }
  });
});

describe("ensureAppsReleaseBranchesColumn", () => {
  it("adds release_branches (JSON text, default []) in the namespace schema; existing rows get []; idempotent and concurrent-safe", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      await sql`CREATE TABLE "vetra-apps".apps (id varchar(64) PRIMARY KEY)`.execute(
        root,
      );
      const db = root.withSchema("vetra-apps");
      await db.insertInto("apps").values({ id: "a" }).execute();
      await Promise.all(
        [1, 2, 3].map(() => ensureAppsReleaseBranchesColumn(db)),
      );
      await ensureAppsReleaseBranchesColumn(db);
      await db.insertInto("apps").values({ id: "b" }).execute();
      expect(
        await db
          .selectFrom("apps")
          .select(["id", "release_branches"])
          .orderBy("id")
          .execute(),
      ).toStrictEqual([
        { id: "a", release_branches: "[]" },
        { id: "b", release_branches: "[]" },
      ]);
    } finally {
      await root.destroy();
    }
  });
});

it("adds the instance health columns, idempotently", async () => {
  const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  await up(db);
  await db
    .insertInto("instances")
    .values({
      id: "i1",
      app_id: "a1",
      kind: "branch",
      name: "main",
      status: "degraded",
      health: "unhealthy",
      health_check: "crash",
      health_reason: "x",
      health_checked_at: "2026-11-12T00:00:00.000Z",
      health_since: "2026-11-12T00:00:00.000Z",
      health_digest: "sha256:aa",
      health_restarts: 4,
      observed_digest: "sha256:aa",
      observed_digest_source: "pod",
      running_degraded: true,
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
    })
    .execute();
  const row = await db.selectFrom("instances").selectAll().executeTakeFirstOrThrow();
  expect(row).toMatchObject({
    health: "unhealthy",
    health_restarts: 4,
    observed_digest_source: "pod",
    running_degraded: true,
  });
  await db.destroy();
});

describe("app_settings and instance settings columns", () => {
  it("are created idempotently and hold a setting per app, scope and name", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db);
    await up(db); // second run: no error
    const row = {
      app_id: "app-1",
      scope: "all" as const,
      name: "FOO",
      secret: false,
      value: "1",
      ciphertext: null,
      write_id: "w1",
      updated_at: "2026-11-12T00:00:00.000Z",
      updated_by: "0xaa",
    };
    await upsertAppSetting(db, row);
    await upsertAppSetting(db, { ...row, value: "2", write_id: "w2" });
    await upsertAppSetting(db, { ...row, scope: "preview", value: "p" });
    expect(
      (await listAppSettings(db, "app-1")).map((r) => [r.scope, r.name, r.value]),
    ).toEqual([
      ["all", "FOO", "2"],
      ["preview", "FOO", "p"],
    ]);
    expect(await deleteAppSetting(db, "app-1", "preview", "FOO")).toBe(true);
    expect(await deleteAppSetting(db, "app-1", "preview", "FOO")).toBe(false);
    expect(await deleteAppSettings(db, "app-1")).toBe(1);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'instances'`.execute(db);
    const names = cols.rows.map((c) => c.column_name);
    for (const c of [
      "target_settings",
      "running_settings",
      "failed_settings",
      "settings_delivered",
      "settings_delivered_at",
      "health_settings",
      "observed_settings",
    ])
      expect(names).toContain(c);
    await db.destroy();
  });
});

describe("plans and the instances' plan columns", () => {
  it("are created idempotently; a plan is unique per app by slug and by kind", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db);
    await up(db); // second run: no error
    const row = {
      id: "plan-1",
      app_id: "app-1",
      slug: "pro",
      name: "Pro",
      kind: "pro",
      access: "own" as const,
      size: "VETRA_AGENT_M",
      target_version: null,
      policy: "manual",
      notice_hours: 72,
      status: "active" as const,
      created_by: "0xaa",
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
    };
    await insertPlan(db, row);
    await expect(insertPlan(db, { ...row, id: "plan-2", kind: "other" })).rejects.toThrow();
    await expect(insertPlan(db, { ...row, id: "plan-3", slug: "other" })).rejects.toThrow();
    const moved = await updatePlan(
      db,
      "plan-1",
      { target_version: "1.4.0" },
      "2026-11-12T01:00:00.000Z",
    );
    expect(moved).toMatchObject({
      target_version: "1.4.0",
      updated_at: "2026-11-12T01:00:00.000Z",
    });
    expect((await listPlans(db, "app-1")).map((p) => p.id)).toEqual(["plan-1"]);
    expect(await getPlan(db, "missing")).toBeNull();
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'instances'`.execute(db);
    const names = cols.rows.map((c) => c.column_name);
    for (const c of [
      "plan_id",
      "holder_address",
      "licence_root_id",
      "licence_ended_at",
      "stop_reason",
      "stopped_by_vetra",
      "target_size",
    ])
      expect(names).toContain(c);
    await db.destroy();
  });
});

describe("ensurePlansTable and ensureInstancesPlanColumns", () => {
  const PLAN_COLUMNS = [
    "plan_id",
    "holder_address",
    "licence_root_id",
    "licence_ended_at",
    "stop_reason",
    "stopped_by_vetra",
    "target_size",
  ];
  const instance = (id: string, root: string | null = null) => ({
    id,
    app_id: "a1",
    kind: root ? "own" : "branch",
    name: id,
    status: "pending",
    created_at: "2026-11-12T00:00:00.000Z",
    updated_at: "2026-11-12T00:00:00.000Z",
    ...(root ? { licence_root_id: root } : {}),
  });

  it("work in the namespace schema, concurrently; an existing instance survives with null plan columns", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const db = root.withSchema("vetra-apps");
      await up(db);
      // The instances table as it was before this change.
      await sql`DROP TABLE "vetra-apps".plans`.execute(root);
      await sql`DROP INDEX "vetra-apps".instances_licence_root_uq`.execute(root);
      for (const c of PLAN_COLUMNS)
        await sql`ALTER TABLE "vetra-apps".instances DROP COLUMN ${sql.ref(c)}`.execute(root);
      await db.insertInto("instances").values(instance("old")).execute();

      await Promise.all(
        [1, 2, 3].flatMap(() => [ensurePlansTable(db), ensureInstancesPlanColumns(db)]),
      );
      await ensurePlansTable(db);
      await ensureInstancesPlanColumns(db);

      const old = await db
        .selectFrom("instances")
        .select(PLAN_COLUMNS)
        .where("id", "=", "old")
        .executeTakeFirstOrThrow();
      expect(old).toStrictEqual(Object.fromEntries(PLAN_COLUMNS.map((c) => [c, null])));
      for (const [table, column] of [
        ["plans", "kind"],
        ["instances", "licence_root_id"],
      ]) {
        const where = await sql<{ table_schema: string }>`
          SELECT table_schema FROM information_schema.columns
          WHERE table_name = ${table} AND column_name = ${column}`.execute(root);
        expect(where.rows).toStrictEqual([{ table_schema: "vetra-apps" }]);
      }
      const index = await sql<{ schemaname: string }>`
        SELECT schemaname FROM pg_indexes WHERE indexname = 'instances_licence_root_uq'`.execute(root);
      expect(index.rows).toStrictEqual([{ schemaname: "vetra-apps" }]);
    } finally {
      await root.destroy();
    }
  });

  it("instances_licence_root_uq: one instance per (App, licence root); rows without a root are not in it", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await up(db);
      await db.insertInto("instances").values(instance("n1")).execute();
      await db.insertInto("instances").values(instance("n2")).execute();
      await db.insertInto("instances").values(instance("o1", "root-1")).execute();
      await db
        .insertInto("instances")
        .values({ ...instance("o2", "root-1"), app_id: "a2" })
        .execute();
      await expect(
        db.insertInto("instances").values(instance("o3", "root-1")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await db.destroy();
    }
  });
});

describe("app_audit and app_roles", () => {
  it("are created idempotently and concurrently in the namespace schema; audit pages newest first; the sweep deletes old rows only; roles keep their owner scope", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all(
        [1, 2, 3].flatMap(() => [ensureAppAuditTable(any), ensureAppRolesTable(any)]),
      );
      const db = any as unknown as Kysely<VetraAppsDB>;

      const entry = (at: string, appId = "app-1") => ({
        appId,
        at,
        actor: "0xaa",
        source: "api" as const,
        action: "plan.created" as const,
        subject: "plan:p1",
        detail: { note: "x".repeat(600) },
      });
      const old = await recordAudit(db, entry("2025-01-01T00:00:00.000Z"));
      expect((JSON.parse(old.detail) as { note: string }).note).toHaveLength(501);
      await recordAudit(db, entry("2026-11-12T00:00:00.000Z"));
      await recordAudit(db, entry("2026-11-12T00:00:01.000Z", "app-2"));
      const page = await listAudit(db, "app-1", { limit: 10 });
      expect(page.map((r) => r.at)).toEqual([
        "2026-11-12T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
      ]);
      expect(
        (await listAudit(db, "app-1", { limit: 10, before: { at: page[0].at, id: page[0].id } })).map(
          (r) => r.id,
        ),
      ).toEqual([old.id]);
      expect(await sweepAudit(db, "2026-01-01T00:00:00.000Z", 100)).toBe(1);
      expect(await listAudit(db, "app-1", { limit: 10 })).toHaveLength(1);

      const role = {
        app_id: "app-1",
        address: "0xbb",
        role: "release_manager" as const,
        owner_scope: "user:0xaa",
        granted_by: "0xaa",
        granted_at: "2026-11-12T00:00:00.000Z",
      };
      await upsertAppRole(db, role);
      await upsertAppRole(db, { ...role, owner_scope: "org:o1", granted_at: "2026-11-12T01:00:00.000Z" });
      expect(await listAppRoles(db, "app-1", "user:0xaa")).toEqual([]);
      expect((await listAppRoles(db, "app-1", "org:o1")).map((r) => r.address)).toEqual(["0xbb"]);
      expect(await hasAppRole(db, "app-1", "0xbb", "release_manager", "org:o1")).toBe(true);
      expect(await hasAppRole(db, "app-1", "0xbb", "release_manager", "user:0xaa")).toBe(false);
      expect(await getAppRole(db, "app-1", "0xbb", "release_manager")).toMatchObject({
        owner_scope: "org:o1",
      });
      expect(await deleteAppRole(db, "app-1", "0xbb", "release_manager", "user:0xaa")).toBe(false);
      expect(await deleteAppRole(db, "app-1", "0xbb", "release_manager", "org:o1")).toBe(true);
      expect(await deleteAppRole(db, "app-1", "0xbb", "release_manager", "org:o1")).toBe(false);
    } finally {
      await root.destroy();
    }
  });
});

describe("rollout tables", () => {
  it("are created idempotently and concurrently, with the new columns and one moving step per App", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all(
        [1, 2, 3].flatMap(() => [ensureRolloutTables(any), ensureRolloutColumns(any)]),
      );
      const cols = async (t: string) =>
        (
          await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'vetra-apps' and table_name = ${t}`.execute(
            root,
          )
        ).rows.map((r) => r.column_name);
      expect(await cols("instances")).toContain("pinned_version");
      expect(await cols("releases")).toEqual(
        expect.arrayContaining(["withdrawn_at", "withdrawn_by", "withdrawn_reason"]),
      );
      expect(await cols("plans")).toEqual(expect.arrayContaining(["update_window", "policy_note"]));
      const step = (id: string, instance: string, status: string) => ({
        id,
        rollout_id: "r1",
        app_id: "app-1",
        plan_id: "p1",
        instance_id: instance,
        instance_kind: "own",
        instance_name: instance,
        position: 0,
        from_version: "1.0.0",
        to_version: "1.1.0",
        status,
        due_at: "2026-11-12T00:00:00.000Z",
        requested_at: null,
        started_at: null,
        finished_at: null,
        target_moved: false,
        attempts: 0,
        error: null,
        note: null,
        created_at: "2026-11-12T00:00:00.000Z",
        updated_at: "2026-11-12T00:00:00.000Z",
      });
      await any.insertInto("rollout_steps").values(step("s1", "i1", "applying")).execute();
      await any.insertInto("rollout_steps").values(step("s2", "i2", "pending")).execute();
      await expect(
        any.insertInto("rollout_steps").values(step("s3", "i3", "reverting")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await root.destroy();
    }
  });
});

describe("instance_gate_tokens", () => {
  it("is created idempotently and concurrently in the namespace schema; a token hash is unique", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all([1, 2, 3].map(() => ensureInstanceGateTokensTable(any)));
      const db = any as unknown as Kysely<VetraAppsDB>;
      const at = "2026-11-12T00:00:00.000Z";
      const row = (id: string) => ({
        instance_id: id,
        app_id: "app-1",
        token_hash: "a".repeat(64),
        token_ciphertext: "vault:x",
        token_id: `tid-${id}`,
        previous_hash: null,
        previous_until: null,
        delivered_at: null,
        created_at: at,
        rotated_at: at,
      });
      await db.insertInto("instance_gate_tokens").values(row("i1")).execute();
      await expect(
        db.insertInto("instance_gate_tokens").values(row("i2")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await root.destroy();
    }
  });
});

describe("instance backup tables", () => {
  it("are created idempotently and concurrently, with instances.maintenance and one active restore per instance", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-apps"`.execute(root);
      const any = root.withSchema("vetra-apps");
      await up(any);
      await Promise.all([1, 2, 3].map(() => ensureInstanceBackupTables(any)));
      const cols = (
        await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'vetra-apps' and table_name = 'instances'`.execute(root)
      ).rows.map((r) => r.column_name);
      expect(cols).toContain("maintenance");
      const at = "2026-11-12T00:00:00.000Z";
      const restore = (id: string, status: string) => ({
        id,
        app_id: "app-1",
        instance_id: "i-1",
        environment_id: "env-1",
        tenant_id: "t-1",
        backup_id: "b-1",
        safety_backup_id: null,
        purpose: "manual",
        then_version: null,
        data: true,
        status,
        phase_started_at: at,
        db_job: null,
        data_job: null,
        replicas: null,
        target_set: false,
        was_held: false,
        error: null,
        held: false,
        requested_by: "vetra",
        rollout_step_id: null,
        created_at: at,
        updated_at: at,
        finished_at: null,
      });
      await any.insertInto("instance_restores").values(restore("r0", "failed")).execute();
      await any.insertInto("instance_restores").values(restore("r1", "stopping")).execute();
      await expect(
        any.insertInto("instance_restores").values(restore("r2", "safety_backup")).execute(),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await root.destroy();
    }
  });
});
