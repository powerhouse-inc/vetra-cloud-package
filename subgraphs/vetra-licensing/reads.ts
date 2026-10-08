import { isDocumentNotFound } from "../vetra-apps/envs.js";
import { parseAppDocument } from "./app-reads.js";
import { docId, globalState, isDocType, str } from "./doc-parse.js";
import type { LicenseRow, LicenseStatusName } from "./transitions.js";

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
  /** Every licence across all apps; the keeper is global. */
  listLicenses(): Promise<LicenseRow[]>;
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

/** Every document of one type, following the cursor to exhaustion. */
export async function findAllOfType(client: LicenseClientLike, type: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor = "0";
  for (;;) {
    const page = await client.find({ type }, undefined, { cursor, limit: PAGE_SIZE });
    out.push(...page.results);
    if (!page.nextCursor || page.nextCursor === cursor) return out;
    cursor = page.nextCursor;
  }
}

export function createReactorLicenseReads(
  client: LicenseClientLike,
): LicenseReads {
  /** Follows the cursor to exhaustion: one page is never the whole population. */
  const findAll = (type: string) => findAllOfType(client, type);

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
    async appArtifacts(appId) {
      // The app document's id is the app id, so this is a direct get. A missing
      // document means the app has published nothing yet — an empty list, not
      // an error: the builder says so rather than showing an empty dropdown.
      // Artifacts only, for the template builder and the legacy type hash; the
      // integrity check (createAppReads) guards templates and terms.
      return parseAppDocument(await getDoc(appId))?.artifacts ?? [];
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
  };
}
