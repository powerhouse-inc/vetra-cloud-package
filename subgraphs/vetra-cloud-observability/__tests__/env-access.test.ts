import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { appDidLookup, createEnvAccess, OWNER_ONLY_ACCESS, parseOperators } from "../env-access.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
