import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { ObservabilityDB } from "../db/schema.js";
import { createResolvers } from "../resolvers.js";
import { createEnvAccess } from "../env-access.js";
import { createRestartResolver } from "../restart.js";
import { createPackageRegistryResolver } from "../package-registry.js";
import { createDumpResolvers } from "../dumps/resolvers.js";
import { DumpsRepo } from "../dumps/repo.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const ADMIN = "0xdddddddddddddddddddddddddddddddddddddddd";
const members: Record<string, { role: "OWNER" | "ADMIN" | "PUBLISHER" | "MEMBER"; effectiveScope: { all: boolean; appDids: string[] } }> = {
  [`o1|${BOB}`]: { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } },
  [`o1|${CAROL}`]: { role: "MEMBER", effectiveScope: { all: false, appDids: [] } },
};
const access = createEnvAccess({
  orgs: { membership: async (orgId, address) => members[`${orgId}|${address}`] ?? null },
  appDidOf: async () => null,
});
/** Renown unreachable: every membership read throws. */
const renownDown = createEnvAccess({
  orgs: {
    membership: async () => {
      throw new Error("renown unavailable");
    },
  },
  appDidOf: async () => null,
});
const ctx = (address: string) => ({
  user: { address },
  isAdmin: (a: string) => a.toLowerCase() === ADMIN,
});

let db: Kysely<ObservabilityDB>;
let envDb: Kysely<any>;

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
    .addColumn("autoUpdateChannel", "varchar(64)")
    .addColumn("ownerOrgId", "varchar(255)")
    .addColumn("orgOperators", "text")
    .ifNotExists()
    .execute();
}

type EnvSeed = {
  id: string;
  owner?: string | null;
  appId?: string | null;
  ownerOrgId?: string | null;
  orgOperators?: string[];
};

async function seedEnv(env: EnvSeed): Promise<void> {
  await envDb
    .insertInto("environments")
    .values({
      id: env.id,
      name: env.id,
      subdomain: null,
      tenantId: `t-${env.id}`,
      customDomain: null,
      packages: null,
      services: null,
      status: "DRAFT",
      owner: env.owner ?? null,
      createdBy: null,
      studioInstanceId: null,
      appId: env.appId ?? null,
      appRole: null,
      prNumber: null,
      autoUpdateChannel: null,
      ownerOrgId: env.ownerOrgId ?? null,
      orgOperators: JSON.stringify(env.orgOperators ?? []),
    })
    .execute();
}

function resolvers(dispatch = vi.fn(async () => undefined), withAccess = access) {
  return createResolvers(db, { prometheusUrl: "http://p", lokiUrl: "http://l", envDb, dispatch, access: withAccess });
}

beforeEach(async () => {
  db = new Kysely<ObservabilityDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db);
  envDb = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
  await createEnvTable(envDb);
});

afterEach(async () => {
  await db.destroy();
  await envDb.destroy();
});

describe("myEnvironments ORG scope", () => {
  beforeEach(async () => {
    await seedEnv({ id: "personal", owner: OWNER });
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1", orgOperators: [BOB] });
    await seedEnv({ id: "other-org", owner: BOB, ownerOrgId: "o2", orgOperators: [BOB] });
  });

  it("MINE lists only personal environments, even for the creator of an org env", async () => {
    const rows = await resolvers().Query.myEnvironments(null, { scope: "MINE" }, ctx(OWNER));
    expect(rows.map((r: { id: string }) => r.id)).toStrictEqual(["personal"]);
    expect(rows[0]).toMatchObject({ ownerOrgId: null, orgOperators: [] });
  });

  it("ORG lists the org's environments for any member, with parsed operators", async () => {
    for (const who of [BOB, CAROL]) {
      const rows = await resolvers().Query.myEnvironments(null, { scope: "ORG", orgId: "o1" }, ctx(who));
      expect(rows.map((r: { id: string }) => r.id)).toStrictEqual(["org-env"]);
      expect(rows[0]).toMatchObject({ ownerOrgId: "o1", orgOperators: [BOB] });
    }
  });

  it("ORG refuses non-members (the creator included) and needs an orgId", async () => {
    await expect(resolvers().Query.myEnvironments(null, { scope: "ORG", orgId: "o1" }, ctx(OWNER))).rejects.toThrow("FORBIDDEN");
    await expect(resolvers().Query.myEnvironments(null, { scope: "ORG" }, ctx(BOB))).rejects.toThrow("ORG_ID_REQUIRED");
  });

  it("ORG fails closed when Renown is down; MINE keeps working", async () => {
    await expect(
      resolvers(undefined, renownDown).Query.myEnvironments(null, { scope: "ORG", orgId: "o1" }, ctx(BOB)),
    ).rejects.toThrow("FORBIDDEN");
    const rows = await resolvers(undefined, renownDown).Query.myEnvironments(null, { scope: "MINE" }, ctx(OWNER));
    expect(rows.map((r: { id: string }) => r.id)).toStrictEqual(["personal"]);
  });

  it("admins still see org envs under ALL and any org under ORG", async () => {
    const all = await resolvers().Query.myEnvironments(null, { scope: "ALL" }, ctx(ADMIN));
    expect(all.map((r: { id: string }) => r.id).sort()).toStrictEqual(["org-env", "other-org", "personal"]);
    const org = await resolvers(undefined, renownDown).Query.myEnvironments(null, { scope: "ORG", orgId: "o2" }, ctx(ADMIN));
    expect(org.map((r: { id: string }) => r.id)).toStrictEqual(["other-org"]);
  });
});

describe("owner checks on org environments", () => {
  beforeEach(async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1", orgOperators: [BOB] });
    await seedEnv({ id: "personal", owner: OWNER });
  });

  it("lets a publisher set the custom domain", async () => {
    const dispatch = vi.fn(async () => undefined);
    await resolvers(dispatch).Mutation.setCustomDomain(null, { documentId: "org-env", enabled: false }, ctx(BOB));
    expect(dispatch).toHaveBeenCalledWith("org-env", "SET_CUSTOM_DOMAIN", { enabled: false, domain: null });
  });

  it("refuses the creator of an org env who is no longer a publisher, and plain members", async () => {
    for (const who of [OWNER, CAROL]) {
      await expect(
        resolvers().Mutation.setCustomDomain(null, { documentId: "org-env", enabled: false }, ctx(who)),
      ).rejects.toThrow("FORBIDDEN");
    }
  });

  it("refuses non-publishers on release update and rollback; a publisher gets past the check", async () => {
    for (const who of [OWNER, CAROL]) {
      await expect(resolvers().Mutation.updateEnvironmentToLatest(null, { documentId: "org-env" }, ctx(who))).rejects.toThrow("FORBIDDEN");
      await expect(resolvers().Mutation.rollbackEnvironmentRelease(null, { documentId: "org-env" }, ctx(who))).rejects.toThrow("FORBIDDEN");
    }
    // Past the access check: no channel / no services.
    await expect(resolvers().Mutation.updateEnvironmentToLatest(null, { documentId: "org-env" }, ctx(BOB))).rejects.toThrow("NO_CHANNEL");
    await expect(resolvers().Mutation.rollbackEnvironmentRelease(null, { documentId: "org-env" }, ctx(BOB))).resolves.toStrictEqual({ updatedEnvironments: [] });
  });

  it("Renown outage: org env refused for the publisher, personal env unaffected", async () => {
    const dispatch = vi.fn(async () => undefined);
    const r = resolvers(dispatch, renownDown);
    await expect(r.Mutation.setCustomDomain(null, { documentId: "org-env", enabled: false }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    await r.Mutation.setCustomDomain(null, { documentId: "personal", enabled: false }, ctx(OWNER));
    expect(dispatch).toHaveBeenCalledWith("personal", "SET_CUSTOM_DOMAIN", { enabled: false, domain: null });
  });

  it("restart and package registry use the same rule", async () => {
    const k8s = { listDeploymentNames: vi.fn(async () => ["connect"]), restartDeployment: vi.fn(async () => undefined) };
    const restart = createRestartResolver({ envDb, k8s, access }).Mutation.restartEnvironmentService;
    await expect(restart(null, { tenantId: "t-org-env", service: "CONNECT" }, ctx(CAROL))).rejects.toThrow("FORBIDDEN");
    await expect(restart(null, { tenantId: "t-org-env", service: "CONNECT" }, ctx(BOB))).resolves.toMatchObject({ ok: true });
    const outage = createRestartResolver({ envDb, k8s, access: renownDown }).Mutation.restartEnvironmentService;
    await expect(outage(null, { tenantId: "t-org-env", service: "CONNECT" }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    await expect(outage(null, { tenantId: "t-personal", service: "CONNECT" }, ctx(OWNER))).resolves.toMatchObject({ ok: true });

    const dispatch = vi.fn(async () => undefined);
    const registry = createPackageRegistryResolver({ envDb, dispatch, access }).Mutation.setDefaultPackageRegistry;
    const url = "https://registry.vetra.io";
    await expect(registry(null, { tenantId: "t-org-env", registryUrl: url }, ctx(OWNER))).rejects.toThrow("FORBIDDEN");
    await expect(registry(null, { tenantId: "t-org-env", registryUrl: url }, ctx(BOB))).resolves.toMatchObject({ tenantId: "t-org-env" });
  });

  it("dumps: org publishers only, no admin bypass, fail closed on outage", async () => {
    const deps = {
      repo: new DumpsRepo(db),
      envDb,
      createJob: vi.fn(async () => "job"),
      deleteJob: vi.fn(async () => undefined),
      presign: vi.fn(async () => "https://signed"),
      image: "img",
      bucket: "b",
      s3Endpoint: "https://s3",
      s3AccessKey: "a",
      s3SecretKey: "s",
    };
    const list = createDumpResolvers({ ...deps, access }).Query.environmentDumps;
    await expect(list(null, { tenantId: "t-org-env" }, ctx(BOB))).resolves.toStrictEqual([]);
    for (const who of [OWNER, CAROL, ADMIN]) {
      await expect(list(null, { tenantId: "t-org-env" }, ctx(who))).rejects.toThrow("FORBIDDEN");
    }
    const outage = createDumpResolvers({ ...deps, access: renownDown }).Query.environmentDumps;
    await expect(outage(null, { tenantId: "t-org-env" }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    await expect(outage(null, { tenantId: "t-personal" }, ctx(OWNER))).resolves.toStrictEqual([]);
    await expect(outage(null, { tenantId: "t-personal" }, ctx(ADMIN))).rejects.toThrow("FORBIDDEN");
  });
});
