import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  APP_DID,
  makeHarness,
  member,
  MEMBER,
  ORG,
  owner,
  OWNER,
  seedActiveApp,
  stranger,
  STRANGER,
  type Harness,
} from "./harness.js";
import type { Caller } from "../auth.js";
import { appForOwner, updateApp } from "../service.js";
import { listAudit } from "../audit/repo.js";
import {
  appAccessFor,
  appRolesFor,
  MAX_ROLES_PER_APP,
  removeAppRole,
  setAppRole,
} from "../roles/service.js";

const ORG_ADMIN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const orgAdmin: Caller = {
  address: ORG_ADMIN,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};

let h: Harness;
let appId: string;
beforeEach(async () => {
  h = await makeHarness();
  appId = (await seedActiveApp(h)).id;
});
afterEach(async () => {
  await h.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e),
  );
const release = (c: Caller) =>
  code(appForOwner(h.deps, c, appId, { need: "release" }));
const moveToOrg = async () => {
  h.orgs.publishers.set(APP_DID, { orgId: ORG, address: null });
  await appForOwner(h.deps, admin, appId);
};

describe("release managers of a personal App", () => {
  it("the owner names one: they may release and view, not operate or name others", async () => {
    expect(await release(stranger)).toBe("FORBIDDEN");
    // Mixed case in, lowercased out.
    const r = await setAppRole(
      h.deps,
      owner,
      appId,
      `0x${STRANGER.slice(2).toUpperCase()}`,
      null,
    );
    expect(r).toMatchObject({
      appId,
      address: STRANGER,
      role: "release_manager",
      grantedBy: owner.address,
    });
    expect(await release(stranger)).toBe("OK");
    expect(
      await code(appForOwner(h.deps, stranger, appId, { need: "view" })),
    ).toBe("OK");
    expect(
      await code(updateApp(h.deps, stranger, appId, { name: "Nope" })),
    ).toBe("FORBIDDEN");
    expect(await code(setAppRole(h.deps, stranger, appId, MEMBER, null))).toBe(
      "FORBIDDEN",
    );
    expect(await appAccessFor(h.deps, stranger, appId)).toEqual({
      operate: false,
      release: true,
      administer: false,
      releaseManager: true,
    });
    expect(await appAccessFor(h.deps, owner, appId)).toEqual({
      operate: true,
      release: true,
      administer: true,
      releaseManager: false,
    });
    expect(
      (await appRolesFor(h.deps, stranger, appId)).map((x) => x.address),
    ).toEqual([STRANGER]);
    expect(await removeAppRole(h.deps, owner, appId, STRANGER, null)).toBe(
      true,
    );
    expect(await removeAppRole(h.deps, owner, appId, STRANGER, null)).toBe(
      false,
    );
    expect(await release(stranger)).toBe("FORBIDDEN");
  });

  it("checks the address and the role, is idempotent, and caps the holders", async () => {
    expect(await code(setAppRole(h.deps, owner, appId, "0x12", null))).toBe(
      "BAD_USER_INPUT",
    );
    expect(
      await code(setAppRole(h.deps, owner, appId, STRANGER, "owner")),
    ).toBe("BAD_USER_INPUT");
    const first = await setAppRole(
      h.deps,
      owner,
      appId,
      STRANGER,
      "release_manager",
    );
    expect(await setAppRole(h.deps, owner, appId, STRANGER, null)).toEqual(
      first,
    );
    for (let i = 1; i < MAX_ROLES_PER_APP; i++)
      await setAppRole(
        h.deps,
        owner,
        appId,
        `0x${i.toString(16).padStart(40, "0")}`,
        null,
      );
    expect(
      await code(setAppRole(h.deps, owner, appId, `0x${"f".repeat(40)}`, null)),
    ).toBe("BAD_USER_INPUT");
  });

  it("audits a grant and a removal, never a repeat", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await removeAppRole(h.deps, owner, appId, STRANGER, null);
    await removeAppRole(h.deps, owner, appId, STRANGER, null);
    const rows = await listAudit(h.db, appId, { limit: 10 });
    expect(rows.map((r) => [r.action, r.subject, r.actor, r.source])).toEqual([
      ["role.removed", `role:${STRANGER}`, owner.address, "api"],
      ["role.granted", `role:${STRANGER}`, owner.address, "api"],
    ]);
    expect(JSON.parse(rows[1].detail)).toEqual({
      address: STRANGER,
      role: "release_manager",
    });
  });

  it("lapses when the App changes hands", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await moveToOrg();
    h.orgs.join(ORG, STRANGER, "MEMBER");
    h.orgs.join(ORG, ORG_ADMIN, "ADMIN");
    expect(await release(stranger)).toBe("FORBIDDEN");
    expect(await appRolesFor(h.deps, orgAdmin, appId)).toEqual([]);
  });

  it("refuses the App's own identity address", async () => {
    const self = `0x${"9".repeat(40)}`;
    await h.db
      .updateTable("apps")
      .set({ identity_did: `did:pkh:eip155:1:${self}` })
      .where("id", "=", appId)
      .execute();
    expect(await code(setAppRole(h.deps, owner, appId, self, null))).toBe(
      "BAD_USER_INPUT",
    );
    expect(await appRolesFor(h.deps, owner, appId)).toEqual([]);
  });

  it("removing a grant of a previous owner is a no-op, not audited", async () => {
    await h.db
      .insertInto("app_roles")
      .values({
        app_id: appId,
        address: STRANGER,
        role: "release_manager",
        owner_scope: `org:${ORG}`,
        granted_by: OWNER,
        granted_at: "2026-01-01T00:00:00.000Z",
      })
      .execute();
    expect(await removeAppRole(h.deps, owner, appId, STRANGER, null)).toBe(
      false,
    );
    expect(await listAudit(h.db, appId, { limit: 10 })).toEqual([]);
  });

  it("stays lapsed when the App comes back to its first owner (A to B to A)", async () => {
    await setAppRole(h.deps, owner, appId, STRANGER, null);
    await moveToOrg();
    h.orgs.publishers.set(APP_DID, { orgId: null, address: OWNER });
    await appForOwner(h.deps, admin, appId);
    expect(
      await h.db
        .selectFrom("apps")
        .select(["owner_org_id", "owner_address"])
        .where("id", "=", appId)
        .executeTakeFirst(),
    ).toEqual({ owner_org_id: null, owner_address: OWNER });
    expect(await release(stranger)).toBe("FORBIDDEN");
    expect(await appRolesFor(h.deps, owner, appId)).toEqual([]);
    expect(await h.db.selectFrom("app_roles").selectAll().execute()).toEqual(
      [],
    );
  });
});

describe("release managers of an org App", () => {
  beforeEach(async () => {
    await moveToOrg();
    h.orgs.join(ORG, ORG_ADMIN, "ADMIN");
  });

  it("org OWNER/ADMIN and platform admins name them; a publisher or a non-member cannot", async () => {
    h.orgs.join(ORG, MEMBER, "PUBLISHER");
    expect(await code(setAppRole(h.deps, member, appId, STRANGER, null))).toBe(
      "FORBIDDEN",
    );
    expect(await code(setAppRole(h.deps, owner, appId, STRANGER, null))).toBe(
      "FORBIDDEN",
    );
    expect(await code(setAppRole(h.deps, orgAdmin, appId, MEMBER, null))).toBe(
      "OK",
    );
    expect(await code(setAppRole(h.deps, admin, appId, STRANGER, null))).toBe(
      "OK",
    );
  });

  it("a plain member with the role may release; without it, or after leaving the org, not", async () => {
    h.orgs.join(ORG, MEMBER, "MEMBER");
    expect(await release(member)).toBe("FORBIDDEN");
    await setAppRole(h.deps, orgAdmin, appId, MEMBER, null);
    expect(await release(member)).toBe("OK");
    expect(await code(appForOwner(h.deps, member, appId))).toBe("FORBIDDEN");
    h.orgs.members.delete(`${ORG}|${MEMBER}`);
    expect(await release(member)).toBe("FORBIDDEN");
  });

  it("gives an outsider with the role nothing", async () => {
    await setAppRole(h.deps, orgAdmin, appId, STRANGER, null);
    expect(await release(stranger)).toBe("FORBIDDEN");
    expect(
      await code(appForOwner(h.deps, stranger, appId, { need: "view" })),
    ).toBe("FORBIDDEN");
  });
});
