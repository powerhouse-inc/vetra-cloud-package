import type { Caller } from "../auth.js";
import type { AppRoleName } from "../db/schema.js";
import { appsError } from "../errors.js";
import { auditCaller } from "../audit/service.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { allows, isReleaseManager, ownerScopeOf } from "./access.js";
import {
  deleteAppRole,
  getAppRole,
  listAppRoles,
  upsertAppRole,
  type AppRoleRow,
} from "./repo.js";

export const APP_ROLE_NAMES: readonly AppRoleName[] = ["release_manager"];
export const MAX_ROLES_PER_APP = 50;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface AppRoleJson {
  appId: string;
  address: string;
  role: string;
  grantedBy: string;
  grantedAt: string;
}

const roleJson = (r: AppRoleRow): AppRoleJson => ({
  appId: r.app_id,
  address: r.address,
  role: r.role,
  grantedBy: r.granted_by,
  grantedAt: r.granted_at,
});

function parseRole(role: string | null | undefined): AppRoleName {
  const r = (role ?? "release_manager").trim().toLowerCase();
  if (!(APP_ROLE_NAMES as readonly string[]).includes(r))
    throw appsError(
      "BAD_USER_INPUT",
      `Unknown role ${String(role)}; known: ${APP_ROLE_NAMES.join(", ")}`,
    );
  return r as AppRoleName;
}

function parseAddress(a: string): string {
  const v = a.trim().toLowerCase();
  if (!ADDRESS.test(v))
    throw appsError(
      "BAD_USER_INPUT",
      "An address is 0x followed by 40 hex digits",
    );
  return v;
}

/** The App's role holders under its current owner. Anyone who may view the App. */
export async function appRolesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppRoleJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  return (await listAppRoles(deps.db, app.id, ownerScopeOf(app))).map(roleJson);
}

/** Names a release manager (owner, org OWNER/ADMIN). Idempotent. */
export async function setAppRole(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  address: string,
  role?: string | null,
): Promise<AppRoleJson> {
  const app = await loadAppForOwner(deps, caller, appId, {
    need: "administer",
  });
  const who = parseAddress(address);
  const name = parseRole(role);
  const scope = ownerScopeOf(app);
  const nowIso = deps.now().toISOString();
  return deps.db.transaction().execute(async (trx) => {
    // Count and write under the App row's lock (as setAppSetting does).
    await trx
      .selectFrom("apps")
      .select("id")
      .where("id", "=", app.id)
      .forUpdate()
      .execute();
    const existing = await getAppRole(trx, app.id, who, name);
    if (existing && existing.owner_scope === scope) return roleJson(existing);
    if ((await listAppRoles(trx, app.id, scope)).length >= MAX_ROLES_PER_APP)
      throw appsError(
        "BAD_USER_INPUT",
        `An App has at most ${MAX_ROLES_PER_APP} role holders; remove one first`,
      );
    const row = await upsertAppRole(trx, {
      app_id: app.id,
      address: who,
      role: name,
      owner_scope: scope,
      granted_by: caller.address,
      granted_at: nowIso,
    });
    await auditCaller(trx, caller, {
      appId: app.id,
      at: nowIso,
      action: "role.granted",
      subject: `role:${who}`,
      detail: { address: who, role: name },
    });
    return roleJson(row);
  });
}

/** Takes a role away (owner, org OWNER/ADMIN); false when there was none. */
export async function removeAppRole(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  address: string,
  role?: string | null,
): Promise<boolean> {
  const app = await loadAppForOwner(deps, caller, appId, {
    need: "administer",
  });
  const who = parseAddress(address);
  const name = parseRole(role);
  const nowIso = deps.now().toISOString();
  return deps.db.transaction().execute(async (trx) => {
    // A grant of a previous owner has no effect; removing it is a no-op.
    const removed = await deleteAppRole(
      trx,
      app.id,
      who,
      name,
      ownerScopeOf(app),
    );
    if (removed)
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "role.removed",
        subject: `role:${who}`,
        detail: { address: who, role: name },
      });
    return removed;
  });
}

export interface AppAccessJson {
  operate: boolean;
  release: boolean;
  administer: boolean;
  releaseManager: boolean;
}

/**
 * What the caller may do with the App, for the console to show the right
 * controls. A caller who may not view the App gets FORBIDDEN, not all-false;
 * the console treats that as no access.
 */
export async function appAccessFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppAccessJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  return {
    operate: await allows(deps, caller, app, "operate"),
    release: await allows(deps, caller, app, "release"),
    administer: await allows(deps, caller, app, "administer"),
    releaseManager: await isReleaseManager(deps, caller, app),
  };
}
