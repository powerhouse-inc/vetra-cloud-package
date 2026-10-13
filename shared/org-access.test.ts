import { describe, expect, it, vi } from "vitest";
import { canCreateOrgApp, canOperate, canView, hasPublisherCapability, isOrgMember } from "./org-access.js";
import { RenownOrgsUnavailableError, type OrgMembership } from "./renown-orgs.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const APP = "did:key:zApp";
const m = (role: OrgMembership["role"], all = true, appDids: string[] = []): OrgMembership => ({
  role,
  effectiveScope: { all, appDids },
});
const orgsWith = (membership: OrgMembership | null | Error) => ({
  membership: vi.fn(async () => {
    if (membership instanceof Error) throw membership;
    return membership;
  }),
});
const user = (address: string) => ({ address, isAdmin: false });
const admin = { address: BOB, isAdmin: true };

describe("hasPublisherCapability", () => {
  it("ranks roles and applies the app scope to publishers only", () => {
    expect(hasPublisherCapability(m("OWNER", false), APP)).toBe(true);
    expect(hasPublisherCapability(m("ADMIN", false), APP)).toBe(true);
    expect(hasPublisherCapability(m("PUBLISHER", true), APP)).toBe(true);
    expect(hasPublisherCapability(m("PUBLISHER", false, [APP]), APP)).toBe(true);
    expect(hasPublisherCapability(m("PUBLISHER", false, ["did:key:other"]), APP)).toBe(false);
    expect(hasPublisherCapability(m("PUBLISHER", false, []), null)).toBe(true);
    expect(hasPublisherCapability(m("MEMBER"), null)).toBe(false);
    expect(hasPublisherCapability(null, null)).toBe(false);
  });
});

describe("canOperate / canView", () => {
  it("personal resources: owner (any case) and admins; nobody asks Renown", async () => {
    const orgs = orgsWith(m("OWNER"));
    expect(await canOperate(orgs, user(OWNER), { owner: OWNER.toUpperCase().replace("0X", "0x"), ownerOrgId: null, appDid: null })).toBe(true);
    expect(await canOperate(orgs, user(BOB), { owner: OWNER, appDid: null })).toBe(false);
    expect(await canOperate(orgs, admin, { owner: OWNER, appDid: null })).toBe(true);
    expect(await canOperate(orgs, user(OWNER), { owner: null, appDid: null })).toBe(false);
    expect(await canView(orgs, user(OWNER), { owner: OWNER, appDid: null })).toBe(true);
    expect(orgs.membership).not.toHaveBeenCalled();
  });

  it("an app-linked org resource is never operable by a publisher scoped to other apps", async () => {
    const r = { owner: OWNER, ownerOrgId: "o1", appDid: APP };
    expect(await canOperate(orgsWith(m("PUBLISHER", false, ["did:key:other"])), user(BOB), r)).toBe(false);
  });

  it("org resources: publisher capability operates, any member views, the creator gets nothing for being the owner", async () => {
    const r = { owner: OWNER, ownerOrgId: "o1", appDid: APP };
    expect(await canOperate(orgsWith(m("PUBLISHER", false, [APP])), user(BOB), r)).toBe(true);
    expect(await canOperate(orgsWith(m("MEMBER")), user(BOB), r)).toBe(false);
    expect(await canView(orgsWith(m("MEMBER")), user(BOB), r)).toBe(true);
    expect(await canOperate(orgsWith(null), user(OWNER), r)).toBe(false);
    expect(await canView(orgsWith(null), user(OWNER), r)).toBe(false);
    expect(await canOperate(orgsWith(null), admin, r)).toBe(true);
  });

  it("fails closed when Renown is unreachable or not configured", async () => {
    const r = { owner: OWNER, ownerOrgId: "o1", appDid: null };
    const down = orgsWith(new RenownOrgsUnavailableError("down"));
    expect(await canOperate(down, user(BOB), r)).toBe(false);
    expect(await canView(down, user(BOB), r)).toBe(false);
    expect(await canOperate(null, user(BOB), r)).toBe(false);
    expect(await isOrgMember(down, user(BOB), "o1")).toBe(false);
    expect(await isOrgMember(down, admin, "o1")).toBe(true);
  });
});

describe("canCreateOrgApp", () => {
  it("needs OWNER/ADMIN or a publisher with access to all apps; admins get no bypass", async () => {
    expect(await canCreateOrgApp(orgsWith(m("ADMIN", false)), user(BOB), "o1")).toBe(true);
    expect(await canCreateOrgApp(orgsWith(m("PUBLISHER", true)), user(BOB), "o1")).toBe(true);
    expect(await canCreateOrgApp(orgsWith(m("PUBLISHER", false, [APP])), user(BOB), "o1")).toBe(false);
    expect(await canCreateOrgApp(orgsWith(m("MEMBER")), user(BOB), "o1")).toBe(false);
    expect(await canCreateOrgApp(orgsWith(null), admin, "o1")).toBe(false);
  });
});
