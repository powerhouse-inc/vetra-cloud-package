import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { countPackageInstalls } from "../package-install-counts.js";
import { createResolvers } from "../resolvers.js";

type Seed = { id: string; status: string | null; packages: string | null };

const pkgs = (...names: string[]) =>
  JSON.stringify(
    names.map((name) => ({ registry: null, name, version: "1.0.0" })),
  );

const SEEDS: Seed[] = [
  { id: "a", status: "READY", packages: pkgs("@acme/todo", "@acme/chat") },
  { id: "b", status: "DEPLOYING", packages: pkgs("@acme/todo") },
  // Listed twice on one env: still one environment.
  {
    id: "c",
    status: "READY",
    packages: pkgs("@acme/todo", "@acme/todo", "@acme/wiki"),
  },
  // Not reported yet: counts as live.
  { id: "d", status: null, packages: pkgs("@acme/wiki") },
  // Gone or going: left out.
  { id: "e", status: "DESTROYED", packages: pkgs("@acme/todo", "@acme/gone") },
  { id: "f", status: "ARCHIVED", packages: pkgs("@acme/todo", "@acme/gone") },
  {
    id: "g",
    status: "TERMINATING",
    packages: pkgs("@acme/todo", "@acme/gone"),
  },
  // Nothing installed / junk JSON: contribute nothing.
  { id: "h", status: "READY", packages: null },
  { id: "i", status: "READY", packages: "not json" },
  {
    id: "j",
    status: "READY",
    packages: JSON.stringify([{ name: "" }, { version: "1" }, null]),
  },
];

const EXPECTED = [
  { packageName: "@acme/todo", environments: 3 },
  { packageName: "@acme/wiki", environments: 2 },
  { packageName: "@acme/chat", environments: 1 },
];

async function createEnvTable(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("environments")
    .addColumn("id", "varchar(255)", (col) => col.primaryKey())
    .addColumn("name", "varchar(255)")
    .addColumn("owner", "varchar(255)")
    .addColumn("packages", "text")
    .addColumn("status", "varchar(64)")
    .execute();
}

async function seed(db: Kysely<any>): Promise<void> {
  await db
    .insertInto("environments")
    .values(SEEDS.map((s) => ({ ...s, name: `env-${s.id}`, owner: "0xowner" })))
    .execute();
}

describe("countPackageInstalls", () => {
  let envDb: Kysely<any>;

  beforeEach(async () => {
    envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    await createEnvTable(envDb);
  });

  afterEach(async () => {
    await envDb.destroy();
  });

  it("returns an empty list when there are no environments", async () => {
    expect(await countPackageInstalls(envDb)).toEqual([]);
  });

  it("counts distinct live environments per package, most used first", async () => {
    await seed(envDb);
    expect(await countPackageInstalls(envDb)).toEqual(EXPECTED);
  });

  it("orders ties by package name", async () => {
    await envDb
      .insertInto("environments")
      .values([
        { id: "1", status: "READY", packages: pkgs("@z/pkg") },
        { id: "2", status: "READY", packages: pkgs("@a/pkg") },
      ])
      .execute();
    expect(await countPackageInstalls(envDb)).toEqual([
      { packageName: "@a/pkg", environments: 1 },
      { packageName: "@z/pkg", environments: 1 },
    ]);
  });

  it("runs against the processor namespace schema (withSchema), not public", async () => {
    const root = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await sql`CREATE SCHEMA "vetra-cloud-environments"`.execute(root);
      const nsDb = root.withSchema("vetra-cloud-environments");
      await createEnvTable(nsDb);
      await seed(nsDb);
      // A decoy in public: reading it would surface @decoy/public.
      await createEnvTable(root);
      await root
        .insertInto("environments")
        .values({ id: "x", status: "READY", packages: pkgs("@decoy/public") })
        .execute();

      expect(await countPackageInstalls(nsDb)).toEqual(EXPECTED);
    } finally {
      await root.destroy();
    }
  });
});

describe("packageInstallCounts resolver", () => {
  it("is answered without an authenticated user and exposes counts only", async () => {
    const db = new Kysely<ObservabilityDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    const envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    try {
      await up(db);
      await createEnvTable(envDb);
      await seed(envDb);
      const resolvers = createResolvers(db, {
        prometheusUrl: "http://prometheus",
        lokiUrl: "http://loki",
        envDb,
        dispatch: vi.fn(async () => undefined),
      });
      const result = await resolvers.Query.packageInstallCounts(
        undefined,
        {},
        {},
      );
      expect(result).toEqual(EXPECTED);
      for (const entry of result) {
        expect(Object.keys(entry).sort()).toEqual([
          "environments",
          "packageName",
        ]);
      }
    } finally {
      await db.destroy();
      await envDb.destroy();
    }
  });
});
