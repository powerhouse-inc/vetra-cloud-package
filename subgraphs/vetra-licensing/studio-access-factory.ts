import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import type { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import { createAppReads, type AppReads, type AppReadsClient } from "./app-reads.js";
import type { VetraLicensingDB } from "./db/schema.js";
import { createGrantStore } from "./grants.js";
import { keyCiphertextForCode, redeemedCodeOf } from "./invite-codes.js";
import { createKeyVault, type KeyVault } from "./key-vault.js";
import { createAppLedger, reactorLedgerSource } from "./licensing-ledger.js";
import { createHolderLicences } from "./licence-view.js";
import { createLifecycleStore } from "./lifecycle.js";
import { createReactorLicenseReads } from "./reads.js";
import { STUDIO_APP_ID } from "./studio-app.js";
import type { StudioAccessDeps } from "./studio-access.js";

/**
 * Ids an app document must have to be trusted by slug: an app with a row, or
 * the studio app. Anyone signed in can write an unprotected document, so a
 * slug alone proves nothing.
 */
export function appsTrustedIds(appsDb: Kysely<VetraAppsDB>): () => Promise<ReadonlySet<string>> {
  return async () =>
    new Set([
      ...(await appsDb.selectFrom("apps").select("id").execute()).map((r) => r.id),
      STUDIO_APP_ID,
    ]);
}

/**
 * The app reads every licensing surface shares: ledger-checked (a licensing
 * state that differs from what the system recorded holds the app) and trusted
 * by slug only for ids in `trustedIds`.
 */
export function createLicensingAppReads(input: {
  client: AppReadsClient;
  db: Kysely<VetraLicensingDB>;
  trustedIds: () => Promise<ReadonlySet<string>>;
}) {
  const appLedger = createAppLedger({
    db: input.db,
    source: reactorLedgerSource(input.client as never),
    now: () => new Date().toISOString(),
  });
  const appReads: AppReads = createAppReads(input.client, {
    // Licensing state that differs from what the system last wrote: held,
    // unless the difference is journalled system writes (healed).
    ledger: appLedger.lookup,
    heal: appLedger.heal,
    trustedIds: input.trustedIds,
  });
  return { appLedger, appReads };
}

/**
 * The vetra-studio gate over DB authority; one definition for every surface
 * that uses it. The studio app is the fixed STUDIO_APP_ID, never found by
 * slug: a slug is document state any app owner can write, so a second app
 * carrying the studio's slug would otherwise lock everyone out of Studio. Its
 * document must exist (read through app(), which applies the integrity and
 * tamper checks).
 */
export function buildStudioAccessDeps(input: {
  appReads: Pick<AppReads, "app">;
  holderLicences: StudioAccessDeps["licencesOf"];
  db: Kysely<VetraLicensingDB>;
  keyVault: KeyVault | null;
}): StudioAccessDeps {
  return {
    studioAppId: async () => ((await input.appReads.app(STUDIO_APP_ID)) ? STUDIO_APP_ID : null),
    licencesOf: input.holderLicences,
    redeemedCode: (licenseId, userDid) =>
      redeemedCodeOf(input.db, licenseId, userDid, new Date().toISOString()),
    keyCiphertextForCode: (code) => keyCiphertextForCode(input.db, code),
    keyVault: input.keyVault,
    now: () => new Date().toISOString(),
  };
}

/** For subgraphs outside vetra-licensing (the studio pool) that need the studio licence gate. */
export function createStudioAccessDeps(input: {
  client: AppReadsClient;
  licensingDb: Kysely<VetraLicensingDB>;
  trustedIds: () => Promise<ReadonlySet<string>>;
  transit: OpenBaoTransitClient | null;
}): StudioAccessDeps {
  const { appReads } = createLicensingAppReads({
    client: input.client,
    db: input.licensingDb,
    trustedIds: input.trustedIds,
  });
  const holderLicences = createHolderLicences({
    licences: createReactorLicenseReads(input.client),
    lifecycle: createLifecycleStore(input.licensingDb, () => new Date().toISOString()),
    grants: createGrantStore(input.licensingDb),
  });
  return buildStudioAccessDeps({
    appReads,
    holderLicences,
    db: input.licensingDb,
    keyVault: createKeyVault(input.transit),
  });
}
