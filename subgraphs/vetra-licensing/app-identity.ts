import type { AppReads } from "./app-reads.js";
import { STUDIO_APP_ID } from "./studio-app.js";

/** The Renown workload identity an app reports stats as, and the app's status. */
export interface AppIdentity {
  identityDid: string | null;
  status: string;
}

/**
 * The relay's app identity (reporting.ts RelayDeps.appIdentity).
 *
 * An app with an `apps` row: the row, never its document. The studio app
 * (STUDIO_APP_ID) is licensing-only and has no row; its identity comes from
 * its document, but only when the ledger vouches for it (neither tampered nor
 * unverified). Renown still refuses the report unless that DID is a
 * registered workload identity whose owner holds a live delegation, so the
 * document can at most name an identity Renown already trusts for the studio.
 */
export function createAppIdentityLookup(deps: {
  row(appId: string): Promise<{ identity_did: string | null; status: string } | null>;
  apps: Pick<AppReads, "app">;
}): (appId: string) => Promise<AppIdentity | null> {
  return async (appId) => {
    const row = await deps.row(appId);
    if (row) return { identityDid: row.identity_did, status: row.status };
    if (appId !== STUDIO_APP_ID) return null;
    const doc = await deps.apps.app(STUDIO_APP_ID);
    if (!doc || doc.tampered || doc.unverified || !doc.identityDid) return null;
    return { identityDid: doc.identityDid, status: "ACTIVE" };
  };
}
