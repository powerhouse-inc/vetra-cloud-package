import { isDocumentNotFound } from "../vetra-apps/envs.js";
import { docId, globalState, isDocType, isRec, str } from "./doc-parse.js";
import type { AppArtifact, LicenseClientLike } from "./reads.js";
import { templateHash, type TemplateService, type TemplateShape } from "./template.js";
import { resolveTemplateArtifacts, templateNeedsArtifacts } from "./artifact-resolution.js";

export const APP_DOC_TYPE = "powerhouse/vetra-app";
export type TemplateMode = "SHARED" | "DEDICATED";

export interface AppTemplateView {
  id: string;
  name: string | null;
  mode: TemplateMode;
  sharedEnvironment: string | null;
  /** RESOLVED: artifact channels replaced by the version they point at. */
  template: TemplateShape;
  templateHash: string;
  resolutionError: string | null;
}

export interface AppTermView {
  id: string;
  kind: string;
  label: string | null;
  templateId: string | null;
  validityDays: number | null;
  issuers: string[];
  status: "DRAFT" | "ACTIVE" | "RETIRED";
}

export interface AppDocView {
  id: string;
  name: string | null;
  slug: string | null;
  owner: string | null;
  status: string;
  identityDid: string | null;
  productionEnvironmentId: string | null;
  templates: AppTemplateView[];
  terms: AppTermView[];
  artifacts: AppArtifact[];
}

const TERM_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseArtifacts(raw: unknown): AppArtifact[] {
  return arr(raw).flatMap((a): AppArtifact[] => {
    if (!isRec(a)) return [];
    const kind = str(a.kind);
    const name = str(a.name);
    if ((kind !== "PACKAGE" && kind !== "FUSION_IMAGE") || !name) return [];
    const versions = arr(a.versions).flatMap((v) => {
      if (!isRec(v)) return [];
      const version = str(v.version);
      const reference = str(v.reference);
      return version && reference ? [{ version, reference }] : [];
    });
    const channels = arr(a.channels).flatMap((c) => {
      if (!isRec(c)) return [];
      const channel = str(c.channel);
      const version = str(c.version);
      return channel && version ? [{ channel, version }] : [];
    });
    return [{ kind, name, versions, channels }];
  });
}

function parseServices(raw: unknown): TemplateService[] {
  return arr(raw).flatMap((s): TemplateService[] => {
    if (!isRec(s)) return [];
    const id = str(s.id);
    const type = str(s.type);
    if (!id || !type) return [];
    return [{
      id,
      type,
      prefix: str(s.prefix),
      artifactName: str(s.artifactName),
      artifactChannel: str(s.artifactChannel),
    }];
  });
}

function parseTemplateView(raw: unknown, artifacts: AppArtifact[]): AppTemplateView | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const mode = str(raw.mode);
  if (!id || (mode !== "SHARED" && mode !== "DEDICATED")) return null;
  const shape: TemplateShape = {
    services: parseServices(raw.services),
    packages: arr(raw.packages).flatMap((p) => {
      if (!isRec(p)) return [];
      const pid = str(p.id);
      return pid ? [{ id: pid, packageName: str(p.packageName), version: str(p.version) }] : [];
    }),
    size: str(raw.size),
    baseDomain: str(raw.baseDomain),
    packageRegistry: str(raw.packageRegistry),
  };
  let template = shape;
  let resolutionError: string | null = null;
  if (templateNeedsArtifacts(shape)) {
    try {
      template = resolveTemplateArtifacts(shape, artifacts);
    } catch (err) {
      resolutionError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    id,
    name: str(raw.name),
    mode,
    sharedEnvironment: str(raw.sharedEnvironment),
    template,
    // Over the RESOLVED template: a publish moves a channel, which moves the hash.
    templateHash: templateHash(template),
    resolutionError,
  };
}

function parseTerm(raw: unknown): AppTermView | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const kind = str(raw.kind);
  const status = TERM_STATUSES.find((s) => s === raw.status);
  if (!id || !kind || !status) return null;
  return {
    id,
    kind,
    label: str(raw.label),
    templateId: str(raw.templateId),
    validityDays: typeof raw.validityDays === "number" ? raw.validityDays : null,
    issuers: arr(raw.issuers).flatMap((i) => (typeof i === "string" ? [i] : [])),
    status,
  };
}

export function parseAppDocument(doc: unknown): AppDocView | null {
  if (!isDocType(doc, APP_DOC_TYPE)) return null;
  const id = docId(doc);
  const g = globalState(doc);
  if (!id || !g) return null;
  const artifacts = parseArtifacts(g.artifacts);
  const identity = isRec(g.identity) ? g.identity : {};
  return {
    id,
    name: str(g.name),
    slug: str(g.slug),
    owner: str(g.owner),
    status: str(g.status) ?? "PENDING_IDENTITY",
    identityDid: str(identity.did),
    productionEnvironmentId: str(g.productionEnvironmentId),
    // A document from before the licensing module has neither list.
    templates: arr(g.templates).flatMap((t) => {
      const v = parseTemplateView(t, artifacts);
      return v ? [v] : [];
    }),
    terms: arr(g.terms).flatMap((t) => {
      const v = parseTerm(t);
      return v ? [v] : [];
    }),
    artifacts,
  };
}

export type KindResolution =
  | { ok: true; term: AppTermView; template: AppTemplateView; stage: string | null; label: string }
  | { ok: false; reason: string };

/**
 * licence kind -> term -> template. A RETIRED term still resolves: retiring
 * blocks new licences, never existing ones. Anything that does not resolve is
 * a reason to HOLD, never to release.
 */
export function resolveKind(app: AppDocView, kind: string | null): KindResolution {
  if (!kind) return { ok: false, reason: "licence has no kind" };
  const term = app.terms.find((t) => t.kind === kind);
  if (!term) return { ok: false, reason: `kind ${kind} is not a term of app ${app.id}` };
  if (term.status === "DRAFT") return { ok: false, reason: `term ${kind} is DRAFT` };
  const template = app.templates.find((t) => t.id === term.templateId);
  if (!template) {
    return { ok: false, reason: `term ${kind} points at missing template ${term.templateId}` };
  }
  if (template.mode === "DEDICATED" && template.resolutionError) {
    return { ok: false, reason: `template ${template.id} cannot be resolved: ${template.resolutionError}` };
  }
  return {
    ok: true,
    term,
    template,
    stage: template.mode === "SHARED" ? (template.sharedEnvironment ?? app.productionEnvironmentId) : null,
    label: term.label ?? term.kind,
  };
}

export interface AppReads {
  app(id: string): Promise<AppDocView | null>;
  appBySlug(slug: string): Promise<AppDocView | null>;
  appsOwnedBy(address: string): Promise<AppDocView[]>;
}

const PAGE_SIZE = 200;

export function createAppReads(client: LicenseClientLike): AppReads {
  async function all(): Promise<AppDocView[]> {
    const out: AppDocView[] = [];
    let cursor = "0";
    for (;;) {
      const page = await client.find({ type: APP_DOC_TYPE }, undefined, { cursor, limit: PAGE_SIZE });
      for (const d of page.results) {
        const v = parseAppDocument(d);
        if (v) out.push(v);
      }
      if (!page.nextCursor || page.nextCursor === cursor) return out;
      cursor = page.nextCursor;
    }
  }
  return {
    async app(id) {
      try {
        return parseAppDocument(await client.get(id));
      } catch (err) {
        if (isDocumentNotFound(err)) return null;
        throw err;
      }
    },
    async appBySlug(slug) {
      return (await all()).find((a) => a.slug === slug) ?? null;
    },
    async appsOwnedBy(address) {
      const want = address.toLowerCase();
      return (await all()).filter((a) => a.owner?.toLowerCase() === want);
    },
  };
}
