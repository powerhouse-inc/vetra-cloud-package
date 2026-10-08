import { isDocumentNotFound } from "../vetra-apps/envs.js";
import { parseAppDocument } from "./app-reads.js";
import { docId, globalState, isDocType, isRec, str } from "./doc-parse.js";
import type { LicenseRow, LicenseStatusName } from "./transitions.js";
import type { LicenseTypeView, LicenseView } from "./resolvers.js";
import { templateHash, type TemplateShape } from "./template.js";
import {
  resolveTemplateArtifacts,
  templateNeedsArtifacts,
} from "./artifact-resolution.js";

export const LICENSE_DOC_TYPE = "powerhouse/app-owner-license";
export const LICENSE_TYPE_DOC_TYPE = "powerhouse/app-license-type";

const PAGE_SIZE = 200;

const LICENSE_STATUSES: readonly string[] = [
  "ISSUED",
  "ACTIVE",
  "EXPIRED",
  "REVOKED",
  "REPLACED",
];

/** Narrow surface over the reactor client: only what the reads use. */
export interface LicenseClientLike {
  find(
    search: { type?: string },
    view?: undefined,
    paging?: { cursor: string; limit: number },
  ): Promise<{ results: unknown[]; nextCursor?: string }>;
  get(id: string): Promise<unknown>;
}

export interface LicenseFullRow {
  id: string;
  app: string;
  user: string;
  licenseTypeId: string;
  status: LicenseStatusName;
  start: string | null;
  end: string | null;
}

/** A licence type with the fields the publisher dashboard shows. */
export interface LicenseTypeDetail {
  /**
   * Why this type's artifacts could not be resolved, or null when they were.
   * A type that cannot be resolved is not provisioned: the licence is HELD, not
   * given an environment running some other version. See artifact-resolution.ts.
   */
  resolutionError: string | null;
  id: string;
  kind: string;
  label: string | null;
  status: string;
  validityDays: number | null;
  templateHash: string;
  template: TemplateShape;
}

/**
 * One artifact the app has published, as the template builder offers it.
 *
 * Read from the app's own document: the document id IS the app id, so no
 * lookup table stands between a template and the images it can reference.
 */
export interface AppArtifactVersion {
  version: string;
  /**
   * What CI published: a full image reference for a FUSION_IMAGE, a registry
   * URL for a PACKAGE. Provisioning derives the repository from it, so it is
   * read here rather than reconstructed from the app's Harbor project.
   */
  reference: string;
}

export interface AppArtifact {
  kind: "PACKAGE" | "FUSION_IMAGE";
  name: string;
  /** Newest last, as the document stores them. */
  versions: AppArtifactVersion[];
  /** Channel name to the version it currently points at. */
  channels: { channel: string; version: string }[];
}

/** A licence as issueLicense, the keeper and the publisher surface see it. */
export interface LicenceRecord {
  id: string;
  app: string;
  /** Lowercased: a DID on reshaped licences, a bare 0x address on legacy ones. */
  user: string;
  /** The term kind; null on a legacy licence issued against a licence type. */
  kind: string | null;
  issuer: string | null;
  status: LicenseStatusName;
  issued: string | null;
  start: string | null;
  end: string | null;
  stage: string | null;
  details: string | null;
  replacedBy: string | null;
  legacyLicenseTypeId: string | null;
}

export interface LicenseReads {
  /** Every artifact the app has published, for the template builder's selects. */
  appArtifacts(appId: string): Promise<AppArtifact[]>;
  /** Every licence type of one app, with label, validity and template contents. */
  licenseTypeDetails(appId: string): Promise<LicenseTypeDetail[]>;
  licenses(appId: string, status: string | null): Promise<LicenseView[]>;
  licenseTypes(appId: string): Promise<LicenseTypeView[]>;
  templateFor(licenseId: string): Promise<TemplateShape | null>;
  /** One licence type by document id; null when missing or not a licence type. */
  licenseType(id: string): Promise<{
    id: string;
    app: string;
    status: string;
    validityDays: number | null;
  } | null>;
  /** One licence by document id; null when missing, malformed or without an app. */
  license(id: string): Promise<LicenseFullRow | null>;
  /** Every licence across all apps; the keeper is global. */
  listLicenses(): Promise<LicenseRow[]>;
  /** Every licence across all apps, with the fields provisioning needs. */
  allLicenses(): Promise<LicenseFullRow[]>;
  /** One licence by document id; null when missing, not a licence, malformed or without an app. */
  licenceRecord(id: string): Promise<LicenceRecord | null>;
  /** Every well-formed licence with an app, across all apps. */
  allLicenceRecords(): Promise<LicenceRecord[]>;
  /** The licences with these ids, in the given order; missing ids are skipped. */
  licenceRecords(ids: string[]): Promise<LicenceRecord[]>;
}

interface ParsedLicense {
  id: string;
  app: string | null;
  licenseTypeId: string | null;
  user: string;
  status: LicenseStatusName;
  start: string | null;
  end: string | null;
}

/**
 * The licence-type id a pre-terms licence was issued against. Stored state
 * written before the reshape has `licenseType`; a licence issued (or replayed)
 * through the reshaped reducer carries it in details.legacyLicenseType.
 */
export function legacyLicenseTypeOf(g: Record<string, unknown>): string | null {
  const direct = typeof g.licenseType === "string" ? g.licenseType : null;
  if (direct) return direct;
  if (typeof g.details !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(g.details);
    if (typeof parsed === "object" && parsed !== null) {
      const v = (parsed as Record<string, unknown>).legacyLicenseType;
      return typeof v === "string" ? v : null;
    }
  } catch {
    // details is free text on non-legacy licences.
  }
  return null;
}

/** null for a document that is not a well-formed licence; callers skip it. */
function parseLicense(doc: unknown): ParsedLicense | null {
  const id = docId(doc);
  const g = globalState(doc);
  if (!id || !g) return null;
  const status = str(g.status);
  if (!status || !LICENSE_STATUSES.includes(status)) return null;
  return {
    id,
    app: str(g.app),
    licenseTypeId: legacyLicenseTypeOf(g),
    user: (str(g.user) ?? "").toLowerCase(),
    status: status as LicenseStatusName,
    start: str(g.start),
    end: str(g.end),
  };
}

/** null for a document that is not a well-formed licence with an app. */
function toRecord(doc: unknown): LicenceRecord | null {
  const l = parseLicense(doc);
  const g = globalState(doc);
  if (!l || !g || l.app === null) return null;
  return {
    id: l.id,
    app: l.app,
    user: l.user,
    kind: str(g.kind),
    issuer: str(g.issuer),
    status: l.status,
    issued: str(g.issued),
    start: l.start,
    end: l.end,
    stage: str(g.stage),
    details: str(g.details),
    replacedBy: str(g.replacedBy),
    legacyLicenseTypeId: l.licenseTypeId,
  };
}

interface ParsedLicenseType {
  id: string;
  app: string | null;
  kind: string;
  label: string | null;
  status: string;
  validityDays: number | null;
  template: TemplateShape | null;
}

function parseTemplate(raw: unknown): TemplateShape | null {
  if (!isRec(raw)) return null;
  if (!Array.isArray(raw.services) || !Array.isArray(raw.packages)) return null;
  const services = [];
  for (const s of raw.services) {
    if (!isRec(s)) return null;
    const id = str(s.id);
    const type = str(s.type);
    if (id === null || type === null) return null;
    services.push({ id, type, prefix: str(s.prefix) });
  }
  const packages = [];
  for (const p of raw.packages) {
    if (!isRec(p)) return null;
    const id = str(p.id);
    if (id === null) return null;
    packages.push({
      id,
      packageName: str(p.packageName),
      version: str(p.version),
    });
  }
  return {
    services,
    packages,
    size: str(raw.size),
    baseDomain: str(raw.baseDomain),
    packageRegistry: str(raw.packageRegistry),
  };
}

const EMPTY_TEMPLATE: TemplateShape = {
  services: [],
  packages: [],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};

function parseLicenseType(doc: unknown): ParsedLicenseType | null {
  const id = docId(doc);
  const g = globalState(doc);
  if (!id || !g) return null;
  const status = str(g.status);
  if (!status) return null;
  return {
    id,
    app: str(g.app),
    kind: str(g.kind) ?? "",
    label: str(g.label),
    status,
    validityDays: typeof g.validityDays === "number" ? g.validityDays : null,
    template: parseTemplate(g.template),
  };
}

/**
 * Resolves a template's artifacts, or reports why it could not.
 *
 * Never throws: one unresolvable type must not blank an app's whole list. The
 * error travels with the type so provisioning can HOLD that licence while every
 * other type of the app is still planned normally.
 *
 * On failure the hash stays the unresolved one, which is stable — an app whose
 * image was yanked does not churn every tick.
 */
function resolveSafely(
  template: TemplateShape,
  artifacts: AppArtifact[],
): { template: TemplateShape; error: string | null } {
  if (!templateNeedsArtifacts(template)) return { template, error: null };
  try {
    return {
      template: resolveTemplateArtifacts(template, artifacts),
      error: null,
    };
  } catch (err) {
    return {
      template,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function createReactorLicenseReads(
  client: LicenseClientLike,
): LicenseReads {
  /** Follows the cursor to exhaustion: one page is never the whole population. */
  async function findAll(type: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor = "0";
    for (;;) {
      const page = await client.find({ type }, undefined, {
        cursor,
        limit: PAGE_SIZE,
      });
      out.push(...page.results);
      if (!page.nextCursor || page.nextCursor === cursor) return out;
      cursor = page.nextCursor;
    }
  }

  async function getDoc(id: string): Promise<unknown> {
    try {
      return (await client.get(id)) ?? null;
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  }

  async function licenceRecord(id: string): Promise<LicenceRecord | null> {
    const doc = await getDoc(id);
    return isDocType(doc, LICENSE_DOC_TYPE) ? toRecord(doc) : null;
  }

  async function parsedLicenses(): Promise<ParsedLicense[]> {
    const docs = await findAll(LICENSE_DOC_TYPE);
    return docs.flatMap((d) => {
      const l = parseLicense(d);
      return l ? [l] : [];
    });
  }

  return {
    async licenses(appId, status) {
      return (await parsedLicenses())
        .filter(
          (l) => l.app === appId && (status === null || l.status === status),
        )
        .map((l) => ({
          id: l.id,
          user: l.user,
          licenseTypeId: l.licenseTypeId ?? "",
          status: l.status,
          start: l.start,
          end: l.end,
        }));
    },

    async licenseTypes(appId) {
      const [docs, artifacts] = await Promise.all([
        findAll(LICENSE_TYPE_DOC_TYPE),
        this.appArtifacts(appId),
      ]);
      return docs.flatMap((d) => {
        const t = parseLicenseType(d);
        if (!t || t.app !== appId) return [];
        return [
          {
            id: t.id,
            kind: t.kind,
            status: t.status,
            templateHash: templateHash(
              resolveSafely(t.template ?? EMPTY_TEMPLATE, artifacts).template,
            ),
          },
        ];
      });
    },

    async appArtifacts(appId) {
      // The app document's id is the app id, so this is a direct get. A missing
      // document means the app has published nothing yet — an empty list, not
      // an error: the builder says so rather than showing an empty dropdown.
      // Artifacts only, for the template builder and the legacy type hash; the
      // integrity check (createAppReads) guards templates and terms.
      return parseAppDocument(await getDoc(appId))?.artifacts ?? [];
    },

    async licenseTypeDetails(appId) {
      // One artifact read per app per tick, shared by every type of that app.
      const [docs, artifacts] = await Promise.all([
        findAll(LICENSE_TYPE_DOC_TYPE),
        this.appArtifacts(appId),
      ]);
      return docs.flatMap((d) => {
        const t = parseLicenseType(d);
        if (!t || t.app !== appId) return [];
        const resolved = resolveSafely(t.template ?? EMPTY_TEMPLATE, artifacts);
        return [
          {
            id: t.id,
            kind: t.kind,
            label: t.label,
            status: t.status,
            validityDays: t.validityDays,
            // Over the RESOLVED template: a publish moves the channel, which
            // moves this hash, which is what makes the keeper re-provision.
            templateHash: templateHash(resolved.template),
            template: resolved.template,
            resolutionError: resolved.error,
          },
        ];
      });
    },

    async templateFor(licenseId) {
      const license = parseLicense(await getDoc(licenseId));
      if (!license?.licenseTypeId) return null;
      const type = parseLicenseType(await getDoc(license.licenseTypeId));
      // A RETIRED type still resolves: the licence is the entitlement and the
      // type is only where the template comes from. Retire means "no new
      // grants"; it never ends service for existing holders. This must agree
      // with the provisioning keeper (resolveTemplateForLicence).
      if (!type) return null;
      return type.template;
    },

    async licenseType(id) {
      // By-id reads must check the type: a licence document would otherwise
      // parse as a licence type (and vice versa).
      const doc = await getDoc(id);
      if (!isDocType(doc, LICENSE_TYPE_DOC_TYPE)) return null;
      const t = parseLicenseType(doc);
      if (!t || t.app === null) return null;
      return {
        id: t.id,
        app: t.app,
        status: t.status,
        validityDays: t.validityDays,
      };
    },

    async license(id) {
      const doc = await getDoc(id);
      if (!isDocType(doc, LICENSE_DOC_TYPE)) return null;
      const l = parseLicense(doc);
      if (!l || l.app === null) return null;
      return {
        id: l.id,
        app: l.app,
        user: l.user,
        licenseTypeId: l.licenseTypeId ?? "",
        status: l.status,
        start: l.start,
        end: l.end,
      };
    },

    async listLicenses() {
      return (await parsedLicenses()).map((l) => ({
        id: l.id,
        status: l.status,
        start: l.start,
        end: l.end,
      }));
    },

    licenceRecord,

    async allLicenceRecords() {
      return (await findAll(LICENSE_DOC_TYPE)).flatMap((d) => {
        const r = toRecord(d);
        return r ? [r] : [];
      });
    },

    async licenceRecords(ids) {
      const out: LicenceRecord[] = [];
      for (const id of ids) {
        const r = await licenceRecord(id);
        if (r) out.push(r);
      }
      return out;
    },

    async allLicenses() {
      // parseLicense already validates status and lowercases user.
      return (await parsedLicenses()).flatMap((l) =>
        l.app === null
          ? []
          : [
              {
                id: l.id,
                app: l.app,
                user: l.user,
                licenseTypeId: l.licenseTypeId ?? "",
                status: l.status,
                start: l.start,
                end: l.end,
              },
            ],
      );
    },
  };
}
