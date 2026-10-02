import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";

const ME = "0xabc";

let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;

/** Minimal `environments` table including the columns myEnvironments reads. */
async function createEnvTable(database: Kysely<any>): Promise<void> {
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
    .addColumn("createdBy", "varchar(255)")
    .addColumn("studioInstanceId", "varchar(255)")
    .addColumn("appId", "varchar(255)")
    .addColumn("appRole", "varchar(32)")
    .addColumn("prNumber", "integer")
    .ifNotExists()
    .execute();
}

type EnvSeed = {
  id: string;
  subdomain?: string | null;
  owner?: string | null;
  studioInstanceId?: string | null;
  packages?: string | null;
  services?: string | null;
  appId?: string | null;
  appRole?: string | null;
  prNumber?: number | null;
};

async function seedEnv(env: EnvSeed): Promise<void> {
  await envDb
    .insertInto("environments")
    .values({
      id: env.id,
      name: env.id,
      subdomain: env.subdomain ?? null,
      tenantId: null,
      customDomain: null,
      packages: env.packages ?? null,
      services: env.services ?? null,
      status: "READY",
      owner: env.owner ?? null,
      createdBy: null,
      studioInstanceId: env.studioInstanceId ?? null,
      appId: env.appId ?? null,
      appRole: env.appRole ?? null,
      prNumber: env.prNumber ?? null,
    })
    .execute();
}

function makeResolvers() {
  return createResolvers(db, {
    prometheusUrl: "http://prometheus",
    lokiUrl: "http://loki",
    envDb,
    dispatch: vi.fn(async () => undefined),
  });
}

beforeEach(async () => {
  const obsPglite = new PGlite();
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(obsPglite) });
  await up(db);

  const envPglite = new PGlite();
  envDb = new Kysely<any>({ dialect: new PGliteDialect(envPglite) });
  await createEnvTable(envDb);
});

afterEach(async () => {
  await db.destroy();
  await envDb.destroy();
});

describe("myEnvironments", () => {
  it("exposes the App link (appId / appRole / prNumber), null for standalone envs", async () => {
    await seedEnv({ id: "standalone", owner: ME });
    await seedEnv({ id: "prod", owner: ME, appId: "app-1", appRole: "PRODUCTION" });
    await seedEnv({ id: "pr", owner: ME, appId: "app-1", appRole: "PREVIEW", prNumber: 42 });
    const resolvers = makeResolvers();
    const out = (await resolvers.Query.myEnvironments(
      null,
      { scope: "MINE" },
      { user: { address: ME } },
    )) as Array<{ id: string; appId: string | null; appRole: string | null; prNumber: number | null }>;
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId.standalone).toMatchObject({ appId: null, appRole: null, prNumber: null });
    expect(byId.prod).toMatchObject({ appId: "app-1", appRole: "PRODUCTION", prNumber: null });
    expect(byId.pr).toMatchObject({ appId: "app-1", appRole: "PREVIEW", prNumber: 42 });
  });

  it("returns [] when unauthenticated", async () => {
    const resolvers = makeResolvers();
    const out = await resolvers.Query.myEnvironments(null, { scope: "MINE" }, {});
    expect(out).toEqual([]);
  });

  it("returns studioInstanceId + parsed packages + services for an owned env", async () => {
    await seedEnv({
      id: "prod",
      subdomain: "breakfast-prod",
      owner: ME,
      studioInstanceId: "studio-breakfast",
      packages: JSON.stringify([
        { registry: "https://registry.dev.vetra.io", name: "@app/breakfast", version: "1.2.3" },
      ]),
      services: JSON.stringify([
        { type: "CONNECT", prefix: "connect", enabled: true },
        { type: "SWITCHBOARD", prefix: "switchboard", enabled: true },
      ]),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myEnvironments(
      null,
      { scope: "MINE" },
      { user: { address: ME } },
    );

    expect(out).toHaveLength(1);
    expect(out[0].studioInstanceId).toBe("studio-breakfast");
    expect(out[0].packages).toEqual([
      { registry: "https://registry.dev.vetra.io", name: "@app/breakfast", version: "1.2.3" },
    ]);
    expect(out[0].services).toEqual([
      { type: "CONNECT", prefix: "connect", enabled: true },
      { type: "SWITCHBOARD", prefix: "switchboard", enabled: true },
    ]);
  });

  it("yields null studioInstanceId + empty arrays for an unstamped env with no packages/services", async () => {
    await seedEnv({ id: "solo", subdomain: "solo", owner: ME });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myEnvironments(
      null,
      { scope: "MINE" },
      { user: { address: ME } },
    );

    expect(out).toHaveLength(1);
    expect(out[0].studioInstanceId).toBeNull();
    expect(out[0].packages).toEqual([]);
    expect(out[0].services).toEqual([]);
  });
});
