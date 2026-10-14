import type { OrgMembership, RenownOrgs } from "./renown-orgs.js";

export interface AccessCaller {
  /** Lowercased address. */
  address: string;
  isAdmin: boolean;
}

/** An environment or app: personal when ownerOrgId is null. */
export interface OwnedResource {
  owner: string | null;
  ownerOrgId?: string | null;
  /** Required on purpose: the app's Renown DID (publisher scope), or null when not linked to an app. */
  appDid: string | null;
  /**
   * Renown names another publisher than ownerOrgId (apps.org_disputed, for an
   * environment its linked app's): org members can neither operate nor view
   * it until reconciled. Personal owners and platform admins are unaffected.
   */
  orgDisputed?: boolean;
}

export type MembershipReader = Pick<RenownOrgs, "membership">;

/** OWNER/ADMIN always; PUBLISHER when the scope covers appDid (or there is no app). */
export function hasPublisherCapability(m: OrgMembership | null, appDid: string | null): boolean {
  if (!m) return false;
  if (m.role === "OWNER" || m.role === "ADMIN") return true;
  if (m.role !== "PUBLISHER") return false;
  return !appDid || m.effectiveScope.all || m.effectiveScope.appDids.includes(appDid);
}

/** The caller's membership, or null; a Renown failure is "no membership" (fail closed). */
async function membershipOf(
  orgs: MembershipReader | null,
  orgId: string,
  address: string,
): Promise<OrgMembership | null> {
  if (!orgs) return null;
  try {
    return await orgs.membership(orgId, address);
  } catch (err) {
    // Fail closed, but leave a trace: the organisation and the error's
    // name/code only (never the caller, never the message).
    const e = (err ?? {}) as { name?: unknown; code?: unknown };
    console.warn(
      `[org-access] Renown membership lookup failed for organisation ${orgId}: ` +
        `${typeof e.name === "string" ? e.name : "unknown error"}${typeof e.code === "string" ? ` (${e.code})` : ""}; refusing`,
    );
    return null;
  }
}

export async function canOperate(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  r: OwnedResource,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (!r.ownerOrgId) return !!r.owner && r.owner.toLowerCase() === caller.address.toLowerCase();
  if (r.orgDisputed) return false;
  return hasPublisherCapability(await membershipOf(orgs, r.ownerOrgId, caller.address), r.appDid);
}

export async function canView(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  r: OwnedResource,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  if (!r.ownerOrgId) return !!r.owner && r.owner.toLowerCase() === caller.address.toLowerCase();
  // A disputed organisation's claim is not trusted: its members see nothing.
  if (r.orgDisputed) return false;
  return (await membershipOf(orgs, r.ownerOrgId, caller.address)) !== null;
}

export async function isOrgMember(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  orgId: string,
): Promise<boolean> {
  if (caller.isAdmin) return true;
  return (await membershipOf(orgs, orgId, caller.address)) !== null;
}

/** Creating an app in an org: the new app's DID is not in anyone's list yet. */
export async function canCreateOrgApp(
  orgs: MembershipReader | null,
  caller: AccessCaller,
  orgId: string,
): Promise<boolean> {
  const m = await membershipOf(orgs, orgId, caller.address);
  if (!m) return false;
  return m.role === "OWNER" || m.role === "ADMIN" || (m.role === "PUBLISHER" && m.effectiveScope.all);
}
