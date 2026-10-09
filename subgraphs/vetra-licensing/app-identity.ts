import type { AppDocView } from "./app-reads.js";
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
 * configuration (VETRA_STUDIO_IDENTITY_DID), never from its document: the
 * licensing ledger does not cover the document's `identityDid`, and the
 * document's status is untrusted, so the studio reports as ACTIVE whenever a
 * DID is configured. Unconfigured, studio stats are not relayed. A document
 * naming a different DID (or a tampered/unverified one) only raises a
 * once-per-process warning; the configured DID is still used. Renown refuses
 * the report unless that DID is a registered workload identity whose owner
 * holds a live delegation.
 *
 * `app` is the view the relay has already read, so no second read happens.
 */
export function createAppIdentityLookup(deps: {
  row(appId: string): Promise<{ identity_did: string | null; status: string } | null>;
  studioIdentityDid: string | null;
  logger: { info(message: string): void; warn(message: string): void };
}): (
  appId: string,
  app?: Pick<AppDocView, "identityDid" | "tampered" | "unverified"> | null,
) => Promise<AppIdentity | null> {
  let loggedUnset = false;
  let warnedMismatch = false;
  return async (appId, app) => {
    const row = await deps.row(appId);
    if (row) return { identityDid: row.identity_did, status: row.status };
    if (appId !== STUDIO_APP_ID) return null;
    const configured = deps.studioIdentityDid;
    if (!configured) {
      if (!loggedUnset) {
        loggedUnset = true;
        deps.logger.info("[licensing] studio stats are not relayed: VETRA_STUDIO_IDENTITY_DID unset");
      }
      return null;
    }
    if (
      !warnedMismatch &&
      app &&
      (app.tampered || app.unverified || (app.identityDid && app.identityDid !== configured))
    ) {
      warnedMismatch = true;
      deps.logger.warn(
        "[licensing] the studio app document disagrees with VETRA_STUDIO_IDENTITY_DID (tampered, unverified or a different identity); using the configured identity",
      );
    }
    return { identityDid: configured, status: "ACTIVE" };
  };
}
