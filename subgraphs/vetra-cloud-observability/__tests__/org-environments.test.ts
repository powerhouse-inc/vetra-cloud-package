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
import type { OrgSyncDeps } from "../org-sync.js";
import { SYSTEM_ONLY_OPERATIONS } from "../env-protection.js";
import { createReactorPermissions } from "./reactor-permissions.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const ADMIN = "0xdddddddddddddddddddddddddddddddddddddddd";
const DAVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const members: Record<string, { role: "OWNER" | "ADMIN" | "PUBLISHER" | "MEMBER"; effectiveScope: { all: boolean; appDids: string[] } }> = {
  [`o1|${BOB}`]: { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } },
  [`o1|${CAROL}`]: { role: "MEMBER", effectiveScope: { all: false, appDids: [] } },
  [`o1|${DAVE}`]: { role: "ADMIN", effectiveScope: { all: true, appDids: [] } },
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
  status?: string;
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
      status: env.status ?? "DRAFT",
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

  it("dumps: org OWNER/ADMIN only (full-scope publishers refused), no platform-admin bypass, fail closed on outage", async () => {
    const deps = {
      repo: new DumpsRepo(db),
      envDb,
      createJob: vi.fn(async () => "job"),
      deleteJob: vi.fn(async () => undefined),
      presign: vi.fn(async () => "https://signed"),
      deleteObject: vi.fn(async () => undefined),
      image: "img",
      bucket: "b",
      s3Endpoint: "https://s3",
      s3AccessKey: "a",
      s3SecretKey: "s",
    };
    const dumps = createDumpResolvers({ ...deps, access });
    const list = dumps.Query.environmentDumps;
    await expect(list(null, { tenantId: "t-org-env" }, ctx(DAVE))).resolves.toStrictEqual([]);
    for (const who of [BOB, OWNER, CAROL, ADMIN]) {
      await expect(list(null, { tenantId: "t-org-env" }, ctx(who))).rejects.toThrow("FORBIDDEN");
      await expect(dumps.Mutation.requestEnvironmentDump(null, { tenantId: "t-org-env" }, ctx(who))).rejects.toThrow("FORBIDDEN");
    }
    const dump = await dumps.Mutation.requestEnvironmentDump(null, { tenantId: "t-org-env" }, ctx(DAVE));
    expect(dump.status).toBe("PENDING");
    await expect(dumps.Mutation.cancelEnvironmentDump(null, { dumpId: dump.id }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    await expect(dumps.Mutation.cancelEnvironmentDump(null, { dumpId: dump.id }, ctx(DAVE))).resolves.toMatchObject({ status: "FAILED" });

    const outage = createDumpResolvers({ ...deps, access: renownDown }).Query.environmentDumps;
    await expect(outage(null, { tenantId: "t-org-env" }, ctx(DAVE))).rejects.toThrow("FORBIDDEN");
    await expect(outage(null, { tenantId: "t-personal" }, ctx(OWNER))).resolves.toStrictEqual([]);
    await expect(outage(null, { tenantId: "t-personal" }, ctx(ADMIN))).rejects.toThrow("FORBIDDEN");
  });
});

describe("syncEnvironmentOrg / setEnvironmentOrg", () => {
  let dispatch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dispatch = vi.fn(async () => undefined);
  });
  function resolversWithSync(extra: { orgSyncMinIntervalMs?: number; orgSync?: Partial<OrgSyncDeps> } = {}) {
    const orgSync: OrgSyncDeps = {
      envDb,
      db,
      orgs: { membership: async (o, a) => members[`${o}|${a}`] ?? null },
      appDidOf: async () => null,
      dispatch,
      perm: null,
      ...extra.orgSync,
    };
    return createResolvers(db, {
      prometheusUrl: "http://p",
      lokiUrl: "http://l",
      envDb,
      dispatch,
      access,
      orgSync,
      orgSyncMinIntervalMs: extra.orgSyncMinIntervalMs,
    });
  }

  it("syncs the caller in as operator and answers their access", async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1", orgOperators: [] });
    const out = await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB));
    expect(out).toStrictEqual({ environmentId: "org-env", ownerOrgId: "o1", canOperate: true, canView: true });
    expect(dispatch).toHaveBeenCalledWith("org-env", "SYNC_ORG_OPERATORS", { operators: [BOB] });
    const carol = await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(CAROL));
    expect(carol).toMatchObject({ canOperate: false, canView: true });
  });

  it("answers personal envs without touching Renown", async () => {
    await seedEnv({ id: "personal", owner: OWNER });
    expect(await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "personal" }, ctx(OWNER)))
      .toStrictEqual({ environmentId: "personal", ownerOrgId: null, canOperate: true, canView: true });
  });

  it("answers strangers with no access, and refuses unknown envs and anonymous callers", async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1" });
    const r = resolversWithSync().Mutation;
    expect(await r.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(OWNER)))
      .toStrictEqual({ environmentId: "org-env", ownerOrgId: "o1", canOperate: false, canView: false });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(r.syncEnvironmentOrg(null, { environmentId: "nope" }, ctx(BOB))).rejects.toThrow("ENV_NOT_FOUND");
    await expect(r.syncEnvironmentOrg(null, { environmentId: "org-env" }, {})).rejects.toThrow("UNAUTHENTICATED");
  });

  it("rate-limits the sync work per caller and environment, still answering access", async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1" });
    await seedEnv({ id: "org-env-2", owner: OWNER, ownerOrgId: "o1" });
    const r = resolversWithSync().Mutation;
    await r.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB));
    // dispatch is a no-op here, so the row still lacks BOB: only the limiter stops a second dispatch.
    const again = await r.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB));
    expect(again).toMatchObject({ canOperate: true, canView: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await r.syncEnvironmentOrg(null, { environmentId: "org-env-2" }, ctx(BOB));
    expect(dispatch).toHaveBeenCalledTimes(2);

    const unlimited = resolversWithSync({ orgSyncMinIntervalMs: 0 }).Mutation;
    await unlimited.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB));
    await unlimited.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB));
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("hands a personal env to an org for its owner when they publish there", async () => {
    await seedEnv({ id: "mine", owner: BOB });
    const out = await resolversWithSync().Mutation.setEnvironmentOrg(null, { environmentId: "mine", orgId: "o1" }, ctx(BOB));
    expect(out).toStrictEqual({ environmentId: "mine", ownerOrgId: "o1", canOperate: true, canView: true });
    expect(dispatch).toHaveBeenCalledWith("mine", "SET_OWNER_ORG", { ownerOrgId: "o1", operators: [BOB] });
  });

  it("m1: decides again on the document under the lock (read model lagging behind a hand-over)", async () => {
    await seedEnv({ id: "mine", owner: BOB });
    const doc = { owner: BOB as string | null, ownerOrgId: "o1" as string | null, orgOperators: [BOB] };
    const r = resolversWithSync({ orgSync: { readOrgState: async () => ({ ...doc }) } }).Mutation;
    await expect(r.setEnvironmentOrg(null, { environmentId: "mine", orgId: "o1" }, ctx(BOB))).rejects.toThrow("ALREADY_ORG_OWNED");
    doc.ownerOrgId = null;
    doc.owner = CAROL;
    await expect(r.setEnvironmentOrg(null, { environmentId: "mine", orgId: "o1" }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    const gone = resolversWithSync({ orgSync: { readOrgState: async () => null } }).Mutation;
    await expect(gone.setEnvironmentOrg(null, { environmentId: "mine", orgId: "o1" }, ctx(BOB))).rejects.toThrow("ENV_NOT_FOUND");
    expect(dispatch).not.toHaveBeenCalled();
    expect(await db.selectFrom("org_expected_handovers").selectAll().execute()).toStrictEqual([]);
  });

  it("m7: an unowned env answers canOperate for any signed-in caller (the first signed action claims it)", async () => {
    await seedEnv({ id: "fresh", owner: null });
    expect(await resolversWithSync().Mutation.syncEnvironmentOrg(null, { environmentId: "fresh" }, ctx(CAROL)))
      .toStrictEqual({ environmentId: "fresh", ownerOrgId: null, canOperate: true, canView: true });
  });

  it("withdraws the announcement when the hand-over dispatch fails", async () => {
    await seedEnv({ id: "mine", owner: BOB });
    dispatch.mockRejectedValueOnce(new Error("reactor down"));
    await expect(
      resolversWithSync().Mutation.setEnvironmentOrg(null, { environmentId: "mine", orgId: "o1" }, ctx(BOB)),
    ).rejects.toThrow("reactor down");
    const left = await db.selectFrom("org_expected_handovers").selectAll().where("documentId", "=", "mine").execute();
    expect(left).toStrictEqual([]);
  });

  it("refuses strangers, plain members, app envs and envs already in an org", async () => {
    await seedEnv({ id: "carols", owner: CAROL });
    await seedEnv({ id: "app-env", owner: BOB, appId: "app-1" });
    await seedEnv({ id: "org-env", owner: BOB, ownerOrgId: "o2" });
    const r = resolversWithSync().Mutation;
    await expect(r.setEnvironmentOrg(null, { environmentId: "carols", orgId: "o1" }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    await expect(r.setEnvironmentOrg(null, { environmentId: "carols", orgId: "o1" }, ctx(CAROL))).rejects.toThrow("FORBIDDEN");
    await expect(r.setEnvironmentOrg(null, { environmentId: "app-env", orgId: "o1" }, ctx(BOB))).rejects.toThrow("APP_ENVIRONMENT");
    await expect(r.setEnvironmentOrg(null, { environmentId: "org-env", orgId: "o1" }, ctx(BOB))).rejects.toThrow("ALREADY_ORG_OWNED");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("only the personal owner hands over: no platform-admin pull, no org-admin pull, fail closed on outage", async () => {
    await seedEnv({ id: "carols", owner: CAROL });
    await seedEnv({ id: "bobs", owner: BOB });
    const r = resolversWithSync().Mutation;
    // DAVE is ADMIN of o1, ADMIN is a platform admin: neither may pull CAROL's env in.
    await expect(r.setEnvironmentOrg(null, { environmentId: "carols", orgId: "o1" }, ctx(DAVE))).rejects.toThrow("FORBIDDEN");
    await expect(r.setEnvironmentOrg(null, { environmentId: "carols", orgId: "o1" }, ctx(ADMIN))).rejects.toThrow("FORBIDDEN");
    await expect(r.setEnvironmentOrg(null, { environmentId: "bobs", orgId: " " }, ctx(BOB))).rejects.toThrow("ORG_ID_REQUIRED");
    await expect(r.setEnvironmentOrg(null, { environmentId: "nope", orgId: "o1" }, ctx(BOB))).rejects.toThrow("ENV_NOT_FOUND");
    const down = createResolvers(db, { prometheusUrl: "http://p", lokiUrl: "http://l", envDb, dispatch, access: renownDown });
    await expect(down.Mutation.setEnvironmentOrg(null, { environmentId: "bobs", orgId: "o1" }, ctx(BOB))).rejects.toThrow("FORBIDDEN");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a sync that could not run answers canOperate only for existing operators, and frees the rate-limit slot", async () => {
    await seedEnv({ id: "org-env", owner: OWNER, ownerOrgId: "o1" });
    const outage = resolversWithSync({
      orgSync: {
        orgs: {
          membership: async () => {
            throw new Error("renown down");
          },
        },
      },
    }).Mutation;
    expect(await outage.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB)))
      .toMatchObject({ canOperate: false, canView: true });

    const r = resolversWithSync().Mutation;
    dispatch.mockImplementationOnce(async () => {
      throw new Error("reactor busy");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await r.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB)))
      .toMatchObject({ canOperate: false, canView: true });
    warn.mockRestore();
    // The failure did not consume the slot: the retry syncs straight away.
    expect(await r.syncEnvironmentOrg(null, { environmentId: "org-env" }, ctx(BOB)))
      .toMatchObject({ canOperate: true, canView: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("refuses to hand over a released environment", async () => {
    for (const status of ["TERMINATING", "DESTROYED", "ARCHIVED"]) {
      await seedEnv({ id: `gone-${status}`, owner: BOB, status });
      await expect(
        resolversWithSync().Mutation.setEnvironmentOrg(null, { environmentId: `gone-${status}`, orgId: "o1" }, ctx(BOB)),
      ).rejects.toThrow("ENV_NOT_ACTIVE");
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("hand-over protects at once: restricted before SET_OWNER_ORG, service-owned right after", async () => {
    const SERVICE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
    const reactor = await createReactorPermissions();
    try {
      await seedEnv({ id: "mine", owner: BOB });
      await reactor.real.initializeDocumentProtection("mine", BOB, true); // as the reconciler leaves it
      let restrictedAtDispatch: boolean[] = [];
      dispatch.mockImplementation(async () => {
        restrictedAtDispatch = await Promise.all(SYSTEM_ONLY_OPERATIONS.map((op) => reactor.real.isOperationRestricted("mine", op)));
      });
      await resolversWithSync({ orgSync: { perm: reactor.perm, serviceOwner: SERVICE } }).Mutation.setEnvironmentOrg(
        null,
        { environmentId: "mine", orgId: "o1" },
        ctx(BOB),
      );
      expect(restrictedAtDispatch).toStrictEqual(SYSTEM_ONLY_OPERATIONS.map(() => true));
      expect(await reactor.real.getDocumentOwner("mine")).toBe(SERVICE);
      // BOB is a publisher in o1: WRITE through Vetra, no ADMIN, no unsigned system operations.
      expect(await reactor.real.getUserPermission("mine", BOB)).toBe("WRITE");
      expect(await reactor.auth.canMutate("mine", "SET_OWNER_ORG", BOB)).toBe(false);
      expect(await reactor.auth.canMutate("mine", "SYNC_ORG_OPERATORS", BOB)).toBe(false);
    } finally {
      await reactor.db.destroy();
    }
  });
});
