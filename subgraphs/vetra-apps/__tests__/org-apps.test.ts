import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appDeploymentsFor,
  appForOwner,
  ciDeployApp,
  confirmAppIdentity,
  createApp,
  myApps,
  updateApp,
} from "../service.js";
import {
  createAppDocOwnerResolver,
  protectAppDocument,
  sweepAppDocumentProtection,
} from "../app-doc-protection.js";
import {
  ENV_RECONCILE_INTERVAL_MS,
  appDocumentRowOwner,
} from "../org-ownership.js";
import { getApp, type AppRow } from "../repo.js";
import {
  protectEnvironment,
  type EnvProtectionTarget,
} from "../../vetra-cloud-observability/env-protection.js";
import { createReactorPermissions } from "../../vetra-cloud-observability/__tests__/reactor-permissions.js";
import {
  setOwnerOrg,
  syncOrgOperators,
} from "../../../document-models/vetra-cloud-environment/v1/index.js";
import {
  APP_DID,
  INSTALLATION,
  MEMBER,
  ORG,
  OWNER,
  STRANGER,
  admin,
  ciIdentity,
  claim,
  deployAsCi,
  makeHarness,
  member,
  owner,
  seedActiveApp,
  stranger,
  type Harness,
} from "./harness.js";

let h: Harness;
let app: AppRow;
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) =>
      e.extensions?.code ?? String(e),
  );
/** The app as Renown would report it after a transfer into ORG. */
async function moveToOrg() {
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  return appForOwner(h.deps, admin, app.id);
}

beforeEach(async () => {
  h = await makeHarness();
  app = await seedActiveApp(h);
});
afterEach(async () => h.close());

describe("org-owned apps", () => {
  it("adopts an app transferred in at Renown and moves its envs to the org", async () => {
    h.orgs.join(ORG, MEMBER, "MEMBER");
    h.orgs.apps.set(ORG, [APP_DID]);
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    const listed = await myApps(h.deps, member, ORG);
    expect(listed.map((a) => [a.id, a.owner_org_id])).toStrictEqual([
      [app.id, ORG],
    ]);
    const env = await h.envs.getState(app.production_environment_id);
    expect(env).toMatchObject({
      owner: OWNER,
      ownerOrgId: ORG,
      orgOperators: [],
    });
    expect(await myApps(h.deps, owner)).toStrictEqual([]);
  });

  it("a publisher operates, a member only views, the creator and strangers neither", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "PUBLISHER", [APP_DID]);
    expect(
      await code(updateApp(h.deps, member, app.id, { name: "Renamed" })),
    ).toBe("OK");
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(
      await code(appForOwner(h.deps, member, app.id, { need: "view" })),
    ).toBe("OK");
    expect(
      await code(updateApp(h.deps, member, app.id, { name: "Nope" })),
    ).toBe("FORBIDDEN");
    expect(await code(updateApp(h.deps, owner, app.id, { name: "Nope" }))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(appForOwner(h.deps, stranger, app.id, { need: "view" })),
    ).toBe("FORBIDDEN");
    expect(
      await code(updateApp(h.deps, admin, app.id, { name: "By admin" })),
    ).toBe("OK");
  });

  it("a publisher scoped to other apps cannot operate it", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "PUBLISHER", ["did:key:other"]);
    expect(
      await code(updateApp(h.deps, member, app.id, { name: "Nope" })),
    ).toBe("FORBIDDEN");
  });

  it("myApps(orgId) is for members only", async () => {
    expect(await code(myApps(h.deps, stranger, ORG))).toBe("FORBIDDEN");
    expect(await code(myApps(h.deps, admin, ORG))).toBe("OK");
  });

  it("fails closed when Renown is unreachable, and keeps ownership when the publisher lookup fails", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "OWNER");
    h.orgs.down = true;
    expect(
      await code(updateApp(h.deps, member, app.id, { name: "Nope" })),
    ).toBe("FORBIDDEN");
    expect((await appForOwner(h.deps, admin, app.id)).owner_org_id).toBe(ORG);
    expect((await getApp(h.db, app.id))?.owner_org_id).toBe(ORG);
    expect(
      (await h.envs.getState(app.production_environment_id))?.ownerOrgId,
    ).toBe(ORG);
  });

  it("follows a transfer out to a person: row, env owner and org are moved", async () => {
    await moveToOrg();
    h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
    expect(
      await code(updateApp(h.deps, stranger, app.id, { name: "Mine now" })),
    ).toBe("OK");
    expect(await getApp(h.db, app.id)).toMatchObject({
      owner_address: STRANGER,
      owner_org_id: null,
    });
    expect(
      await h.envs.getState(app.production_environment_id),
    ).toMatchObject({ owner: STRANGER, ownerOrgId: null });
    expect(await code(updateApp(h.deps, owner, app.id, { name: "Nope" }))).toBe(
      "FORBIDDEN",
    );
  });

  it("never moves a personal app to another person", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
    expect((await appForOwner(h.deps, owner, app.id)).owner_address).toBe(
      OWNER,
    );
  });

  it("follows an org-to-org transfer", async () => {
    await moveToOrg();
    h.orgs.publishers.set(APP_DID, { orgId: "org-other", address: null });
    expect((await appForOwner(h.deps, admin, app.id)).owner_org_id).toBe(
      "org-other",
    );
    expect(
      (await h.envs.getState(app.production_environment_id))?.ownerOrgId,
    ).toBe("org-other");
  });

  it("announces every lazy move, so the observability protection keeps it (not reverted)", async () => {
    const SERVICE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
    const reactor = await createReactorPermissions([SERVICE]);
    const envId = app.production_environment_id;
    const readTarget = async (id: string): Promise<EnvProtectionTarget> => {
      const s = await h.envs.getState(id);
      return {
        id,
        owner: s?.owner ?? null,
        ownerOrgId: s?.ownerOrgId ?? null,
      };
    };
    const reverted: unknown[] = [];
    const opts = {
      serviceOwner: SERVICE,
      db: h.obsDb,
      readTarget,
      dispatch: async (id: string, type: string, input: unknown) => {
        reverted.push({ id, type, input });
      },
    };
    const protect = async () =>
      protectEnvironment(reactor.perm, await readTarget(envId), opts);
    try {
      expect(await protect()).toBe("PERSONAL");

      // person → org
      await moveToOrg();
      expect(await protect()).toBe("ORG");
      // org → org
      h.orgs.publishers.set(APP_DID, { orgId: "org-other", address: null });
      await appForOwner(h.deps, admin, app.id);
      expect(await protect()).toBe("ORG");
      // org → person
      h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
      await appForOwner(h.deps, admin, app.id);
      expect(await protect()).toBe("PERSONAL");
      expect(reverted).toStrictEqual([]);
      expect(
        await reactor.real.getDocumentProtection(envId),
      ).toMatchObject({ ownerAddress: STRANGER });

      // Control: an unannounced move is reverted.
      await h.envs.execute(envId, [
        setOwnerOrg({ ownerOrgId: ORG, operators: [] }),
      ]);
      expect(await protect()).toBe("REVERTED");
    } finally {
      await reactor.db.destroy();
    }
  });

  it("myApps(orgId) drops an app transferred out of the org at Renown", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect((await myApps(h.deps, member, ORG)).map((a) => a.id)).toStrictEqual([
      app.id,
    ]);
    h.orgs.publishers.set(APP_DID, { orgId: "org-other", address: null });
    expect(await myApps(h.deps, member, ORG)).toStrictEqual([]);
    expect((await getApp(h.db, app.id))?.owner_org_id).toBe("org-other");
  });

  it("myApps(orgId) is refused while Renown is down", async () => {
    h.orgs.join(ORG, MEMBER, "MEMBER");
    h.orgs.down = true;
    expect(await code(myApps(h.deps, member, ORG))).toBe("FORBIDDEN");
  });

  it("members view an org app's deployments; strangers do not", async () => {
    await moveToOrg();
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await code(appDeploymentsFor(h.deps, member, app.id, 10))).toBe(
      "OK",
    );
    expect(await code(appDeploymentsFor(h.deps, stranger, app.id, 10))).toBe(
      "FORBIDDEN",
    );
    expect(await code(appDeploymentsFor(h.deps, owner, app.id, 10))).toBe(
      "FORBIDDEN",
    );
  });

  it("racing reads move an app once", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    const [a, b, c] = await Promise.all([
      appForOwner(h.deps, admin, app.id),
      appForOwner(h.deps, admin, app.id),
      myApps(h.deps, owner),
    ]);
    expect([a.owner_org_id, b.owner_org_id, c]).toStrictEqual([ORG, ORG, []]);
    const moves = h.envs.executed.filter(
      (e) =>
        e.id === app.production_environment_id &&
        e.types.includes("SET_OWNER_ORG"),
    );
    expect(moves).toHaveLength(1);
  });

  it("without a hand-over store nothing is dispatched and the row stays (fail closed)", async () => {
    h.deps.orgHandoverDb = null;
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    const before = h.envs.executed.length;
    expect((await appForOwner(h.deps, admin, app.id)).owner_org_id).toBeNull();
    expect(h.envs.executed.length).toBe(before);
    expect((await getApp(h.db, app.id))?.owner_org_id).toBeNull();
    expect(
      (await h.envs.getState(app.production_environment_id))?.ownerOrgId ??
        null,
    ).toBeNull();
  });

  it("re-announces and re-makes a move the protection hook reverted", async () => {
    await moveToOrg();
    const envId = app.production_environment_id;
    // What the observability hook does to an unrecognised move.
    await h.envs.execute(envId, [
      setOwnerOrg({ ownerOrgId: null, operators: [] }),
    ]);
    expect((await appForOwner(h.deps, admin, app.id)).owner_org_id).toBe(ORG);
    expect((await h.envs.getState(envId))?.ownerOrgId).toBe(ORG);
    expect(
      await h.obsDb
        .selectFrom("org_expected_handovers")
        .select(["documentId", "orgId"])
        .where("documentId", "=", envId)
        .execute(),
    ).toStrictEqual([{ documentId: envId, orgId: ORG }]);
  });

  it("the personal list survives a failed sync of one app", async () => {
    h.orgs.appPublisher = async () => ({
      get orgId(): string | null {
        throw new Error("boom");
      },
      address: null,
    });
    expect((await myApps(h.deps, owner)).map((a) => a.id)).toStrictEqual([
      app.id,
    ]);
  });

  describe("app document protection follows ownership", () => {
    const SERVICE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
    let reactor: Awaited<ReturnType<typeof createReactorPermissions>>;
    beforeEach(async () => {
      reactor = await createReactorPermissions([SERVICE]);
      h.deps.serviceOwner = SERVICE;
      h.deps.protectAppDoc = (id, o) => protectAppDocument(reactor.perm, id, o);
      // As at creation: protected for the creator.
      await protectAppDocument(reactor.perm, app.id, OWNER);
    });
    afterEach(async () => reactor.db.destroy());
    const protection = () => reactor.real.getDocumentProtection(app.id);
    const grant = (who: string) => reactor.real.getUserPermission(app.id, who);

    it("person → org → org → person: service-owned while org-owned, the creator loses ADMIN", async () => {
      expect(await grant(OWNER)).toBe("ADMIN");
      await moveToOrg();
      expect(await protection()).toMatchObject({
        protected: true,
        ownerAddress: SERVICE,
      });
      expect(await grant(OWNER)).toBeNull();
      expect(await reactor.auth.canRead(app.id, OWNER)).toBe(false);

      h.orgs.publishers.set(APP_DID, { orgId: "org-other", address: null });
      await appForOwner(h.deps, admin, app.id);
      expect(await protection()).toMatchObject({ ownerAddress: SERVICE });

      h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
      await appForOwner(h.deps, admin, app.id);
      expect(await protection()).toMatchObject({
        protected: true,
        ownerAddress: STRANGER,
      });
      expect(await grant(STRANGER)).toBe("ADMIN");
      expect(await grant(SERVICE)).toBeNull();
      expect(await grant(OWNER)).toBeNull();
    });

    it("a failed re-protection leaves the row unchanged (retried on the next read)", async () => {
      h.deps.protectAppDoc = async () => {
        throw new Error("permissions down");
      };
      expect((await moveToOrg()).owner_org_id).toBeNull();
      expect((await getApp(h.db, app.id))?.owner_org_id).toBeNull();
      expect(await protection()).toMatchObject({ ownerAddress: OWNER });
    });

    it("the boot sweep protects org apps for the service and person → person for the new owner", async () => {
      const sweep = () =>
        sweepAppDocumentProtection({
          perm: reactor.perm,
          relationships: {
            getIncomingRelationships: async () => ({ results: [] }),
            removeRelationship: async () => undefined,
          },
          listAppDocumentIds: async () => [app.id],
          ownerFor: createAppDocOwnerResolver(
            appDocumentRowOwner(h.db, SERVICE),
            null,
          ),
          logger: { warn: () => undefined, info: () => undefined },
        });
      await h.db
        .updateTable("apps")
        .set({ owner_org_id: ORG })
        .where("id", "=", app.id)
        .execute();
      await sweep();
      expect(await protection()).toMatchObject({ ownerAddress: SERVICE });
      expect(await grant(OWNER)).toBeNull();

      await protectAppDocument(reactor.perm, app.id, OWNER);
      await h.db
        .updateTable("apps")
        .set({ owner_org_id: null, owner_address: STRANGER })
        .where("id", "=", app.id)
        .execute();
      await sweep();
      expect(await protection()).toMatchObject({ ownerAddress: STRANGER });
      expect(await grant(OWNER)).toBeNull();
    });
  });
});

describe("createApp in an organisation", () => {
  const input = {
    name: "Org Shop",
    installationId: INSTALLATION,
    repositoryId: "4343",
    orgId: ORG,
  };

  it("registers the workload for the org and hands the production env to it", async () => {
    h.orgs.join(ORG, OWNER, "PUBLISHER");
    const created = await createApp(h.deps, owner, input);
    expect(created.owner_org_id).toBe(ORG);
    expect(h.renown.registered.at(-1)).toMatchObject({
      ownerAddress: OWNER,
      ownerOrgId: ORG,
    });
    expect(
      await h.envs.getState(created.production_environment_id),
    ).toMatchObject({
      owner: OWNER,
      ownerOrgId: ORG,
      orgOperators: [OWNER],
    });
  });

  it("announces the hand-over of a new env, so the observability protection keeps it", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const created = await createApp(h.deps, owner, input);
    const SERVICE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
    const reactor = await createReactorPermissions([SERVICE]);
    try {
      const envId = created.production_environment_id;
      const s = await h.envs.getState(envId);
      const reverted: unknown[] = [];
      const result = await protectEnvironment(
        reactor.perm,
        { id: envId, owner: s?.owner ?? null, ownerOrgId: s?.ownerOrgId ?? null },
        {
          serviceOwner: SERVICE,
          db: h.obsDb,
          readTarget: async (id: string) => {
            const st = await h.envs.getState(id);
            return {
              id,
              owner: st?.owner ?? null,
              ownerOrgId: st?.ownerOrgId ?? null,
            };
          },
          dispatch: async (id: string, type: string, i: unknown) => {
            reverted.push({ id, type, i });
          },
        },
      );
      expect(result).toBe("ORG");
      expect(reverted).toStrictEqual([]);
    } finally {
      await reactor.db.destroy();
    }
  });

  it("refuses members, scoped publishers, admins outside the org, and a Renown outage", async () => {
    h.orgs.join(ORG, OWNER, "MEMBER");
    expect(await code(createApp(h.deps, owner, input))).toBe("FORBIDDEN");
    h.orgs.join(ORG, OWNER, "PUBLISHER", [APP_DID]);
    expect(await code(createApp(h.deps, owner, input))).toBe("FORBIDDEN");
    expect(await code(createApp(h.deps, admin, input))).toBe("FORBIDDEN");
    h.orgs.join(ORG, OWNER, "ADMIN");
    h.orgs.down = true;
    expect(await code(createApp(h.deps, owner, input))).toBe("FORBIDDEN");
    // A personal App is unaffected by the outage.
    expect(
      await code(createApp(h.deps, owner, { ...input, orgId: null })),
    ).toBe("OK");
  });

  it("attaches a personal env (handing it over) but refuses an env of another org", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const personal = await h.envs.seedStandalone(OWNER);
    const created = await createApp(h.deps, owner, {
      ...input,
      productionEnvironmentId: personal,
    });
    expect(await h.envs.getState(personal)).toMatchObject({
      ownerOrgId: ORG,
      orgOperators: [OWNER],
    });
    expect(created.production_environment_id).toBe(personal);
  });

  it("refuses to attach an org env to a personal app or to another org's app", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    h.orgs.join("org-other", OWNER, "ADMIN");
    const orgEnv = await h.envs.seedStandalone(OWNER);
    await h.envs.execute(orgEnv, [
      setOwnerOrg({ ownerOrgId: "org-other", operators: [OWNER] }),
    ]);
    expect(
      await code(
        createApp(h.deps, owner, { ...input, productionEnvironmentId: orgEnv }),
      ),
    ).toBe("BAD_USER_INPUT");
    expect(
      await code(
        createApp(h.deps, owner, {
          ...input,
          orgId: null,
          productionEnvironmentId: orgEnv,
        }),
      ),
    ).toBe("BAD_USER_INPUT");
  });

  it("attaches an env of the same org only for a publisher of it, without a second hand-over", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const orgEnv = await h.envs.seedStandalone(STRANGER);
    await h.envs.execute(orgEnv, [
      setOwnerOrg({ ownerOrgId: ORG, operators: [STRANGER] }),
    ]);
    const created = await createApp(h.deps, owner, {
      ...input,
      productionEnvironmentId: orgEnv,
    });
    expect(created.production_environment_id).toBe(orgEnv);
    expect(await h.envs.getState(orgEnv)).toMatchObject({
      ownerOrgId: ORG,
      orgOperators: [STRANGER],
    });
  });

  it("refuses a repository whose Renown identity is used by a live App of another owner, before any Harbor project (R2)", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const harborBefore = [...h.harbor.projects];
    // A legacy identity shared with the live personal App: never deleted.
    h.renown.identities.set("4343", {
      did: APP_DID,
      ownerOrgId: null,
      ownerAddress: OWNER,
    });
    expect(await code(createApp(h.deps, owner, input))).toBe("BAD_USER_INPUT");
    expect(h.renown.deleted).toStrictEqual([]);
    // Registered by someone else: Renown answers CONFLICT.
    h.renown.identities.set("4343", {
      did: "did:key:zOld",
      ownerOrgId: ORG,
      ownerAddress: STRANGER,
    });
    const err = await createApp(h.deps, owner, input).catch(
      (e: { message: string; extensions?: { code?: string } }) => e,
    );
    expect(err).toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    expect((err as Error).message).toMatch(/another owner/);
    expect(h.renown.deleted).toStrictEqual([]);
    expect(h.harbor.projects).toStrictEqual(harborBefore);
  });

  it("re-registers an orphaned identity of the caller registered for another owner (R2 self-heal)", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    // Left behind personally (e.g. by older code after a failed create).
    h.renown.identities.set("4343", {
      did: "did:key:zOld",
      ownerOrgId: null,
      ownerAddress: OWNER,
    });
    const created = await createApp(h.deps, owner, input);
    expect(h.renown.deleted).toStrictEqual(["did:key:zOld"]);
    expect(created.identity_did).not.toBe("did:key:zOld");
    expect(h.renown.identities.get("4343")).toMatchObject({ ownerOrgId: ORG });
    // And the other way round: an orphaned org identity for a personal App.
    await h.db.updateTable("apps").set({ status: "DELETED" }).where("id", "=", created.id).execute();
    const personal = await createApp(h.deps, owner, { ...input, orgId: null });
    expect(personal.owner_org_id).toBeNull();
    expect(h.renown.identities.get("4343")).toMatchObject({ ownerOrgId: null });
  });

  it("refuses when the re-registration still belongs to another owner", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    h.renown.identities.set("4343", {
      did: "did:key:zOld",
      ownerOrgId: null,
      ownerAddress: OWNER,
    });
    h.renown.deleteWorkloadIdentity = async () => undefined; // Renown kept it
    expect(await code(createApp(h.deps, owner, input))).toBe("BAD_USER_INPUT");
    expect(h.harbor.projects).toStrictEqual(["app-shop"]);
  });

  it("cleans up the Harbor project, robot and fresh identity when a later step fails, so a retry works", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const createPushRobot = h.harbor.createPushRobot;
    h.harbor.createPushRobot = async () => {
      throw new Error("harbor: create robot → 500");
    };
    expect(await code(createApp(h.deps, owner, input))).toMatch(/create robot/);
    expect(h.harbor.deletedProjects).toStrictEqual(["app-org-shop"]);
    expect(h.renown.identities.has("4343")).toBe(false);
    h.harbor.createPushRobot = createPushRobot;
    // The retry, personally, is not blocked by a leftover org identity.
    const personal = await createApp(h.deps, owner, { ...input, orgId: null });
    expect(personal.harbor_project).toBe("app-org-shop");
  });

  it("cleans up everything and withdraws the announcement when the env dispatch fails", async () => {
    h.orgs.join(ORG, OWNER, "ADMIN");
    const execute = h.envs.execute.bind(h.envs);
    h.envs.execute = async (id, actions) => {
      if (actions.some((a) => a.type === "SET_OWNER_ORG"))
        throw new Error("reactor down");
      return execute(id, actions);
    };
    expect(await code(createApp(h.deps, owner, input))).toMatch(/reactor down/);
    const rows = await h.db
      .selectFrom("apps")
      .select("id")
      .where("repository_id", "=", "4343")
      .execute();
    expect(rows).toStrictEqual([]);
    expect(h.harbor.deletedProjects).toStrictEqual(["app-org-shop"]);
    expect(h.harbor.deletedRobots).toHaveLength(1);
    expect(h.renown.identities.has("4343")).toBe(false);
    expect(
      await h.obsDb.selectFrom("org_expected_handovers").selectAll().execute(),
    ).toStrictEqual([]);
  });
});

describe("CI and identity for org apps", () => {
  it("accepts a CI token from a publisher of the app and refuses one from a removed member or the creator who left", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, app.id);
    h.envs.setStatus(app.production_environment_id, "READY");
    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    const memberCi = (c: ReturnType<typeof claim>) => ({
      ...ciIdentity(c),
      address: MEMBER,
    });
    const prod = {
      appId: app.id,
      kind: "PRODUCTION" as const,
      gitRef: "refs/heads/main",
      sha: "a".repeat(40),
      packages: [{ name: "@acme/shop", version: "1.0.0" }],
    };
    expect(
      await code(ciDeployApp(h.deps, memberCi(claim("refs/heads/main")), prod)),
    ).toBe("OK");
    h.orgs.members.clear();
    expect(
      await code(ciDeployApp(h.deps, memberCi(claim("refs/heads/main")), prod)),
    ).toBe("FORBIDDEN");
    expect(
      await code(ciDeployApp(h.deps, ciIdentity(claim("refs/heads/main")), prod)),
    ).toBe("FORBIDDEN");
  });

  it("CI sees a transfer at Renown on its own (lazy sync) and fails closed for org apps only", async () => {
    const prod = {
      appId: app.id,
      kind: "PRODUCTION" as const,
      gitRef: "refs/heads/main",
      sha: "a".repeat(40),
      packages: [{ name: "@acme/shop", version: "1.0.0" }],
    };
    h.envs.setStatus(app.production_environment_id, "READY");
    // Personal app: Renown down changes nothing.
    h.orgs.down = true;
    expect(
      await code(deployAsCi(h.deps, claim("refs/heads/main"), prod)),
    ).toBe("OK");
    h.orgs.down = false;
    // The sync path skips Renown for 30 s after a failure.
    h.clock.now = new Date(h.clock.now.getTime() + 31_000);
    // Moved into the org at Renown: the creator is no longer enough.
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    expect(
      await code(deployAsCi(h.deps, claim("refs/heads/main"), prod)),
    ).toBe("FORBIDDEN");
    h.orgs.join(ORG, OWNER, "PUBLISHER", [APP_DID]);
    expect(
      await code(deployAsCi(h.deps, claim("refs/heads/main"), prod)),
    ).toBe("OK");
    h.orgs.down = true;
    expect(
      await code(deployAsCi(h.deps, claim("refs/heads/main"), prod)),
    ).toBe("FORBIDDEN");
  });

  it("confirmAppIdentity on an org app uses the caller's delegation and only upgrades or extends", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    h.orgs.join(ORG, STRANGER, "PUBLISHER");
    h.orgs.join(ORG, OWNER, "PUBLISHER");
    const delegations: Record<string, string | null> = {
      [MEMBER]: "2028-01-01T00:00:00.000Z",
      [OWNER]: "2027-03-01T00:00:00.000Z",
    };
    const lookups: { address: string; did: string }[] = [];
    h.renown.getDelegation = async (i) => {
      lookups.push(i);
      const exp = delegations[i.address];
      return exp ? { expiresAt: exp } : null;
    };
    await h.db
      .updateTable("apps")
      .set({ status: "PENDING_IDENTITY", identity_expires_at: null })
      .where("id", "=", app.id)
      .execute();
    // No delegation of the caller: nothing changes.
    let row = await confirmAppIdentity(h.deps, stranger, app.id);
    expect(lookups.at(-1)).toMatchObject({ address: STRANGER, did: APP_DID });
    expect(row).toMatchObject({ status: "PENDING_IDENTITY", identity_expires_at: null });
    // A publisher who authorised it: upgraded.
    row = await confirmAppIdentity(h.deps, member, app.id);
    expect(lookups.at(-1)).toMatchObject({ address: MEMBER, did: APP_DID });
    expect(row).toMatchObject({
      status: "ACTIVE",
      identity_expires_at: "2028-01-01T00:00:00.000Z",
    });
    // Without a delegation, or with a shorter one: never downgraded or shortened.
    row = await confirmAppIdentity(h.deps, stranger, app.id);
    expect(row).toMatchObject({
      status: "ACTIVE",
      identity_expires_at: "2028-01-01T00:00:00.000Z",
    });
    row = await confirmAppIdentity(h.deps, owner, app.id);
    expect(row).toMatchObject({
      status: "ACTIVE",
      identity_expires_at: "2028-01-01T00:00:00.000Z",
    });
    // A longer one extends.
    delegations[STRANGER] = "2029-01-01T00:00:00.000Z";
    row = await confirmAppIdentity(h.deps, stranger, app.id);
    expect(row.identity_expires_at).toBe("2029-01-01T00:00:00.000Z");
  });

  it("confirmAppIdentity on a personal app still checks the owner's delegation when an admin confirms", async () => {
    const lookups: { address: string }[] = [];
    h.renown.getDelegation = async (i) => {
      lookups.push(i);
      return null;
    };
    const row = await confirmAppIdentity(h.deps, admin, app.id);
    expect(lookups.at(-1)).toMatchObject({ address: OWNER });
    expect(row.status).toBe("PENDING_IDENTITY");
  });
});

describe("previews of org apps", () => {
  it("copy the production env's organisation and operators", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, app.id);
    await h.envs.execute(app.production_environment_id, [
      syncOrgOperators({ operators: [MEMBER] }),
    ]);
    h.orgs.join(ORG, OWNER, "PUBLISHER"); // the CI token below is the creator's; org apps need capability
    h.envs.setStatus(app.production_environment_id, "READY");
    const d = await deployAsCi(
      h.deps,
      claim("refs/pull/7/merge", { prNumber: 7 }),
      {
        appId: app.id,
        kind: "PREVIEW",
        prNumber: 7,
        gitRef: "refs/pull/7/merge",
        sha: "a".repeat(40),
        packages: [{ name: "@acme/shop", version: "1.0.0-pr.7" }],
      },
    );
    expect(d.status).toBe("DEPLOYING");
    const envId = d.environment_id!;
    expect(await h.envs.getState(envId)).toMatchObject({
      ownerOrgId: ORG,
      orgOperators: [MEMBER],
    });
    // The hand-over was announced (and is still pending for the hook).
    const announced = await h.obsDb
      .selectFrom("org_expected_handovers")
      .selectAll()
      .where("documentId", "=", envId)
      .executeTakeFirst();
    expect(announced?.orgId).toBe(ORG);
  });

  it("a failed preview dispatch withdraws its announcement; no store evicts nothing", async () => {
    h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
    await appForOwner(h.deps, admin, app.id);
    h.orgs.join(ORG, OWNER, "PUBLISHER");
    h.envs.setStatus(app.production_environment_id, "READY");
    const execute = h.envs.execute.bind(h.envs);
    h.envs.execute = async (id, actions) => {
      if (actions.some((a) => a.type === "SET_OWNER_ORG"))
        throw new Error("reactor down");
      return execute(id, actions);
    };
    const pr = (n: number) => ({
      appId: app.id,
      kind: "PREVIEW" as const,
      prNumber: n,
      gitRef: `refs/pull/${n}/merge`,
      sha: "a".repeat(40),
      packages: [{ name: "@acme/shop", version: `1.0.0-pr.${n}` }],
    });
    const d = await deployAsCi(
      h.deps,
      claim("refs/pull/7/merge", { prNumber: 7 }),
      pr(7),
    );
    expect(d.status).toBe("FAILED");
    expect(
      await h.obsDb
        .selectFrom("org_expected_handovers")
        .selectAll()
        .where("documentId", "=", d.environment_id!)
        .execute(),
    ).toStrictEqual([]);
    // Without a hand-over store: refused before any preview is evicted.
    h.envs.execute = execute;
    await h.db.updateTable("apps").set({ preview_limit: 1 }).execute();
    h.deps.orgHandoverDb = null;
    expect(
      await code(
        deployAsCi(h.deps, claim("refs/pull/8/merge", { prNumber: 8 }), pr(8)),
      ),
    ).toBe("SERVICE_NOT_CONFIGURED");
    const previews = await h.db.selectFrom("app_previews").selectAll().execute();
    expect(previews.map((p) => p.pr_number)).toStrictEqual([7]);
  });
});

describe("transfers to a person reach their lists (I2)", () => {
  it("an org app transferred out to a person appears in the recipient's myApps", async () => {
    await moveToOrg();
    expect(await myApps(h.deps, stranger)).toStrictEqual([]);
    // Renown: the org transferred the app to STRANGER; nobody read it by id since.
    h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
    const listed = await myApps(h.deps, stranger);
    expect(listed.map((a) => [a.id, a.owner_address, a.owner_org_id])).toStrictEqual([
      [app.id, STRANGER, null],
    ]);
    expect(
      await h.envs.getState(app.production_environment_id),
    ).toMatchObject({ owner: STRANGER, ownerOrgId: null });
    // The org's list no longer has it.
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await myApps(h.deps, member, ORG)).toStrictEqual([]);
  });

  it("never takes another person's app, and a Renown outage leaves the list as it is", async () => {
    // Renown claims OWNER's personal app for STRANGER: not an org transfer, ignored.
    h.orgs.publishers.set(APP_DID, { orgId: null, address: STRANGER });
    expect(await myApps(h.deps, stranger)).toStrictEqual([]);
    expect((await getApp(h.db, app.id))?.owner_address).toBe(OWNER);
    h.orgs.down = true;
    expect((await myApps(h.deps, owner)).map((a) => a.id)).toStrictEqual([app.id]);
  });
});

describe("personal apps never wait on Renown (I3)", () => {
  const hang = () => new Promise<never>(() => {});

  it("a hanging Renown: personal myApps, app and CI answer promptly, and Renown is skipped afterwards", async () => {
    h.deps.renownSyncTimeoutMs = 100;
    const asked = { n: 0 };
    h.orgs.appPublisher = () => {
      asked.n++;
      return hang();
    };
    h.orgs.personApps = () => {
      asked.n++;
      return hang();
    };
    const started = Date.now();
    expect((await myApps(h.deps, owner)).map((a) => a.id)).toStrictEqual([app.id]);
    expect(Date.now() - started).toBeLessThan(1_000);
    const askedFirst = asked.n;
    expect(askedFirst).toBe(1);
    // Within the cool-down nothing waits on Renown and nothing asks it.
    expect((await appForOwner(h.deps, owner, app.id)).id).toBe(app.id);
    h.envs.setStatus(app.production_environment_id, "READY");
    expect(
      await code(
        deployAsCi(h.deps, claim("refs/heads/main"), {
          appId: app.id,
          kind: "PRODUCTION",
          gitRef: "refs/heads/main",
          sha: "a".repeat(40),
          packages: [{ name: "@acme/shop", version: "1.0.0" }],
        }),
      ),
    ).toBe("OK");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(asked.n).toBe(askedFirst);
  });

  it("an unchanged app has its envs reconciled at most once per interval", async () => {
    // A personal app with its own Renown profile (publisher = its owner).
    h.orgs.publishers.set(APP_DID, { orgId: null, address: OWNER });
    const reads = vi.spyOn(h.envs, "getState");
    await appForOwner(h.deps, owner, app.id);
    const first = reads.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await appForOwner(h.deps, owner, app.id);
    await myApps(h.deps, owner);
    expect(reads.mock.calls.length).toBe(first);
    h.clock.now = new Date(h.clock.now.getTime() + ENV_RECONCILE_INTERVAL_MS + 1);
    await appForOwner(h.deps, owner, app.id);
    expect(reads.mock.calls.length).toBeGreaterThan(first);
  });
});
