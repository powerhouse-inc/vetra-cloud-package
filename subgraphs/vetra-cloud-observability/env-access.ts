import type { Kysely } from "kysely";
import {
  canOperate,
  canView,
  isOrgMember,
  type AccessCaller,
  type MembershipReader,
} from "../../shared/org-access.js";

/** The environments-row fields access depends on. */
export interface EnvAccessRow {
  owner: string | null;
  ownerOrgId?: string | null;
  appId?: string | null;
}

export interface EnvAccess {
  canOperate(caller: AccessCaller, env: EnvAccessRow): Promise<boolean>;
  canView(caller: AccessCaller, env: EnvAccessRow): Promise<boolean>;
  isMember(caller: AccessCaller, orgId: string): Promise<boolean>;
}

/** Marker: an org env's app DID could not be read; access is then refused (admins aside). */
const APP_DID_UNKNOWN = Symbol("APP_DID_UNKNOWN");

export function createEnvAccess(deps: {
  orgs: MembershipReader | null;
  appDidOf(appId: string): Promise<string | null>;
}): EnvAccess {
  const resource = async (env: EnvAccessRow) => {
    let appDid: string | null = null;
    // The app DID only matters for org envs (publisher scope). A failed
    // lookup must not widen scope to "no app", so it refuses instead.
    if (env.ownerOrgId && env.appId) {
      try {
        appDid = await deps.appDidOf(env.appId);
      } catch {
        return APP_DID_UNKNOWN;
      }
    }
    return { owner: env.owner, ownerOrgId: env.ownerOrgId ?? null, appDid };
  };
  return {
    canOperate: async (caller, env) => {
      const r = await resource(env);
      if (r === APP_DID_UNKNOWN) return caller.isAdmin;
      return canOperate(deps.orgs, caller, r);
    },
    canView: async (caller, env) => {
      const r = await resource(env);
      if (r === APP_DID_UNKNOWN) return caller.isAdmin;
      return canView(deps.orgs, caller, r);
    },
    isMember: (caller, orgId) => isOrgMember(deps.orgs, caller, orgId),
  };
}

/** Default for hosts and tests without Renown: org environments are admin-only. */
export const OWNER_ONLY_ACCESS: EnvAccess = createEnvAccess({
  orgs: null,
  appDidOf: () => Promise.resolve(null),
});

/** apps.identity_did by apps.id in the vetra-apps namespace. */
export function appDidLookup(appsDb: Kysely<any>): (appId: string) => Promise<string | null> {
  return async (appId) => {
    const row = (await appsDb
      .selectFrom("apps")
      .select("identity_did")
      .where("id", "=", appId)
      .executeTakeFirst()) as { identity_did: string | null } | undefined;
    return row?.identity_did ?? null;
  };
}

/** The orgOperators column (JSON text) as a list; anything unexpected is []. */
export function parseOperators(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
