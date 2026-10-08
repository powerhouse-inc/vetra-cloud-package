import type { Action } from "document-model";
import type { Kysely } from "kysely";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import { resolveKind, type AppDocView, type AppReads } from "../app-reads.js";
import type { LicensingConfig } from "../config.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { didForAddress, normaliseUserDid } from "../did.js";
import { docId, globalState } from "../doc-parse.js";
import type { GrantStore } from "../grants.js";
import { withLicenceLock } from "../issue.js";
import { codeRef, withHolderLock } from "../issuers/invite-code.js";
import type { LicenseGateway } from "../license-gateway.js";
import type { AppLedger, AppLicensingWriter } from "../licensing-ledger.js";
import type { LicenceRecord } from "../reads.js";
import { renderFloorUpdateActions } from "../template.js";
import { isoInstant, parseLegacyLicenseType, type LegacyAccessDB, type LegacyLicenseType } from "./legacy.js";
import { STUDIO_APP_ID, STUDIO_KIND, studioReconcilePlan } from "./studio.js";

/**
 * The startup licensing migration's steps (run.ts sequences them).
 *
 * Every step is idempotent and computes what is left to do from the current
 * state, so a run that died half-way is completed by the next one, and a
 * dry-run pass after an apply pass (the verification) finds nothing.
 *
 * Safety properties, each relied on by the handler once `complete` is
 * recorded:
 * - nothing here deletes, stops or re-templates an environment;
 * - nothing here overwrites what the system recorded (grant kinds,
 *   lifecycle statuses, ledger hashes): disagreements are logged warnings;
 * - every write is listed as one action line; in dry-run nothing is written
 *   (not even a ledger seed or a document protection);
 * - every item is isolated: one bad item is a problem, never an exception.
 */

export type MigrationMode = "dry-run" | "apply";

export interface MigrationReport {
  mode: MigrationMode;
  /** One line per write made (apply) or that would be made (dry-run). */
  actions: string[];
  /** Left undone. Any problem keeps the migration from completing. */
  problems: string[];
  /** Logged for operators; never blocks completion. */
  warnings: string[];
}

export interface MigrationDeps {
  db: Kysely<VetraLicensingDB>;
  /** The legacy vetra-access-codes namespace, read-only; null when absent. */
  accessDb: Kysely<LegacyAccessDB> | null;
  /** The `apps` rows (vetra-apps): which apps are trusted, and which are DELETED. */
  appRows(): Promise<{ id: string; status: string }[]>;
  /** Every powerhouse/app-license-type document, all pages. */
  legacyTypeDocs(): Promise<unknown[]>;
  /** Every well-formed licence document. */
  licences(): Promise<LicenceRecord[]>;
  /** Ledger-checked app reads that never heal: a dry-run must not write the ledger. */
  apps: Pick<AppReads, "app" | "appBySlug">;
  /** The one way the migration writes an app document (ledger-recorded). */
  appWriter: AppLicensingWriter;
  ledger: Pick<AppLedger, "lookup" | "seed">;
  /** Creates an empty vetra-app document with this id and records it in the ledger. */
  createAppDocument(id: string): Promise<void>;
  /** Makes an app document system-write-only and detaches its parents; null without document permissions. */
  protectAppDocument: ((id: string) => Promise<void>) | null;
  /** Licence writes, each recorded in license_lifecycle. */
  licenseGateway: LicenseGateway;
  envState(id: string): Promise<VetraCloudEnvironmentState | null>;
  deleteDocument(id: string): Promise<void>;
  grants: GrantStore;
  cfg: Pick<LicensingConfig, "migration" | "deleteLicenseTypes" | "studioAppSlug" | "studioPublisher">;
  now(): string;
  logger: Pick<Console, "info" | "warn" | "error">;
}

/** A legacy licence type's place in the new model. Empty ids: the type got no term (its app is gone). */
interface TypeMapping {
  appId: string;
  kind: string;
  templateId: string | null;
  termId: string | null;
}

/** What earlier steps of one run did, or (dry-run) would have done. */
export interface MigrationContext {
  types: Map<string, TypeMapping>;
  /** Kinds a dry-run would add per app, so planned kinds never collide. */
  plannedKinds: Map<string, Set<string>>;
}

export function newContext(): MigrationContext {
  return { types: new Map(), plannedKinds: new Map() };
}

/** Grants of migrated studio licences carry this as issuer, which marks them in the audit trail. */
export const MIGRATED_FROM = "vetra-access-codes";

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Records the action; in apply, also performs it. */
async function act(report: MigrationReport, what: string, run: () => Promise<unknown>): Promise<void> {
  report.actions.push(what);
  if (report.mode === "apply") await run();
}

// ---------------------------------------------------------------------------
// Licence types -> templates + terms
// ---------------------------------------------------------------------------

type TemplateServiceInput = Parameters<typeof appActions.addTemplateService>[0];

const legacyKind = (t: LegacyLicenseType) => t.kind?.trim() || `legacy-${t.id.slice(0, 8)}`;
const TERM_STATUSES = new Set(["DRAFT", "ACTIVE", "RETIRED"]);

function templateActions(t: LegacyLicenseType, templateId: string, name: string, report: MigrationReport): Action[] {
  const tpl = t.template!;
  const acts: Action[] = [
    appActions.addTemplate({ id: templateId, name, mode: "DEDICATED" }),
    appActions.setTemplateDetails({
      id: templateId,
      size: tpl.size,
      baseDomain: tpl.baseDomain,
      packageRegistry: tpl.packageRegistry,
    }),
  ];
  for (const s of tpl.services) {
    acts.push(
      appActions.addTemplateService({
        templateId,
        id: s.id,
        // Unknown enum values are refused by the action's input validation
        // (a logged problem for this type), never coerced.
        type: s.type as TemplateServiceInput["type"],
        prefix: s.prefix,
        artifactName: s.artifactName,
        artifactChannel: s.artifactChannel as TemplateServiceInput["artifactChannel"],
      }),
    );
  }
  for (const p of tpl.packages) {
    if (!p.packageName) {
      report.warnings.push(`licence type ${t.id}: package ${p.id} has no name and is dropped (it could never be installed)`);
      continue;
    }
    acts.push(appActions.addTemplatePackage({ templateId, id: p.id, packageName: p.packageName, version: p.version }));
  }
  return acts;
}

async function recordTypeMapping(deps: MigrationDeps, typeId: string, m: TypeMapping): Promise<void> {
  await deps.db
    .insertInto("licensing_migration_type_map")
    .values({
      license_type_id: typeId,
      app_id: m.appId,
      kind: m.kind,
      template_id: m.templateId ?? "",
      term_id: m.termId ?? "",
      created_at: deps.now(),
    })
    .onConflict((oc) => oc.column("license_type_id").doNothing())
    .execute();
}

async function migrateOneType(
  deps: MigrationDeps,
  report: MigrationReport,
  ctx: MigrationContext,
  t: LegacyLicenseType,
  rows: Map<string, { id: string; status: string }>,
): Promise<void> {
  const row = t.app ? rows.get(t.app) : undefined;
  const label = t.label ?? "";
  if (!t.app || !row || row.status === "DELETED") {
    // Nothing will ever provision for it: no term, but mapped, so the type
    // can be deleted with the others and its licences still get a kind.
    const why = !t.app ? "has no app" : !row ? `app ${t.app} has no apps row` : `app ${t.app} is DELETED`;
    const m: TypeMapping = { appId: t.app ?? "", kind: legacyKind(t), templateId: null, termId: null };
    await act(report, `licence type ${t.id} ("${label}"): ${why}; skipped, recorded in the type map without a term`, () =>
      recordTypeMapping(deps, t.id, m),
    );
    ctx.types.set(t.id, m);
    return;
  }
  const app = await deps.apps.app(t.app);
  if (!app) {
    report.problems.push(`licence type ${t.id}: app ${t.app} has no document yet (waiting for the vetra-apps backfill)`);
    return;
  }
  if (t.validityDays !== null && t.validityDays <= 0) {
    report.problems.push(`licence type ${t.id}: validityDays ${t.validityDays} is not positive; fix the licence type`);
    return;
  }
  if (app.tampered) {
    report.warnings.push(`licence type ${t.id}: app ${app.id} reads as tampered (${app.tamperReason ?? "?"}); its term is written but the app stays held`);
  }
  const templateId = t.template ? `tpl-${t.id}` : null;
  const termId = `term-${t.id}`;
  const existingTerm = app.terms.find((x) => x.id === termId);
  const planned = ctx.plannedKinds.get(app.id) ?? new Set<string>();
  let kind = existingTerm?.kind ?? legacyKind(t);
  if (!existingTerm && (app.terms.some((x) => x.kind === kind) || planned.has(kind))) {
    kind = `${kind}-${t.id.slice(0, 8)}`;
  }

  const acts: Action[] = [];
  if (templateId && !app.templates.some((x) => x.id === templateId)) {
    acts.push(...templateActions(t, templateId, t.label ?? kind, report));
  }
  if (!existingTerm) {
    acts.push(
      appActions.addTerm({ id: termId, kind, label: t.label, templateId, validityDays: t.validityDays, issuers: ["PUBLISHER_GRANT"] }),
    );
  }
  // A term is published only with a template: an ACTIVE or RETIRED type
  // without one (which the old reducers never allowed) stays DRAFT.
  let target = TERM_STATUSES.has(t.status) ? t.status : "DRAFT";
  if (!templateId && target !== "DRAFT") {
    report.warnings.push(`licence type ${t.id} is ${t.status} but has no template: its term stays DRAFT`);
    target = "DRAFT";
  }
  const current = existingTerm?.status ?? "DRAFT";
  if (target !== "DRAFT" && current === "DRAFT") acts.push(appActions.publishTerm({ id: termId }));
  if (target === "RETIRED" && current !== "RETIRED") acts.push(appActions.retireTerm({ id: termId }));

  const tpl = t.template;
  const shape = tpl
    ? `template ${templateId}: ${tpl.services.length} service(s), ${tpl.packages.length} package(s)`
    : "no template";
  const validity = t.validityDays === null ? "no end" : `${t.validityDays} days`;
  const m: TypeMapping = { appId: app.id, kind, templateId, termId };
  await act(
    report,
    `app ${app.id}: licence type ${t.id} ("${label}") -> term ${termId} (kind ${kind}, ${target}, ${validity}, ${shape})`,
    async () => {
      if (acts.length > 0) await deps.appWriter.appendLicensingOps(app.id, acts);
      await recordTypeMapping(deps, t.id, m);
    },
  );
  ctx.types.set(t.id, m);
  planned.add(kind);
  ctx.plannedKinds.set(app.id, planned);
}

export async function migrateLicenseTypes(deps: MigrationDeps, report: MigrationReport, ctx: MigrationContext): Promise<void> {
  const mapped = await deps.db.selectFrom("licensing_migration_type_map").selectAll().execute();
  for (const r of mapped) {
    ctx.types.set(r.license_type_id, {
      appId: r.app_id,
      kind: r.kind,
      templateId: r.template_id || null,
      termId: r.term_id || null,
    });
  }
  const rows = new Map((await deps.appRows()).map((r) => [r.id, r]));
  const types: LegacyLicenseType[] = [];
  for (const doc of await deps.legacyTypeDocs()) {
    const t = parseLegacyLicenseType(doc);
    if (t) types.push(t);
    else report.problems.push(`licence type document ${docId(doc) ?? "(no id)"} is unreadable; it can be neither migrated nor deleted`);
  }
  // Two types of one app may share a kind; the one that keeps it plain is
  // the live one (ACTIVE, then RETIRED, which has holders, then DRAFT), and
  // the order never depends on how the reactor lists documents.
  const rank = (t: LegacyLicenseType) => ["ACTIVE", "RETIRED", "DRAFT"].indexOf(t.status) >>> 0;
  types.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  for (const t of types) {
    if (ctx.types.has(t.id)) continue;
    try {
      await migrateOneType(deps, report, ctx, t, rows);
    } catch (err) {
      report.problems.push(`licence type ${t.id}: ${msg(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Licences: kind + DID, grants, lifecycle
// ---------------------------------------------------------------------------

function issuedByOf(details: string | null): string | null {
  if (!details) return null;
  try {
    const d: unknown = JSON.parse(details);
    const v = d !== null && typeof d === "object" ? (d as { issuedBy?: unknown }).issuedBy : null;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The kind a licence has, or (dry-run) will have once its type is migrated. */
function kindOf(l: LicenceRecord, ctx: MigrationContext, grantTypeId: string | null): string | null {
  if (l.kind) return l.kind;
  const typeId = l.legacyLicenseTypeId ?? grantTypeId;
  return (typeId && ctx.types.get(typeId)?.kind) || null;
}

type GrantRowDb = VetraLicensingDB["app_license_grants"];
type LifecycleRowDb = VetraLicensingDB["license_lifecycle"];

async function migrateOneLicence(
  deps: MigrationDeps,
  report: MigrationReport,
  ctx: MigrationContext,
  l: LicenceRecord,
  grant: GrantRowDb | undefined,
  chained: boolean,
  recorded: LifecycleRowDb | undefined,
  envOf: (licenseId: string, appId: string) => string | null,
): Promise<void> {
  // Licences the system authorised (a grant or a chain row) must end up
  // complete; anything else is held by the handler whatever happens here.
  const tracked = grant !== undefined || chained;
  const fail = (why: string) => {
    if (tracked) report.problems.push(`licence ${l.id}: ${why}`);
    else report.warnings.push(`licence ${l.id} (no provenance; held regardless): ${why}`);
  };

  const kind = kindOf(l, ctx, grant?.license_type_id || null);
  if (!kind) {
    fail(`its licence type ${l.legacyLicenseTypeId ?? grant?.license_type_id ?? "(none)"} is not migrated yet`);
    return;
  }
  if (!l.kind) {
    let user: string;
    try {
      user = normaliseUserDid(l.user);
    } catch {
      fail(`holder ${l.user} is not a wallet`);
      return;
    }
    const typeId = l.legacyLicenseTypeId ?? (grant?.license_type_id || null);
    const details = JSON.stringify({ legacyLicenseType: typeId, issuedBy: issuedByOf(l.details) ?? grant?.issued_by ?? null });
    await act(report, `licence ${l.id}: MIGRATE_LICENSE onto kind ${kind}, holder ${user}`, () =>
      withLicenceLock(l.id, () => deps.licenseGateway.execute(l.id, [licenseActions.migrateLicense({ kind, user, details })])),
    );
  }

  const env = envOf(l.id, grant?.app_id ?? l.app);
  if (env && l.stage !== env) {
    await act(report, `licence ${l.id}: stage ${env}`, () =>
      withLicenceLock(l.id, () => deps.licenseGateway.execute(l.id, [licenseActions.setStage({ stage: env })])),
    );
  }

  if (grant) {
    const patch: { kind?: string; user_did?: string } = {};
    if (grant.kind === null) patch.kind = kind;
    else if (grant.kind !== kind) {
      report.warnings.push(`licence ${l.id}: granted kind ${grant.kind} differs from its document's ${kind}; the grant stands and the handler holds the chain`);
    }
    // The holder is the grant row's (authority), never the document's.
    const did = grant.user_did ?? didForAddress(grant.user_address);
    let normalised: string;
    try {
      normalised = normaliseUserDid(did);
    } catch {
      fail(`its grant names holder ${did}, which is not a wallet`);
      return;
    }
    if (grant.user_did !== normalised) patch.user_did = normalised;
    const fields = Object.entries(patch).map(([k, v]) => `${k} ${v}`);
    if (fields.length > 0) {
      await act(report, `grant ${l.id}: ${fields.join(", ")}`, () =>
        deps.db.updateTable("app_license_grants").set(patch).where("license_id", "=", l.id).execute(),
      );
    }
  }

  if (!tracked) return;
  if (!recorded) {
    const replaced = l.replacedBy ? `, replaced by ${l.replacedBy}` : "";
    await act(report, `licence ${l.id}: record lifecycle ${l.status}, end ${l.end ?? "none"}${replaced}`, () =>
      deps.db
        .insertInto("license_lifecycle")
        .values({ license_id: l.id, status: l.status, end_at: l.end, replaced_by: l.replacedBy, updated_at: deps.now() })
        .onConflict((oc) => oc.column("license_id").doNothing())
        .execute(),
    );
    return;
  }
  if (recorded.status !== l.status) {
    report.warnings.push(`licence ${l.id}: its document says ${l.status} but the system recorded ${recorded.status}; the record stands and the handler holds the chain`);
  } else if (recorded.end_at === null && l.end !== null) {
    // A record written by a status change alone (activate/expire) has no end.
    await act(report, `licence ${l.id}: record end ${l.end}`, () =>
      deps.db.updateTable("license_lifecycle").set({ end_at: l.end }).where("license_id", "=", l.id).where("end_at", "is", null).execute(),
    );
  } else if (recorded.end_at !== null && l.end !== null && recorded.end_at !== l.end) {
    report.warnings.push(`licence ${l.id}: its document ends ${l.end} but the system recorded ${recorded.end_at}; the record stands`);
  }
}

export async function migrateLicences(deps: MigrationDeps, report: MigrationReport, ctx: MigrationContext): Promise<void> {
  const grants = new Map((await deps.db.selectFrom("app_license_grants").selectAll().execute()).map((r) => [r.license_id, r]));
  const chained = new Set((await deps.db.selectFrom("license_chain").select("license_id").execute()).map((r) => r.license_id));
  const recorded = new Map((await deps.db.selectFrom("license_lifecycle").selectAll().execute()).map((r) => [r.license_id, r]));
  const envRows = await deps.db.selectFrom("app_user_environments").selectAll().execute();
  const envOf = (licenseId: string, appId: string) =>
    envRows.find((e) => e.license_id === licenseId && e.app_id === appId)?.environment_id ?? null;
  const licences = await deps.licences();
  for (const l of licences) {
    try {
      await migrateOneLicence(deps, report, ctx, l, grants.get(l.id), chained.has(l.id), recorded.get(l.id), envOf);
    } catch (err) {
      report.problems.push(`licence ${l.id}: ${msg(err)}`);
    }
  }
  const read = new Set(licences.map((l) => l.id));
  for (const id of grants.keys()) {
    if (!read.has(id)) report.warnings.push(`licence ${id} has a grant row but no readable document; the handler holds its chain`);
  }
  // Rows written before DIDs were normalised everywhere.
  for (const row of await deps.db.selectFrom("license_environments").select(["environment_id", "user_did"]).execute()) {
    let did: string;
    try {
      did = normaliseUserDid(row.user_did);
    } catch {
      report.problems.push(`environment ${row.environment_id}: holder ${row.user_did} is not a wallet`);
      continue;
    }
    if (did === row.user_did) continue;
    await act(report, `environment ${row.environment_id}: holder ${row.user_did} -> ${did}`, () =>
      deps.db.updateTable("license_environments").set({ user_did: did }).where("environment_id", "=", row.environment_id).execute(),
    );
  }
}

// ---------------------------------------------------------------------------
// Environments: app_user_environments -> license_environments chains
// ---------------------------------------------------------------------------

/**
 * The hash to start a re-keyed environment from: the resolved template's,
 * but only when the environment already meets that template (the floor
 * update would do nothing). Otherwise the legacy hash, which differs, so the
 * handler re-templates it within its per-tick cap; never "unapplied", which
 * the handler would treat as an uncapped create.
 */
async function startingHash(
  deps: MigrationDeps,
  app: AppDocView | null,
  kind: string | null,
  environmentId: string,
  legacyHash: string,
): Promise<{ hash: string; templateId: string | null; note: string }> {
  if (!app) return { hash: legacyHash, templateId: null, note: "app document missing; legacy hash kept" };
  const res = resolveKind(app, kind);
  if (!res.ok) return { hash: legacyHash, templateId: null, note: `${res.reason}; legacy hash kept` };
  if (res.template.mode !== "DEDICATED") {
    return { hash: legacyHash, templateId: res.template.id, note: "template is SHARED; legacy hash kept (held by the handler)" };
  }
  const state = await deps.envState(environmentId);
  if (!state) return { hash: legacyHash, templateId: res.template.id, note: "environment document missing; legacy hash kept" };
  let pending: number;
  try {
    pending = renderFloorUpdateActions({ template: res.template.template, current: state }).length;
  } catch (err) {
    return { hash: legacyHash, templateId: res.template.id, note: `template does not render (${msg(err)}); legacy hash kept` };
  }
  return pending === 0
    ? { hash: res.template.templateHash, templateId: res.template.id, note: "meets its template; hash seeded" }
    : { hash: legacyHash, templateId: res.template.id, note: `${pending} update(s) pending; legacy hash kept, the handler re-templates it` };
}

export async function migrateEnvironments(deps: MigrationDeps, report: MigrationReport, ctx: MigrationContext): Promise<void> {
  const have = new Map(
    (await deps.db.selectFrom("license_environments").select(["environment_id", "root_license_id"]).execute()).map((r) => [r.environment_id, r]),
  );
  const claimedRoots = new Set([...have.values()].map((r) => r.root_license_id));
  const roots = await deps.grants.chainRoots();
  const grants = new Map((await deps.db.selectFrom("app_license_grants").selectAll().execute()).map((r) => [r.license_id, r]));
  const licences = await deps.licences();
  const byId = new Map(licences.map((l) => [l.id, l]));
  const appCache = new Map<string, AppDocView | null>();
  const appOf = async (id: string) => {
    if (!appCache.has(id)) appCache.set(id, await deps.apps.app(id));
    return appCache.get(id) ?? null;
  };

  for (const row of await deps.db.selectFrom("app_user_environments").selectAll().execute()) {
    try {
      const userDid = didForAddress(row.user_address);
      if (!have.has(row.environment_id)) {
        if (claimedRoots.has(row.license_id)) {
          report.problems.push(`environment ${row.environment_id}: chain ${row.license_id} already owns another environment`);
          continue;
        }
        const licence = byId.get(row.license_id);
        const kind = licence ? kindOf(licence, ctx, grants.get(row.license_id)?.license_type_id || null) : null;
        const start = await startingHash(deps, await appOf(row.app_id), kind, row.environment_id, row.template_hash);
        await act(report, `environment ${row.environment_id}: chain ${row.license_id} of ${userDid} on app ${row.app_id} (${start.note})`, async () => {
          await deps.grants.linkChain({ licenseId: row.license_id, rootLicenseId: row.license_id, appId: row.app_id, label: null, now: row.created_at });
          await deps.db
            .insertInto("license_environments")
            .values({
              environment_id: row.environment_id,
              root_license_id: row.license_id,
              app_id: row.app_id,
              user_did: userDid,
              license_id: row.license_id,
              template_id: start.templateId,
              label: null,
              template_hash: start.hash,
              ended_at: null,
              stopped_at: null,
              delete_after: null,
              created_at: row.created_at,
              updated_at: deps.now(),
            })
            .onConflict((oc) => oc.doNothing())
            .execute();
        });
        claimedRoots.add(row.license_id);
      }
      // The old keeper gave a holder ONE environment however many licences
      // they held. Every other authorised ACTIVE licence of that holder joins
      // this environment's chain, or the handler would provision one each.
      for (const other of licences) {
        const g = grants.get(other.id);
        if (other.id === row.license_id || !g || g.app_id !== row.app_id || other.status !== "ACTIVE") continue;
        if (roots.has(other.id) || claimedRoots.has(other.id)) continue;
        // The grant's holder (authority), never the document's.
        if (didForAddress(g.user_address) !== userDid) continue;
        await act(report, `licence ${other.id}: chained onto environment ${row.environment_id} (chain ${row.license_id})`, () =>
          deps.grants.linkChain({ licenseId: other.id, rootLicenseId: row.license_id, appId: row.app_id, label: null, now: deps.now() }),
        );
        roots.set(other.id, row.license_id);
      }
    } catch (err) {
      report.problems.push(`environment ${row.environment_id}: ${msg(err)}`);
    }
  }

  // Publishers granted without an allow list before; every existing holder
  // stays grantable. Studio licences are not publisher grants.
  for (const g of grants.values()) {
    if (g.app_id === STUDIO_APP_ID || g.issued_by === MIGRATED_FROM) continue;
    try {
      const did = normaliseUserDid(g.user_did ?? didForAddress(g.user_address));
      if (await deps.grants.isOnAllowList(g.app_id, did)) continue;
      if (report.mode === "dry-run" && report.actions.includes(`allow list ${g.app_id}: ${did}`)) continue;
      await act(report, `allow list ${g.app_id}: ${did}`, () => deps.grants.addToAllowList(g.app_id, did, g.created_at));
    } catch (err) {
      report.problems.push(`allow list for licence ${g.license_id}: ${msg(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The vetra-studio app, its codes and its holders
// ---------------------------------------------------------------------------

/** A studio holder (one wallet) and their legacy redemptions, one per code. */
interface StudioHolder {
  did: string;
  redemptions: { code: string; redeemedAt: string; accessExpires: string | null }[];
}

/**
 * Groups legacy redemptions by wallet (chain spellings normalised away). A
 * holder with any unreadable row is a problem and is left out entirely.
 */
function studioHolders(
  rows: LegacyAccessDB["invite_redemptions"][],
  report: MigrationReport,
): StudioHolder[] {
  const byDid = new Map<string, StudioHolder>();
  const broken = new Set<string>();
  for (const r of rows) {
    let did: string;
    try {
      did = normaliseUserDid(r.user_did);
    } catch {
      report.problems.push(`studio: redemption of ${codeRef(r.code)} by ${r.user_did}: not an EVM wallet DID, not migrated`);
      continue;
    }
    const redeemedAt = isoInstant(r.redeemed_at);
    const accessExpires = r.access_expires === null ? null : isoInstant(r.access_expires);
    if (redeemedAt === null || (r.access_expires !== null && accessExpires === null)) {
      report.problems.push(
        `studio: holder ${did}: redemption of ${codeRef(r.code)} has an unreadable date (redeemed_at ${JSON.stringify(r.redeemed_at)}, access_expires ${JSON.stringify(r.access_expires)}); holder not migrated`,
      );
      broken.add(did);
      continue;
    }
    const h = byDid.get(did) ?? { did, redemptions: [] };
    const same = h.redemptions.find((x) => x.code === r.code);
    // The same code redeemed from two chain spellings of one wallet: one row, the newest.
    if (!same) h.redemptions.push({ code: r.code, redeemedAt, accessExpires });
    else if (redeemedAt > same.redeemedAt) Object.assign(same, { redeemedAt, accessExpires });
    byDid.set(did, h);
  }
  return [...byDid.values()]
    .filter((h) => !broken.has(h.did))
    .map((h) => ({
      ...h,
      redemptions: h.redemptions.sort((a, b) => a.redeemedAt.localeCompare(b.redeemedAt) || a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => a.did.localeCompare(b.did));
}

function studioDetails(code: string, redemptions: number): string {
  return JSON.stringify({ code, issuedBy: MIGRATED_FROM, migratedFrom: MIGRATED_FROM, redemptions });
}

/**
 * A studio licence document a previous run created for this holder before it
 * could record the grant: adopted only when it is exactly what this run would
 * issue, so a forged look-alike can never be adopted with better terms.
 */
function adoptable(l: LicenceRecord, did: string, start: string, end: string | null): boolean {
  let user: string;
  try {
    user = normaliseUserDid(l.user);
  } catch {
    return false;
  }
  if (l.app !== STUDIO_APP_ID || user !== did || l.kind !== STUDIO_KIND || l.issuer !== "INVITE_CODE") return false;
  if (l.start !== start || l.end !== end || (l.status !== "ACTIVE" && l.status !== "EXPIRED")) return false;
  try {
    return (JSON.parse(l.details ?? "null") as { migratedFrom?: unknown } | null)?.migratedFrom === MIGRATED_FROM;
  } catch {
    return false;
  }
}

/**
 * Brings one holder to: one studio licence (from their newest redemption),
 * its grant, chain and lifecycle rows, and every redemption of theirs in the
 * new table pointing at it. Returns what was (dry-run: would be) done; does
 * it only with `apply`. Re-reads the DB, so under the holder lock it never
 * races a redeem of the same holder.
 */
async function ensureStudioHolder(
  deps: MigrationDeps,
  report: MigrationReport,
  h: StudioHolder,
  studioDocs: LicenceRecord[],
  apply: boolean,
): Promise<string[]> {
  const db = deps.db;
  const newest = h.redemptions.at(-1)!;
  const start = newest.redeemedAt;
  const end = newest.accessExpires;
  const status = end === null || end > deps.now() ? "ACTIVE" : "EXPIRED";
  const done: string[] = [];

  const grant = await db
    .selectFrom("app_license_grants")
    .select("license_id")
    .where("app_id", "=", STUDIO_APP_ID)
    .where("user_did", "=", h.did)
    .where("issued_by", "=", MIGRATED_FROM)
    .orderBy("license_id")
    .executeTakeFirst();
  let licenseId = grant?.license_id ?? studioDocs.find((l) => adoptable(l, h.did, start, end))?.id ?? null;

  if (!licenseId) {
    done.push(`issue ${status} licence ${start} - ${end ?? "open"}`);
    if (apply) {
      const issue = licenseActions.issueLicense({
        app: STUDIO_APP_ID,
        user: h.did,
        issuer: "INVITE_CODE",
        kind: STUDIO_KIND,
        stage: null,
        details: studioDetails(newest.code, h.redemptions.length),
        issued: start,
        start,
        end,
      });
      const id = await deps.licenseGateway.create();
      // One batch, recorded in license_lifecycle with its status and end.
      await deps.licenseGateway.execute(id, [
        issue,
        licenseActions.activateLicense({}),
        ...(status === "EXPIRED" ? [licenseActions.expireLicense({})] : []),
      ]);
      licenseId = id;
    }
  }
  if (licenseId) {
    const chain = await db.selectFrom("license_chain").select("license_id").where("license_id", "=", licenseId).executeTakeFirst();
    if (!chain) {
      if (grant || studioDocs.some((l) => l.id === licenseId)) done.push("chain");
      if (apply) await deps.grants.linkChain({ licenseId, rootLicenseId: licenseId, appId: STUDIO_APP_ID, label: null, now: start });
    }
    if (!grant) {
      if (studioDocs.some((l) => l.id === licenseId)) done.push(`grant for adopted licence ${licenseId}`);
      if (apply) {
        await deps.grants.recordGrant({ licenseId, appId: STUDIO_APP_ID, kind: STUDIO_KIND, userDid: h.did, issuedBy: MIGRATED_FROM, now: start });
      }
    }
    const rec = await db.selectFrom("license_lifecycle").select("license_id").where("license_id", "=", licenseId).executeTakeFirst();
    if (!rec) {
      // Only reachable for a licence whose issue was applied but not recorded.
      const doc = studioDocs.find((l) => l.id === licenseId);
      done.push(`record lifecycle ${doc?.status ?? status}`);
      if (apply) {
        await db
          .insertInto("license_lifecycle")
          .values({ license_id: licenseId, status: doc?.status ?? status, end_at: end, replaced_by: null, updated_at: deps.now() })
          .onConflict((oc) => oc.column("license_id").doNothing())
          .execute();
      }
    }
  }

  const existing = new Map(
    (await db.selectFrom("invite_redemptions").selectAll().where("user_did", "=", h.did).execute()).map((r) => [r.code, r]),
  );
  const missing = h.redemptions.filter((r) => !existing.has(r.code));
  for (const r of h.redemptions) {
    const row = existing.get(r.code);
    if (row && row.license_id === null) {
      report.warnings.push(`studio: holder ${h.did}: a redeem of ${codeRef(r.code)} is in flight (reserved, no licence); left to it`);
    }
  }
  if (missing.length > 0) {
    done.push(`link ${missing.length} redemption(s)`);
    if (apply && licenseId) {
      await db
        .insertInto("invite_redemptions")
        .values(missing.map((r) => ({ code: r.code, user_did: h.did, redeemed_at: r.redeemedAt, access_expires: r.accessExpires, license_id: licenseId })))
        .onConflict((oc) => oc.columns(["code", "user_did"]).doNothing())
        .execute();
    }
  }
  return done;
}

async function legacyRows<T>(deps: MigrationDeps, report: MigrationReport, read: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await read();
  } catch (err) {
    // A fresh install never had vetra-access-codes: its namespace is empty.
    if ((err as { code?: string } | null)?.code === "42P01") {
      report.warnings.push("studio: no legacy vetra-access-codes tables; nothing to move");
      return null;
    }
    throw err;
  }
}

/** The studio app document: created, or (squatted) protected and reconciled. */
async function ensureStudioApp(deps: MigrationDeps, report: MigrationReport): Promise<boolean> {
  const publisher = deps.cfg.studioPublisher;
  if (!publisher) {
    report.problems.push("studio: set VETRA_STUDIO_PUBLISHER_ADDRESS (or ADMINS) to create the vetra-studio app");
    return false;
  }
  const cfg = { slug: deps.cfg.studioAppSlug, publisher };
  const bySlug = await deps.apps.appBySlug(cfg.slug);
  if (bySlug && bySlug.id !== STUDIO_APP_ID) {
    report.problems.push(`studio: slug ${cfg.slug} belongs to app ${bySlug.id}; rename it, the studio app is ${STUDIO_APP_ID}`);
    return false;
  }
  const view = await deps.apps.app(STUDIO_APP_ID);
  if (!view) {
    const plan = studioReconcilePlan(null, cfg);
    await act(report, `studio: create app document ${STUDIO_APP_ID} (slug ${cfg.slug}, publisher ${publisher}) with SHARED template and ACTIVE term ${STUDIO_KIND} (30 days, INVITE_CODE)`, async () => {
      await deps.createAppDocument(STUDIO_APP_ID);
      if (deps.protectAppDocument) await deps.protectAppDocument(STUDIO_APP_ID);
      await deps.appWriter.appendLicensingOps(STUDIO_APP_ID, plan.actions);
    });
    return true;
  }
  const recorded = await deps.ledger.lookup(STUDIO_APP_ID);
  if (recorded !== null && recorded !== view.licensingStateHash) {
    report.problems.push(`studio: app document ${STUDIO_APP_ID} was changed outside Vetra after it was recorded; investigate before migrating studio licences`);
    return false;
  }
  const plan = studioReconcilePlan(view, cfg);
  // Never recorded by Vetra: someone else created it at the public id.
  const squatted = recorded === null;
  if (squatted) {
    const artifacts = view.artifacts.map((a) => a.name);
    const found = `${plan.changes.join("; ") || "nothing foreign"}${artifacts.length ? `; artifacts ${artifacts.join(", ")} (left, unused by a SHARED template)` : ""}`;
    const line = `studio: app document ${STUDIO_APP_ID} exists but Vetra never created it (squatted): protecting it and replacing its content: ${found}`;
    report.warnings.push(line);
    if (report.mode === "apply") deps.logger.error(`[licensing] migration ${line}`);
    await act(report, `studio: protect and reconcile squatted app document ${STUDIO_APP_ID} (${plan.actions.length} write(s))`, async () => {
      if (deps.protectAppDocument) await deps.protectAppDocument(STUDIO_APP_ID);
      else report.warnings.push("studio: document permissions are off; the studio app document cannot be protected");
      await deps.appWriter.appendLicensingOps(STUDIO_APP_ID, plan.actions);
    });
  } else if (plan.actions.length > 0) {
    await act(report, `studio: reconcile app document ${STUDIO_APP_ID}: ${plan.changes.join("; ") || "add the template and term"}`, () =>
      deps.appWriter.appendLicensingOps(STUDIO_APP_ID, plan.actions),
    );
  }
  return true;
}

export async function migrateStudio(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  // Without its app nothing of the studio is migrated: licences of an app
  // that cannot be read would only be held.
  if (!(await ensureStudioApp(deps, report))) return;
  if (!deps.accessDb) return;
  const access = deps.accessDb;

  const redemptions = await legacyRows(deps, report, () => access.selectFrom("invite_redemptions").selectAll().execute());
  if (redemptions) {
    const studioDocs = (await deps.licences()).filter((l) => l.app === STUDIO_APP_ID);
    for (const h of studioHolders(redemptions, report)) {
      try {
        const newest = h.redemptions.at(-1)!;
        const summary = `newest of ${h.redemptions.length}: ${codeRef(newest.code)}`;
        if (report.mode === "dry-run") {
          const would = await ensureStudioHolder(deps, report, h, studioDocs, false);
          if (would.length > 0) report.actions.push(`studio: holder ${h.did}: ${would.join("; ")} (${summary})`);
          continue;
        }
        await withHolderLock(`${STUDIO_APP_ID}\u0000${h.did}`, async () => {
          const did = await ensureStudioHolder(deps, report, h, studioDocs, true);
          if (did.length > 0) report.actions.push(`studio: holder ${h.did}: ${did.join("; ")} (${summary})`);
        });
      } catch (err) {
        report.problems.push(`studio: holder ${h.did}: ${msg(err)}`);
      }
    }
  }

  // Codes after holders: a migrated holder re-redeeming an old code then
  // finds their redemption (and licence) instead of a fresh reservation.
  const codes = await legacyRows(deps, report, () => access.selectFrom("invite_codes").selectAll().execute());
  for (const c of codes ?? []) {
    try {
      const expires = c.expires_at === null ? null : isoInstant(c.expires_at);
      if (c.expires_at !== null && expires === null) {
        report.problems.push(`studio: code ${codeRef(c.code)}: expires_at ${JSON.stringify(c.expires_at)} does not parse; not moved`);
        continue;
      }
      const there = await deps.db.selectFrom("invite_codes").select("app_id").where("code", "=", c.code).executeTakeFirst();
      if (there) {
        if (there.app_id !== STUDIO_APP_ID) report.problems.push(`studio: code ${codeRef(c.code)} already exists for app ${there.app_id}; not moved`);
        continue;
      }
      const facts = [
        c.label === null ? "no label" : `label ${JSON.stringify(c.label)}`,
        c.active ? "active" : "inactive",
        c.max_uses === null ? "no cap" : `max uses ${c.max_uses}`,
        expires === null ? "no expiry" : `expires ${expires}`,
        c.anthropic_key_ciphertext === null ? "no key" : "key attached",
      ];
      await act(report, `studio: move code ${codeRef(c.code)} (${facts.join(", ")})`, () =>
        deps.db
          .insertInto("invite_codes")
          .values({
            code: c.code,
            app_id: STUDIO_APP_ID,
            kind: STUDIO_KIND,
            label: c.label,
            active: c.active,
            expires_at: expires,
            max_uses: c.max_uses,
            // Same OpenBao transit key (prefix, role, tenant): moved, never re-encrypted.
            anthropic_key_ciphertext: c.anthropic_key_ciphertext,
            created_at: isoInstant(c.created_at) ?? c.created_at,
          })
          .onConflict((oc) => oc.column("code").doNothing())
          .execute(),
      );
    } catch (err) {
      report.problems.push(`studio: code ${codeRef(c.code)}: ${msg(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ledger: every trusted app recorded, so none reads as unverified
// ---------------------------------------------------------------------------

export async function seedLedger(deps: MigrationDeps, report: MigrationReport): Promise<void> {
  const ids = new Set([...(await deps.appRows()).map((r) => r.id), STUDIO_APP_ID]);
  for (const id of [...ids].sort()) {
    try {
      if ((await deps.ledger.lookup(id)) !== null) continue;
      const view = await deps.apps.app(id);
      // No document yet: the vetra-apps backfill creates and records it.
      if (!view) continue;
      if (view.tampered) report.warnings.push(`ledger: app ${id} reads as tampered (${view.tamperReason ?? "?"}) while being recorded`);
      if (view.templates.length + view.terms.length > 0) {
        report.warnings.push(`ledger: app ${id} was never recorded but already has ${view.templates.length} template(s) and ${view.terms.length} term(s); recording them as they stand`);
      }
      await act(report, `ledger: record app ${id} as it stands (${view.templates.length} template(s), ${view.terms.length} term(s), ${view.artifacts.length} artifact(s))`, () =>
        deps.ledger.seed(id),
      );
    } catch (err) {
      report.problems.push(`ledger: app ${id}: ${msg(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deleting the legacy licence types (after completion, when asked)
// ---------------------------------------------------------------------------

/** Each legacy type's full state is kept here (licensing_migration_steps) before its document is deleted. */
export const ARCHIVE_STEP_PREFIX = "legacy-license-type:";

/**
 * Deletes every app-license-type document the type map covers, archiving its
 * state first. Returns true when, afterwards (apply), none remain.
 */
export async function deleteLegacyLicenseTypes(deps: MigrationDeps, report: MigrationReport): Promise<boolean> {
  const mapped = new Set(
    (await deps.db.selectFrom("licensing_migration_type_map").select("license_type_id").execute()).map((r) => r.license_type_id),
  );
  const docs = await deps.legacyTypeDocs();
  let deleted = 0;
  for (const doc of docs) {
    const id = docId(doc);
    try {
      if (!id || !mapped.has(id)) {
        report.problems.push(`licence type document ${id ?? "(no id)"}: not deleted, the type map does not cover it`);
        continue;
      }
      await act(report, `delete licence type document ${id}`, async () => {
        await deps.db
          .insertInto("licensing_migration_steps")
          .values({ step: `${ARCHIVE_STEP_PREFIX}${id}`, completed_at: deps.now(), detail: JSON.stringify(globalState(doc)) })
          .onConflict((oc) => oc.column("step").doNothing())
          .execute();
        await deps.deleteDocument(id);
        deleted++;
      });
    } catch (err) {
      report.problems.push(`licence type document ${id ?? "(no id)"}: delete failed: ${msg(err)}`);
    }
  }
  if (report.mode !== "apply") return false;
  const remaining = (await deps.legacyTypeDocs()).length;
  if (remaining === 0) {
    deps.logger.warn(`[licensing] migration: deleted ${deleted} app-license-type document(s); none remain`);
    return true;
  }
  report.problems.push(`${remaining} app-license-type document(s) remain after deleting ${deleted}`);
  return false;
}
