import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appForOwner, myApps, updateApp } from "../service.js";
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
});
