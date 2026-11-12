import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import type { PlanLicence } from "./chain-plan.js";

/**
 * Releases phase 3: a kind adopted by a vetra-apps plan belongs to the
 * instances model. Its chains get shared/own instances from the vetra-apps
 * reconciler, so licensing neither provisions, stages nor ends them. A chain
 * that already has a licensed environment stays here until the switch-over
 * moves it (overview rule 1).
 */
export function leaveToInstances(
  licences: PlanLicence[],
  planKinds: ReadonlySet<string>,
  licensedRoots: ReadonlySet<string>,
): PlanLicence[] {
  if (planKinds.size === 0) return licences;
  const toInstances = new Set(
    licences
      .filter(
        (l) =>
          l.kind !== null &&
          planKinds.has(l.kind) &&
          !licensedRoots.has(l.root),
      )
      .map((l) => l.root),
  );
  return toInstances.size === 0
    ? licences
    : licences.filter((l) => !toInstances.has(l.root));
}

const UNDEFINED_TABLE = "42P01";

/** The kinds the App's plans adopted (retired plans included: their holders stay theirs). */
export function createPlanKindsReader(appsDb: Kysely<VetraAppsDB>) {
  return async (appId: string): Promise<ReadonlySet<string>> => {
    try {
      const rows = await appsDb
        .selectFrom("plans")
        .select("kind")
        .where("app_id", "=", appId)
        .execute();
      return new Set(rows.map((r) => r.kind));
    } catch (err) {
      // vetra-apps has not created the table yet (boot order): no plans.
      if ((err as { code?: unknown } | null)?.code === UNDEFINED_TABLE)
        return new Set();
      throw err;
    }
  };
}
