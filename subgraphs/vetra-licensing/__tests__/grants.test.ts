import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createGrantStore } from "../grants.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
let db: Kysely<VetraLicensingDB> | undefined;
const open = async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  return createGrantStore(db);
};
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

describe("grant store", () => {
  it("records provenance with kind, DID and the derived address, once", async () => {
    const g = await open();
    const row = { licenseId: "l1", appId: "a", kind: "pro", userDid: DID, issuedBy: "0xOwner", now: "t" };
    await g.recordGrant(row);
    await g.recordGrant(row);
    const rows = await db!.selectFrom("app_license_grants").selectAll().execute();
    expect(rows).toStrictEqual([{
      license_id: "l1", app_id: "a", license_type_id: "",
      user_address: "0x1111111111111111111111111111111111111111", issued_by: "0xowner",
      created_at: "t", kind: "pro", user_did: DID,
    }]);
    expect(await g.authorisedIds()).toStrictEqual(new Set(["l1"]));
    expect(await g.licenceIdsFor("a", DID)).toStrictEqual(["l1"]);
    expect(await g.licenceIdsFor(null, DID)).toStrictEqual(["l1"]);
    expect(await g.licenceIdsFor("b", DID)).toStrictEqual([]);
  });

  it("finds a legacy grant row by the holder's address", async () => {
    const g = await open();
    await db!.insertInto("app_license_grants").values({
      license_id: "legacy", app_id: "a", license_type_id: "type-1",
      user_address: "0x1111111111111111111111111111111111111111", issued_by: "0xowner",
      created_at: "t0", kind: null, user_did: null,
    }).execute();
    await g.recordGrant({ licenseId: "l2", appId: "a", kind: "pro", userDid: DID, issuedBy: "x", now: "t1" });
    expect(await g.licenceIdsFor("a", DID)).toStrictEqual(["legacy", "l2"]);
  });

  it("resolves chain roots; an unchained licence is its own root", async () => {
    const g = await open();
    await g.linkChain({ licenseId: "l1", rootLicenseId: "l1", appId: "a", label: "Project", now: "t" });
    await g.linkChain({ licenseId: "l2", rootLicenseId: "l1", appId: "a", label: null, now: "t" });
    expect(await g.chainRootOf("l2")).toBe("l1");
    expect(await g.chainRootOf("lx")).toBe("lx");
    expect(await g.chainLabel("l1")).toBe("Project");
    expect(await g.chainLabel("lx")).toBeNull();
    expect(await g.chainRoots()).toStrictEqual(new Map([["l1", "l1"], ["l2", "l1"]]));
  });

  it("manages the allow list idempotently", async () => {
    const g = await open();
    await g.addToAllowList("a", DID, "t1");
    await g.addToAllowList("a", DID, "t2");
    expect(await g.isOnAllowList("a", DID)).toBe(true);
    expect(await g.isOnAllowList("b", DID)).toBe(false);
    expect(await g.allowList("a")).toStrictEqual([{ user: DID, addedAt: "t1" }]);
    expect(await g.removeFromAllowList("a", DID)).toBe(true);
    expect(await g.removeFromAllowList("a", DID)).toBe(false);
    expect(await g.isOnAllowList("a", DID)).toBe(false);
  });
});
