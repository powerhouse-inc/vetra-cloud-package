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
    return { ok: false, reason: `licence type ${licence.licenseTypeId} not found` };
  }
  if (type.templateHash !== licence.templateHash) {
    return {
      ok: false,
      reason: `licence type ${type.id} template changed since it was planned`,
    };
  }
  return { ok: true, template: type.template, label: type.label ?? type.kind };
}
