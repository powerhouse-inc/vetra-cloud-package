import { normaliseUserDid } from "../did.js";
import type { GrantStore } from "../grants.js";
import { issueLicense, type IssueDeps } from "../issue.js";
import {
  NotOnAllowListError,
  UnknownLicenseError,
} from "../publisher-errors.js";

export { NotOnAllowListError };

export interface PublisherGrantDeps extends IssueDeps {
  grants: IssueDeps["grants"] & Pick<GrantStore, "isOnAllowList">;
}

/**
 * PublisherGrantIssuer: an app's owner gives a holder on the allow list a
 * licence of one of the app's terms. The caller's ownership of the app is
 * checked by the resolver (resolveOwnerApp); issueLicense checks the app is
 * trusted and the term is issuable by PUBLISHER_GRANT.
 */
export async function grantLicense(
  deps: PublisherGrantDeps,
  input: {
    appId: string;
    kind: string;
    user: string;
    issuedBy: string;
    label: string | null;
    now: string;
  },
): Promise<string> {
  const user = normaliseUserDid(input.user);
  if (!(await deps.grants.isOnAllowList(input.appId, user))) {
    throw new NotOnAllowListError(`${user} is not on the allow list for app ${input.appId}`);
  }
  const issued = await issueLicense(deps, {
    appId: input.appId,
    user,
    kind: input.kind,
    issuer: "PUBLISHER_GRANT",
    details: { grantedBy: input.issuedBy.toLowerCase() },
    issuedBy: input.issuedBy,
    label: input.label,
    now: input.now,
  });
  return issued.licenseId;
}

/**
 * Upgrade/downgrade a holder in place: same chain, same environment.
 * `appId` and `user` are the licence's grant row's, read by the resolver. They
 * are never taken from the licence document, which is not system-write-only:
 * issueLicense checks both against the grant row again, and refuses a
 * document that names another app or holder exactly like a missing licence.
 */
export async function replaceGrant(
  deps: PublisherGrantDeps,
  input: { appId: string; user: string; licenseId: string; kind: string; issuedBy: string; now: string },
): Promise<string> {
  const previous = await deps.licence(input.licenseId);
  if (!previous) throw new UnknownLicenseError();
  const issued = await issueLicense(deps, {
    appId: input.appId,
    user: input.user,
    kind: input.kind,
    issuer: "PUBLISHER_GRANT",
    details: { grantedBy: input.issuedBy.toLowerCase(), replaces: previous.id },
    issuedBy: input.issuedBy,
    upgrades: previous.id,
    now: input.now,
  });
  return issued.licenseId;
}
