import { isDocumentNotFound } from "../vetra-apps/envs.js";
import type { LicenseRow, LicenseStatusName } from "./transitions.js";
import type { LicenseTypeView, LicenseView } from "./resolvers.js";
import { templateHash, type TemplateShape } from "./template.js";

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

export interface LicenseReads {
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
  /** Every licence across all apps; the keeper is global. */
  listLicenses(): Promise<LicenseRow[]>;
  /** Every licence across all apps, with the fields provisioning needs. */
  allLicenses(): Promise<LicenseFullRow[]>;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function docId(doc: unknown): string | null {
  if (!isRec(doc) || !isRec(doc.header)) return null;
  return str(doc.header.id);
}

function globalState(doc: unknown): Rec | null {
  if (!isRec(doc) || !isRec(doc.state) || !isRec(doc.state.global)) return null;
  return doc.state.global;
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
    licenseTypeId: str(g.licenseType),
    user: (str(g.user) ?? "").toLowerCase(),
    status: status as LicenseStatusName,
    start: str(g.start),
    end: str(g.end),
  };
}

interface ParsedLicenseType {
  id: string;
  app: string | null;
  kind: string;
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
    status,
    validityDays: typeof g.validityDays === "number" ? g.validityDays : null,
    template: parseTemplate(g.template),
  };
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
        .filter((l) => l.app === appId && (status === null || l.status === status))
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
      const docs = await findAll(LICENSE_TYPE_DOC_TYPE);
      return docs.flatMap((d) => {
        const t = parseLicenseType(d);
        if (!t || t.app !== appId) return [];
        return [
          {
            id: t.id,
            kind: t.kind,
            status: t.status,
            templateHash: templateHash(t.template ?? EMPTY_TEMPLATE),
          },
        ];
      });
    },

    async templateFor(licenseId) {
      const license = parseLicense(await getDoc(licenseId));
      if (!license?.licenseTypeId) return null;
      const type = parseLicenseType(await getDoc(license.licenseTypeId));
      if (!type || type.status === "RETIRED") return null;
      return type.template;
    },

    async licenseType(id) {
      const t = parseLicenseType(await getDoc(id));
      if (!t || t.app === null) return null;
      return {
        id: t.id,
        app: t.app,
        status: t.status,
        validityDays: t.validityDays,
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
