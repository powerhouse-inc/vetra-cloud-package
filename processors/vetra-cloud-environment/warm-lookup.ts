import type { Kysely } from "kysely";
import { createWarmPoolStore } from "../../subgraphs/vetra-licensing/warm-pool-db.js";
import { createInstancePoolLookup } from "../../subgraphs/vetra-apps/plans/pool-lookup.js";
import { lookupWarm, type WarmPoolLookup } from "./app-image-project.js";

/**
 * The processor's warm lookup: licensing's pool first (licensed environments,
 * Sektar; unchanged), then own plans' pools (releases phase 3 slice 8). The
 * second is asked only when the first says no (or its table is missing).
 */
export function createWarmLookup(
  licensingDb: Kysely<any>,
  appsDb: Kysely<any>,
): WarmPoolLookup {
  const licensing = createWarmPoolStore(licensingDb);
  const instances = createInstancePoolLookup(appsDb);
  return async (documentId) =>
    (await lookupWarm((id) => licensing.isWarm(id), documentId)) ??
    (await instances(documentId));
}
