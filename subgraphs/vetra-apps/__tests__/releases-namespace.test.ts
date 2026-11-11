import { describe, expect, it } from "vitest";
import { resolveNamespace } from "../releases/namespace.js";

const orgs = (o: string | null, p: string | null) => ({
  orgHandle: async () => o,
  personHandle: async () => p,
});
const personal = { owner_org_id: null, owner_address: "0x2BbEa0145d6fb9C6709a74C1179Ca0be71bb3aC6" };
const org = { owner_org_id: "org-7f3a9c1b2d", owner_address: personal.owner_address };

describe("resolveNamespace", () => {
  it("uses the org's handle for an org app", async () => {
    expect(await resolveNamespace(org, orgs("Sektar", "frank"))).toBe("sektar");
  });
  it("uses the owner's handle for a personal app", async () => {
    expect(await resolveNamespace(personal, orgs(null, "frank"))).toBe("frank");
  });
  it("falls back when there is no usable handle", async () => {
    expect(await resolveNamespace(personal, orgs(null, null))).toBe("u-2bbea014");
    expect(await resolveNamespace(personal, orgs(null, "Frank Ü"))).toBe("u-2bbea014");
    expect(await resolveNamespace(org, orgs(null, "frank"))).toBe("o-org7f3a9");
    expect(await resolveNamespace(personal, null)).toBe("u-2bbea014");
  });
});
