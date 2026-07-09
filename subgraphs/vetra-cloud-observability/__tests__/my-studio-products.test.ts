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
    .addColumn("claimedAt", "varchar(64)")
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
  claimedAt?: string | null;
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
      claimedAt: env.claimedAt ?? null,
      poolState: null,
    })
    .execute();
}

async function seedWebsiteEndpoint(
  documentId: string,
  prefix: string,
  status = "enabled",
  lastSeen: string = new Date().toISOString(),
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
      lastSeen,
    })
    .execute();
}

async function seedBrand(
  documentId: string,
  name: string | null,
  maxim: string | null = null,
  concept: string | null = null,
): Promise<void> {
  await db
    .insertInto("studio_brand")
    .values({
      documentId,
      subdomain: null,
      name,
      maxim,
      concept,
      updatedAt: new Date().toISOString(),
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

  it("status='sleeping' for a STOPPED (housekeeping-hibernated) studio", async () => {
    await seedEnv({
      id: "asleep-env",
      name: "Sleepy Studio",
      subdomain: "asleep-env",
      owner: ME,
      status: "STOPPED",
      services: studioServices("studio"),
    });
    // A stale pre-sleep website endpoint must not make it look ready/booting.
    await seedWebsiteEndpoint("asleep-env", "studio", "enabled");

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["asleep-env"].status).toBe("sleeping");
  });

  it("just-claimed env with a STALE pre-claim website announcement is 'booting'", async () => {
    // The warm-pool pod announced its website endpoint BEFORE the claim, then
    // restarts on claim (Reloader picks up new ADMINS+key). The pre-claim
    // announcement's lastSeen is older than claimedAt, so the env is NOT ready.
    const claimedAt = new Date().toISOString();
    const staleLastSeen = new Date(Date.now() - 60_000).toISOString();
    await seedEnv({
      id: "just-claimed",
      subdomain: "just-claimed",
      owner: null,
      claimedBy: ME,
      claimedAt,
      services: studioServices("studio"),
    });
    await seedWebsiteEndpoint("just-claimed", "studio", "enabled", staleLastSeen);

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["just-claimed"].status).toBe("booting");
  });

  it("claimed env whose endpoint lastSeen is AFTER claimedAt is 'ready'", async () => {
    const claimedAt = new Date(Date.now() - 60_000).toISOString();
    const freshLastSeen = new Date().toISOString();
    await seedEnv({
      id: "reannounced",
      subdomain: "reannounced",
      owner: ME,
      claimedBy: ME,
      claimedAt,
      services: studioServices("studio"),
    });
    await seedWebsiteEndpoint("reannounced", "studio", "enabled", freshLastSeen);

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["reannounced"].status).toBe("ready");
  });

  it("never-claimed env (claimedAt null) with an enabled website is 'ready'", async () => {
    // Cold-created envs were never warm-pool pods, so there's no stale
    // pre-claim announcement to worry about — keep the original rule.
    await seedEnv({
      id: "cold",
      subdomain: "cold",
      owner: ME,
      claimedAt: null,
      services: studioServices("studio"),
    });
    await seedWebsiteEndpoint("cold", "studio", "enabled");

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["cold"].status).toBe("ready");
  });

  it("attaches the cached brand when a studio_brand row exists", async () => {
    await seedEnv({
      id: "branded",
      name: "Vetra Studio",
      subdomain: "branded",
      owner: ME,
      services: studioServices("studio"),
    });
    await seedBrand(
      "branded",
      "Hotel Breakfast App",
      "Plan the perfect morning service",
      "A longer concept blurb",
    );

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["branded"].brand).toEqual({
      title: "Hotel Breakfast App",
      tagline: "Plan the perfect morning service",
      description: "A longer concept blurb",
    });
  });

  it("brand is null when no studio_brand row exists", async () => {
    await seedEnv({
      id: "unbranded",
      subdomain: "unbranded",
      owner: ME,
      services: studioServices("studio"),
    });

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["unbranded"].brand).toBeNull();
  });

  it("brand is null when the cached row has an empty name", async () => {
    await seedEnv({
      id: "empty-brand",
      subdomain: "empty-brand",
      owner: ME,
      services: studioServices("studio"),
    });
    await seedBrand("empty-brand", null);

    const resolvers = makeResolvers();
    const out = await resolvers.Query.myStudioProducts(
      null,
      {},
      { user: { address: ME } },
    );
    const byId = Object.fromEntries(
      out.map((p: { envId: string }) => [p.envId, p]),
    );
    expect(byId["empty-brand"].brand).toBeNull();
  });
});
