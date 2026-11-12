import {
  canAdminister,
  canOperate,
  canView,
} from "../../../shared/org-access.js";
import type { Caller } from "../auth.js";
import { appResource, callerAccess } from "../org-ownership.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { hasAppRole } from "./repo.js";

/** What a caller needs to do with an App (loadAppForOwner). */
export type AppNeed = "view" | "operate" | "release" | "administer";

/** The owner a grant is made under: a role from a previous owner has no effect. */
export const ownerScopeOf = (
  app: Pick<AppRow, "owner_org_id" | "owner_address">,
): string =>
  app.owner_org_id
    ? `org:${app.owner_org_id}`
    : `user:${app.owner_address.toLowerCase()}`;

/**
 * A release manager in effect (spec section 10, D7): granted under the App's
 * current owner and, for an org App, still a member of a non-disputed org.
 */
export async function isReleaseManager(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
): Promise<boolean> {
  if (
    !(await hasAppRole(
      deps.db,
      app.id,
      caller.address,
      "release_manager",
      ownerScopeOf(app),
    ))
  )
    return false;
  if (!app.owner_org_id) return true;
  return canView(deps.orgs ?? null, callerAccess(caller), appResource(app));
}

/** Plans, settings, (slice 3) rollouts: the App's operators or its release managers. */
export async function canRelease(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
): Promise<boolean> {
  return (
    (await canOperate(
      deps.orgs ?? null,
      callerAccess(caller),
      appResource(app),
    )) || (await isReleaseManager(deps, caller, app))
  );
}

export async function allows(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
  need: AppNeed,
): Promise<boolean> {
  const orgs = deps.orgs ?? null;
  const who = callerAccess(caller);
  const r = appResource(app);
  switch (need) {
    case "view":
      return (
        (await canView(orgs, who, r)) ||
        (await isReleaseManager(deps, caller, app))
      );
    case "operate":
      return canOperate(orgs, who, r);
    case "release":
      return canRelease(deps, caller, app);
    case "administer":
      return canAdminister(orgs, who, r);
  }
}
