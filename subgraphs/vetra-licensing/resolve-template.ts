import type { LicenseTypeDetail } from "./reads.js";
import type { ActiveLicense } from "./plan.js";
import type { TemplateShape } from "./template.js";

export type ResolvedTemplate =
  | { ok: true; template: TemplateShape; label: string }
  | { ok: false; reason: string };

/**
 * Pick the template a licence should be provisioned with, from the licence
 * type documents of its app. The type is matched by id and its hash must equal
 * the hash the plan was made against: if the type was edited since, the shape
 * is stale and nothing is provisioned from it (the next tick re-plans).
 */
export function resolveTemplateForLicence(
  details: LicenseTypeDetail[],
  licence: ActiveLicense,
): ResolvedTemplate {
  const type = details.find((t) => t.id === licence.licenseTypeId);
  if (!type) {
    return {
      ok: false,
      reason: `licence type ${licence.licenseTypeId} not found`,
    };
  }
  if (type.templateHash !== licence.templateHash) {
    return {
      ok: false,
      reason: `licence type ${type.id} template changed since it was planned`,
    };
  }
  // The licence is HELD, not provisioned onto whatever version happens to be
  // around. An environment running last week's image because this week's was
  // yanked is worse than one that waits for the publisher to fix it.
  if (type.resolutionError) {
    return {
      ok: false,
      reason: `licence type ${type.id} cannot be resolved: ${type.resolutionError}`,
    };
  }
  return { ok: true, template: type.template, label: type.label ?? type.kind };
}

/**
 * Hands the provisioning keeper one read of an app's licence types per tick.
 * The keeper's `licenseTypes(appId)` is the read that starts reconciling an
 * app; `detailsFor(appId)` returns that same snapshot to the `applyFor` calls
 * that follow, so a tick costs one licence-type scan per app instead of one per
 * app plus one per applied licence. `detailsFor` falls back to a fresh read
 * when no snapshot exists, so it is correct when called on its own.
 *
 * Planning and applying now share one snapshot, so the template and the hash
 * it is checked against can no longer disagree within a tick.
 */
export function createTypeSnapshots(reads: {
  licenseTypeDetails(appId: string): Promise<LicenseTypeDetail[]>;
}) {
  const snapshots = new Map<string, LicenseTypeDetail[]>();
  return {
    async licenseTypes(appId: string): Promise<LicenseTypeDetail[]> {
      const details = await reads.licenseTypeDetails(appId);
      snapshots.set(appId, details);
      return details;
    },
    async detailsFor(appId: string): Promise<LicenseTypeDetail[]> {
      return snapshots.get(appId) ?? (await reads.licenseTypeDetails(appId));
    },
  };
}
