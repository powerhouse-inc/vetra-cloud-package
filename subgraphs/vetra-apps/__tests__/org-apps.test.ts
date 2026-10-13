import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appDeploymentsFor,
  appForOwner,
  myApps,
  updateApp,
} from "../service.js";
import {
  createAppDocOwnerResolver,
  protectAppDocument,
  sweepAppDocumentProtection,
} from "../app-doc-protection.js";
import { appDocumentRowOwner } from "../org-ownership.js";
import { getApp, type AppRow } from "../repo.js";
import {
  protectEnvironment,
  type EnvProtectionTarget,
} from "../../vetra-cloud-observability/env-protection.js";
import { createReactorPermissions } from "../../vetra-cloud-observability/__tests__/reactor-permissions.js";
import { setOwnerOrg } from "../../../document-models/vetra-cloud-environment/v1/index.js";
import {
  APP_DID,
  MEMBER,
  ORG,
  OWNER,
  STRANGER,
  admin,
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
