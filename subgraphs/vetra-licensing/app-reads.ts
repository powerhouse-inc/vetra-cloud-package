import { isDocumentNotFound } from "../vetra-apps/envs.js";
import {
  incomingParentIds,
  type RelationshipClient,
} from "../vetra-apps/app-doc-protection.js";
import { docId, globalState, isDocType, isRec, str } from "./doc-parse.js";
import { licensingStateHash } from "./licensing-ledger.js";
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
  /**
   * The document may have been written by someone other than the system:
   * anything read from it (templates, terms, artifacts) is untrusted, and
   * callers must HOLD — never provision or release from a tampered app.
   *
   * Operations do not record their origin reliably (the server's reactor
   * client signs every unsigned action with the server key, including actions
   * users submit through GraphQL), so the signal is structural: an app
   * document never legitimately has a parent, and a parent's grants are the
   * one way around its protection. parseAppDocument alone cannot see
   * relationships and reports false; createAppReads fills this in.
   */
  tampered: boolean;
  tamperReason: string | null;
  /** licensingStateHash over the document's raw templates and terms. */
  licensingStateHash: string;
  /**
   * No ledger row to check the licensing state against (licensing-ledger.ts):
   * neither verified nor tampered. Acceptable only until the migration seeds
   * the ledger; after that the keeper must hold an unverified app.
   */
  unverified: boolean;
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
    tampered: false,
    tamperReason: null,
    licensingStateHash: licensingStateHash(g.templates, g.terms),
    unverified: true,
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
  if (app.tampered) {
    return { ok: false, reason: `app ${app.id} is tampered: ${app.tamperReason ?? "unknown"}` };
  }
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
  /**
   * The trusted app with this slug: only documents whose id is trusted (an
   * `apps` row, or the studio app) are considered, because anyone signed in
   * can write an unprotected document claiming any slug. More than one
   * trusted match is ambiguous: null, logged.
   */
  appBySlug(slug: string): Promise<AppDocView | null>;
  /** Every app document id, trusted or not; for the protection sweep. */
  allIds(): Promise<string[]>;
}

const PAGE_SIZE = 200;

/** What createAppReads needs: document reads plus incoming relationships. */
export type AppReadsClient = LicenseClientLike &
  Pick<RelationshipClient, "getIncomingRelationships">;

export interface AppReadsOptions {
  /** Ids an app document must have to be trusted by slug. */
  trustedIds?: () => Promise<ReadonlySet<string>>;
  logger?: Pick<Console, "warn" | "error">;
  /** The recorded licensing-state hash of an app, null when none was recorded. */
  ledger?: (appId: string) => Promise<string | null>;
}

export function createAppReads(
  client: AppReadsClient,
  opts: AppReadsOptions = {},
): AppReads {
  const logger = opts.logger ?? console;
  /**
   * Fills in `tampered` and `unverified`. Two independent checks, either of
   * which holds the app: a parent relationship (whose grants can write it), and
   * a licensing state that differs from what the system last recorded. A
   * failed lookup propagates: unknown integrity is not clean.
   */
  async function withIntegrity(view: AppDocView): Promise<AppDocView> {
    const reasons: string[] = [];
    const parents = await incomingParentIds(client, view.id);
    if (parents.length > 0) {
      reasons.push(`has parent document(s) ${parents.join(", ")}, whose grants can write it`);
    }
    const recorded = opts.ledger ? await opts.ledger(view.id) : null;
    if (recorded !== null && recorded !== view.licensingStateHash) {
      reasons.push("licensing state changed outside Vetra");
    }
    const unverified = recorded === null;
    if (reasons.length === 0) return { ...view, unverified };
    const reason = reasons.join("; ");
    logger.error(`[licensing] app document ${view.id} is TAMPERED (${reason}); holding everything read from it`);
    return { ...view, tampered: true, tamperReason: reason, unverified };
  }
  async function allDocs(): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor = "0";
    for (;;) {
      const page = await client.find({ type: APP_DOC_TYPE }, undefined, { cursor, limit: PAGE_SIZE });
      out.push(...page.results);
      if (!page.nextCursor || page.nextCursor === cursor) return out;
      cursor = page.nextCursor;
    }
  }
  return {
    async app(id) {
      let doc: unknown;
      try {
        doc = await client.get(id);
      } catch (err) {
        if (isDocumentNotFound(err)) return null;
        throw err;
      }
      const view = parseAppDocument(doc);
      return view ? withIntegrity(view) : null;
    },
    async appBySlug(slug) {
      if (!opts.trustedIds) {
        throw new Error("appBySlug needs trustedIds: an untrusted document can claim any slug");
      }
      const trusted = await opts.trustedIds();
      const matches = (await allDocs()).flatMap((d) => {
        const v = parseAppDocument(d);
        return v && v.slug === slug && trusted.has(v.id) ? [v] : [];
      });
      if (matches.length > 1) {
        logger.warn(
          `[licensing] slug ${slug} matches ${matches.length} trusted apps (${matches.map((m) => m.id).join(", ")}); refusing`,
        );
        return null;
      }
      return matches[0] ? withIntegrity(matches[0]) : null;
    },
    async allIds() {
      return (await allDocs()).flatMap((d) => {
        const id = isDocType(d, APP_DOC_TYPE) ? docId(d) : null;
        return id ? [id] : [];
      });
    },
  };
}
