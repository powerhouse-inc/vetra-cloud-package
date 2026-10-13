import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { appDidLookup, createEnvAccess, OWNER_ONLY_ACCESS, parseOperators, unresolvedAppDid } from "../env-access.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const DAVE = "0xdddddddddddddddddddddddddddddddddddddddd";
const bob = { address: BOB, isAdmin: false };

describe("env access", () => {
  it("checks an app-linked org env against the app's DID", async () => {
    const membership = vi.fn(async () => ({ role: "PUBLISHER" as const, effectiveScope: { all: false, appDids: ["did:key:shop"] } }));
    const appDidOf = vi.fn(async (id: string) => (id === "app-shop" ? "did:key:shop" : "did:key:blog"));
    const access = createEnvAccess({ orgs: { membership }, appDidOf });
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: "app-shop" })).toBe(true);
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: "app-blog" })).toBe(false);
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: null })).toBe(true);
    expect(appDidOf).toHaveBeenCalledTimes(2);
  });

  it("owner-only access knows no organisations", async () => {
    expect(await OWNER_ONLY_ACCESS.canOperate({ address: OWNER, isAdmin: false }, { owner: OWNER })).toBe(true);
    expect(await OWNER_ONLY_ACCESS.canOperate(bob, { owner: OWNER, ownerOrgId: "o1" })).toBe(false);
    expect(await OWNER_ONLY_ACCESS.isMember(bob, "o1")).toBe(false);
  });

  it("fails closed for org envs when Renown or the app lookup is down; personal envs need neither", async () => {
    const membership = vi.fn(async () => {
      throw new Error("renown down");
    });
    const appDidOf = vi.fn(async () => {
      throw new Error("db down");
    });
    const access = createEnvAccess({ orgs: { membership }, appDidOf });
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: null })).toBe(false);
    expect(await access.canView(bob, { owner: OWNER, ownerOrgId: "o1", appId: null })).toBe(false);
    expect(await access.isMember(bob, "o1")).toBe(false);
    expect(await access.canOperate(bob, { owner: OWNER, ownerOrgId: "o1", appId: "app-shop" })).toBe(false);
    expect(await access.canView(bob, { owner: OWNER, ownerOrgId: "o1", appId: "app-shop" })).toBe(false);
    membership.mockClear();
    appDidOf.mockClear();
    expect(await access.canOperate(bob, { owner: BOB, ownerOrgId: null, appId: "app-shop" })).toBe(true);
    expect(await access.canView(bob, { owner: BOB, appId: "app-shop" })).toBe(true);
    expect(await access.canOperate(bob, { owner: OWNER, appId: "app-shop" })).toBe(false);
    expect(membership).not.toHaveBeenCalled();
    expect(appDidOf).not.toHaveBeenCalled();
  });

  it("denies scoped publishers when a linked app cannot be resolved; admins of the org keep access", async () => {
    const roles: Record<string, { role: "OWNER" | "ADMIN" | "PUBLISHER"; effectiveScope: { all: boolean; appDids: string[] } }> = {
      [BOB]: { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:shop"] } },
      [CAROL]: { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } },
      [DAVE]: { role: "ADMIN", effectiveScope: { all: true, appDids: [] } },
    };
    const access = createEnvAccess({
      orgs: { membership: async (_o, address) => roles[address] ?? null },
      appDidOf: async () => null,
    });
    const env = { owner: OWNER, ownerOrgId: "o1", appId: "app-gone" };
    expect(await access.canOperate(bob, env)).toBe(false);
    expect(await access.canOperate({ address: CAROL, isAdmin: false }, env)).toBe(true);
    expect(await access.canOperate({ address: DAVE, isAdmin: false }, env)).toBe(true);
    expect(unresolvedAppDid("app-gone")).toBe("unresolved-app:app-gone");
  });

  it("isOrgAdmin: OWNER/ADMIN of the org or platform admin; publishers, outages and no-Renown are false", async () => {
    const roles: Record<string, "OWNER" | "ADMIN" | "PUBLISHER"> = { [OWNER]: "OWNER", [DAVE]: "ADMIN", [BOB]: "PUBLISHER" };
    const access = createEnvAccess({
      orgs: { membership: async (_o, address) => (roles[address] ? { role: roles[address], effectiveScope: { all: true, appDids: [] } } : null) },
      appDidOf: async () => null,
    });
    expect(await access.isOrgAdmin({ address: OWNER, isAdmin: false }, "o1")).toBe(true);
    expect(await access.isOrgAdmin({ address: DAVE, isAdmin: false }, "o1")).toBe(true);
    expect(await access.isOrgAdmin(bob, "o1")).toBe(false);
    expect(await access.isOrgAdmin({ address: CAROL, isAdmin: false }, "o1")).toBe(false);
    expect(await access.isOrgAdmin({ address: CAROL, isAdmin: true }, "o1")).toBe(true);
    const down = createEnvAccess({
      orgs: { membership: async () => { throw new Error("down"); } },
      appDidOf: async () => null,
    });
    expect(await down.isOrgAdmin({ address: OWNER, isAdmin: false }, "o1")).toBe(false);
    expect(await OWNER_ONLY_ACCESS.isOrgAdmin({ address: OWNER, isAdmin: false }, "o1")).toBe(false);
  });

  it("reads an app's identity DID from the vetra-apps namespace", async () => {
    const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) });
    await db.schema.createTable("apps").addColumn("id", "varchar(64)").addColumn("identity_did", "varchar(255)").execute();
    await db.insertInto("apps").values({ id: "app-1", identity_did: "did:key:one" }).execute();
    const lookup = appDidLookup(db);
    expect(await lookup("app-1")).toBe("did:key:one");
    expect(await lookup("nope")).toBeNull();
    await db.destroy();
  });

  it("parses the operators column defensively", () => {
    expect(parseOperators('["0xa","0xb"]')).toStrictEqual(["0xa", "0xb"]);
    expect(parseOperators(null)).toStrictEqual([]);
    expect(parseOperators("not json")).toStrictEqual([]);
    expect(parseOperators('{"a":1}')).toStrictEqual([]);
  });
});
