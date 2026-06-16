import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";

const ME = "0xabc";
const OTHER = "0xdef";

/** Minimal subset of the processor's `environments` table for these tests. */
let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;

/** A CLINT studio service (vetra-cli) at the given prefix. */
function studioServices(prefix: string) {
  return JSON.stringify([
    {
      type: "CLINT",
      prefix,
      enabled: true,
      config: { package: { name: "vetra-cli" } },
    },
  ]);
}

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
    .addColumn("claimedBy", "varchar(255)")
    .addColumn("poolState", "varchar(64)")
    .ifNotExists()
    .execute();
}

type EnvSeed = {
  id: string;
  name?: string | null;
  subdomain?: string | null;
  services?: string | null;
  packages?: string | null;
  status?: string | null;
  owner?: string | null;
  claimedBy?: string | null;
};

async function seedEnv(env: EnvSeed): Promise<void> {
  await envDb
    .insertInto("environments")
    .values({
      id: env.id,
      name: env.name ?? null,
      subdomain: env.subdomain ?? null,
      tenantId: null,
      customDomain: null,
      packages: env.packages ?? null,
      services: env.services ?? null,
      status: env.status ?? "RUNNING",
      owner: env.owner ?? null,
      claimedBy: env.claimedBy ?? null,
      poolState: null,
    })
    .execute();
}

async function seedWebsiteEndpoint(
  documentId: string,
  prefix: string,
  status = "enabled",
): Promise<void> {
  await db
    .insertInto("clint_runtime_endpoints")
    .values({
      id: `${documentId}|${prefix}|website`,
      documentId,
      prefix,
      endpointId: "website",
      type: "website",
      port: "3000",
      status,
      lastSeen: new Date().toISOString(),
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

describe("myStudioProducts", () => {
  it("returns [] when unauthenticated", async () => {
    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(null, {}, {});
    expect(out).toEqual([]);
  });

  it("returns only envs owned by me — NOT owner-null pool envs (anti-leak)", async () => {
    await seedEnv({
      id: "mine",
      subdomain: "mine",
      owner: ME,
      services: studioServices("studio"),
    });
    await seedEnv({
      id: "pool",
      subdomain: "pool",
      owner: null,
      claimedBy: null,
      services: studioServices("studio"),
    });
    await seedEnv({
      id: "theirs",
      subdomain: "theirs",
      owner: OTHER,
      services: studioServices("studio"),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    expect(out.map((p: { envId: string }) => p.envId).sort()).toEqual(["mine"]);
  });

  it("includes a just-claimed env (owner=null, claimedBy=me) — anti-lag", async () => {
    await seedEnv({
      id: "claimed",
      subdomain: "claimed",
      owner: null,
      claimedBy: ME,
      services: studioServices("studio"),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    expect(out.map((p: { envId: string }) => p.envId)).toEqual(["claimed"]);
  });

  it("excludes terminal (TERMINATING) envs", async () => {
    await seedEnv({
      id: "terminating",
      subdomain: "terminating",
      owner: ME,
      status: "TERMINATING",
      services: studioServices("studio"),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    expect(out).toEqual([]);
  });

  it("excludes non-studio envs (no vetra-cli CLINT service)", async () => {
    await seedEnv({
      id: "non-studio",
      subdomain: "non-studio",
      owner: ME,
      services: JSON.stringify([
        { type: "CONNECT", prefix: "connect", enabled: true },
        {
          type: "CLINT",
          prefix: "other",
          enabled: true,
          config: { package: { name: "some-other-cli" } },
        },
      ]),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    expect(out).toEqual([]);
  });

  it("matches studio via packages array when config.package is absent", async () => {
    await seedEnv({
      id: "pkg-studio",
      subdomain: "pkg-studio",
      owner: ME,
      services: JSON.stringify([
        { type: "CLINT", prefix: "studio", enabled: true },
      ]),
      packages: JSON.stringify([{ name: "vetra-cli", version: "1.0.0" }]),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    expect(out.map((p: { envId: string }) => p.envId)).toEqual(["pkg-studio"]);
  });

  it("status='ready' when a website endpoint is enabled for the prefix, else 'booting'", async () => {
    await seedEnv({
      id: "ready-env",
      name: "Ready Studio",
      subdomain: "ready-env",
      owner: ME,
      services: studioServices("studio"),
    });
    await seedEnv({
      id: "booting-env",
      subdomain: "booting-env",
      owner: ME,
      services: studioServices("studio"),
    });
    // Endpoint announced for the ready env only.
    await seedWebsiteEndpoint("ready-env", "studio", "enabled");
    // A disabled website endpoint should NOT count as ready.
    await seedWebsiteEndpoint("booting-env", "studio", "disabled");

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["ready-env"].status).toBe("ready");
    expect(byId["ready-env"].label).toBe("Ready Studio");
    expect(byId["ready-env"].prefix).toBe("studio");
    expect(byId["booting-env"].status).toBe("booting");
    // label falls back to subdomain when name is null.
    expect(byId["booting-env"].label).toBe("booting-env");
  });
});
