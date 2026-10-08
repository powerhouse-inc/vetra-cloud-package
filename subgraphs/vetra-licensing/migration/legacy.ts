import { docId, globalState, isDocType, isRec, str } from "../doc-parse.js";

/**
 * Legacy shapes the startup migration reads. Declared here, not imported, so
 * the migration keeps compiling after the code that wrote them is deleted
 * (vetra-access-codes in Task 17, the app-license-type model in Task 18).
 */
export const LEGACY_LICENSE_TYPE_DOC_TYPE = "powerhouse/app-license-type";

export interface LegacyTemplateService {
  id: string;
  type: string;
  prefix: string | null;
  artifactName: string | null;
  artifactChannel: string | null;
}

export interface LegacyTemplate {
  services: LegacyTemplateService[];
  packages: { id: string; packageName: string | null; version: string | null }[];
  size: string | null;
  baseDomain: string | null;
  packageRegistry: string | null;
}

export interface LegacyLicenseType {
  id: string;
  app: string | null;
  kind: string | null;
  label: string | null;
  validityDays: number | null;
  status: string;
  /** null: the type never had a template (it becomes a term with no template). */
  template: LegacyTemplate | null;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseLegacyTemplate(raw: unknown): LegacyTemplate | null {
  if (!isRec(raw)) return null;
  return {
    services: arr(raw.services).flatMap((s): LegacyTemplateService[] => {
      if (!isRec(s)) return [];
      const id = str(s.id);
      const type = str(s.type);
      return id && type
        ? [{ id, type, prefix: str(s.prefix), artifactName: str(s.artifactName), artifactChannel: str(s.artifactChannel) }]
        : [];
    }),
    packages: arr(raw.packages).flatMap((p) => {
      if (!isRec(p)) return [];
      const id = str(p.id);
      return id ? [{ id, packageName: str(p.packageName), version: str(p.version) }] : [];
    }),
    size: str(raw.size),
    baseDomain: str(raw.baseDomain),
    packageRegistry: str(raw.packageRegistry),
  };
}

/**
 * A legacy licence-type document, every field kept as stored (artifact
 * references included); null for anything that is not one.
 */
export function parseLegacyLicenseType(doc: unknown): LegacyLicenseType | null {
  if (!isDocType(doc, LEGACY_LICENSE_TYPE_DOC_TYPE)) return null;
  const id = docId(doc);
  const g = globalState(doc);
  const status = g ? str(g.status) : null;
  if (!id || !g || !status) return null;
  return {
    id,
    app: str(g.app),
    kind: str(g.kind),
    label: str(g.label),
    validityDays: typeof g.validityDays === "number" ? g.validityDays : null,
    status,
    template: parseLegacyTemplate(g.template),
  };
}

/** Rows of the vetra-access-codes namespace (read-only), as that subgraph wrote them. */
export interface LegacyAccessDB {
  invite_codes: {
    code: string;
    label: string | null;
    active: boolean;
    expires_at: string | null;
    max_uses: number | null;
    created_at: string;
    anthropic_key_ciphertext: string | null;
  };
  invite_redemptions: {
    code: string;
    /** As the caller's bearer spelled it: did:pkh:<network>:<chain>:<address>. */
    user_did: string;
    redeemed_at: string;
    /** VARCHAR: written as ISO by vetra-access-codes, but never trusted to parse. */
    access_expires: string | null;
  };
}

/**
 * A stored timestamp as canonical ISO, or null when it does not parse.
 * Legacy columns are VARCHAR, so nothing guarantees their shape.
 */
export function isoInstant(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
