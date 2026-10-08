import type { GrantRow, GrantStore } from "./grants.js";
import type { LifecycleStore } from "./lifecycle.js";
import type { LicenceRecord, LicenseReads } from "./reads.js";
import type { LicenseStatusName } from "./transitions.js";

/**
 * A licence as the system authorised and recorded it. App, holder and kind
 * are the grant row's (`app`/`appId`, `user`/`userDid`, `kind`); status, end
 * and successor are the lifecycle record's (the document's only for a licence
 * from before the record existed). Every other field is the document's and
 * is for display only.
 */
export interface AuthorisedLicence extends LicenceRecord {
  appId: string;
  userDid: string;
  /**
   * When the licence stopped being live: the recorded moment of its last
   * status change for a terminal licence (its document end when unrecorded);
   * null while ISSUED or ACTIVE.
   */
  endedAt: string | null;
}

export interface AuthorisedLicenceDeps {
  licences: Pick<LicenseReads, "licenceRecords">;
  lifecycle: Pick<LifecycleStore, "entries">;
}

const STATUSES: readonly LicenseStatusName[] = ["ISSUED", "ACTIVE", "EXPIRED", "REVOKED", "REPLACED"];
const LIVE = new Set<string>(["ISSUED", "ACTIVE"]);

export function isLive(status: string): boolean {
  return LIVE.has(status);
}

/**
 * The licences behind these grant rows, in the rows' order. A grant whose
 * document is missing or unreadable is skipped. Nothing here trusts the
 * document's `app`, `user`, `kind`, `status` or `end` over the DB.
 */
export async function authorisedLicences(
  deps: AuthorisedLicenceDeps,
  grants: GrantRow[],
): Promise<AuthorisedLicence[]> {
  const ids = grants.map((g) => g.licenseId);
  const [docs, lifecycle] = await Promise.all([
    deps.licences.licenceRecords(ids),
    deps.lifecycle.entries(ids),
  ]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  return grants.flatMap((g): AuthorisedLicence[] => {
    const doc = byId.get(g.licenseId);
    if (!doc) return [];
    const rec = lifecycle.get(g.licenseId);
    const status = STATUSES.find((s) => s === rec?.status) ?? doc.status;
    return [{
      ...doc,
      app: g.appId,
      appId: g.appId,
      user: g.userDid,
      userDid: g.userDid,
      kind: g.kind ?? doc.kind,
      status,
      end: rec ? rec.endAt : doc.end,
      replacedBy: status === "REPLACED" ? (rec?.replacedBy ?? doc.replacedBy) : null,
      endedAt: isLive(status) ? null : (rec?.updatedAt ?? doc.end),
    }];
  });
}

/**
 * A holder's licences of one app (every app when `appId` is null), from the
 * holder's grant rows, oldest first.
 */
export function createHolderLicences(
  deps: AuthorisedLicenceDeps & { grants: Pick<GrantStore, "grantsForHolder"> },
) {
  return async (appId: string | null, userDid: string): Promise<AuthorisedLicence[]> => {
    const grants = await deps.grants.grantsForHolder(userDid);
    return authorisedLicences(deps, appId === null ? grants : grants.filter((g) => g.appId === appId));
  };
}
