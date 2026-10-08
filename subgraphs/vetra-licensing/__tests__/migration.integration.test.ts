import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { createPresignedHeader, type Action } from "document-model";
import { actions as appActions, utils as appUtils } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import { actions as typeActions } from "document-models/app-license-type";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { createReactorEnvGateway } from "../../vetra-apps/envs.js";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { APP_DOC_TYPE, createAppReads } from "../app-reads.js";
import { createAppLedger, createAppLicensingWriter, reactorLedgerSource } from "../licensing-ledger.js";
import { createReactorDocGateway } from "../doc-gateway.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createReactorLicenseTypeGateway } from "../license-type-gateway.js";
import { createLifecycleStore } from "../lifecycle.js";
import { createGrantStore } from "../grants.js";
import { createReactorLicenseReads, findAllOfType, LICENSE_DOC_TYPE } from "../reads.js";
import { createHolderLicences } from "../licence-view.js";
import { studioAccess, studioKeyForDid } from "../studio-access.js";
import { createStudioAccessDeps } from "../studio-access-factory.js";
import { renderCreateActions, templateHash, type TemplateShape } from "../template.js";
import { UNAPPLIED_TEMPLATE_HASH } from "../provision.js";
import { LEGACY_LICENSE_TYPE_DOC_TYPE, type LegacyAccessDB } from "../migration/legacy.js";
import { STUDIO_APP_ID, STUDIO_KIND, STUDIO_TERM_ID, STUDIO_TEMPLATE_ID } from "../migration/studio.js";
import type { MigrationDeps } from "../migration/steps.js";
import { runLicensingMigration } from "../migration/run.js";

/**
 * The startup migration against a real reactor and two PGlite databases
 * (licensing, and the legacy vetra-access-codes namespace), on data shaped
 * like production on 2026-10-08: a DRAFT licence type with no template whose
 * app document only appears once the vetra-apps backfill has run, a DELETED
 * app without a document, 46 studio holders with several redemptions each,
 * a squatted document at the public studio id. The tests run in order and
 * share state.
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
const NOW = at(0);

const OWNER = "0x00000000000000000000000000000000000000aa";
const PUBLISHER = "0x00000000000000000000000000000000000000bb";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const didOf = (a: string) => `did:pkh:eip155:1:${a.toLowerCase()}`;
const HOLDER_A = addr(0xa1);
const HOLDER_B = addr(0xb1);
const HOLDER_C = addr(0xc1);

// Apps, as the `apps` table has them.
const APP_DT = "923a0a82-64b3-494b-a8d1-01faf095c24f"; // ACTIVE; its document is created later (backfill)
const APP_DEL = "6f7c7615-0000-4000-8000-000000000001"; // DELETED, never gets a document
const APP_KV = "7d1f6f5c-1f0e-4a8b-9d55-0c3b9b8f2a11"; // ACTIVE, with a document

const PRO_TEMPLATE: TemplateShape = {
  services: [
    { id: "s-connect", type: "CONNECT", prefix: "connect", artifactName: null, artifactChannel: null },
    { id: "s-switchboard", type: "SWITCHBOARD", prefix: "switchboard", artifactName: null, artifactChannel: null },
  ],
  packages: [{ id: "p-kv", packageName: "@kv/pkg", version: "1.2.0" }],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};
const OLD_TEMPLATE: TemplateShape = {
  ...PRO_TEMPLATE,
  packages: [{ id: "p-kv", packageName: "@kv/pkg", version: "2.0.0" }],
};

const fakeTransit = {
  ensureTenantKey: async () => {},
  encrypt: async (_t: string, p: string) => p,
  decrypt: async (_t: string, c: string) => `plain:${c}`,
} as unknown as OpenBaoTransitClient;

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;
let client: Client;
let db: Kysely<VetraLicensingDB>;
let accessDb: Kysely<LegacyAccessDB>;
let deps: MigrationDeps;
const appRows: { id: string; status: string }[] = [
  { id: APP_DT, status: "ACTIVE" },
  { id: APP_DEL, status: "DELETED" },
  { id: APP_KV, status: "ACTIVE" },
];
const protect = vi.fn(async (_id: string) => {});
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let appDocs: ReturnType<typeof createReactorAppDocStore>;
let reads: ReturnType<typeof createReactorLicenseReads>;
const ids: Record<string, string> = {};

/** One studio holder of the 46: their legacy redemptions, newest last. */
interface SeedHolder {
  address: string;
  redemptions: { code: string; did: string; redeemed: string; expires: string }[];
}
const holders: SeedHolder[] = [];

async function legacyTables(k: Kysely<LegacyAccessDB>) {
  // As vetra-access-codes created them (that subgraph is deleted in Task 17).
  await k.schema.createTable("invite_codes")
    .addColumn("code", "varchar(255)", (c) => c.notNull().primaryKey())
    .addColumn("label", "varchar(255)")
    .addColumn("active", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("expires_at", "varchar(255)")
    .addColumn("max_uses", "integer")
    .addColumn("created_at", "varchar(255)", (c) => c.notNull())
    .addColumn("anthropic_key_ciphertext", "text")
    .execute();
  await k.schema.createTable("invite_redemptions")
    .addColumn("code", "varchar(255)", (c) => c.notNull())
    .addColumn("user_did", "varchar(255)", (c) => c.notNull())
    .addColumn("redeemed_at", "varchar(255)", (c) => c.notNull())
    .addColumn("access_expires", "varchar(255)")
    .addPrimaryKeyConstraint("invite_redemptions_pkey", ["code", "user_did"])
    .execute();
}

/** A licence the pre-terms keeper/publisher wrote: legacy ISSUE_LICENSE shape, no lifecycle record. */
async function legacyLicence(input: {
  app: string; type: string; holder: string; start: string; end: string | null; status: "ACTIVE" | "EXPIRED";
}): Promise<string> {
  const plain = createReactorLicenseGateway(client as never);
  const id = await plain.create();
  await plain.execute(id, [
    licenseActions.issueLicense({
      app: input.app, licenseType: input.type, kind: null, user: input.holder, issuer: "PUBLISHER_GRANT",
      issuedBy: OWNER, stage: null, details: null, issued: input.start, start: input.start, end: input.end,
    }),
    licenseActions.activateLicense({}),
    ...(input.status === "EXPIRED" ? [licenseActions.expireLicense({})] : []),
  ]);
  return id;
}

/** The grant row the pre-terms recordGrant wrote: license_type_id set, no kind, no DID. */
async function legacyGrant(licenseId: string, app: string, type: string, holder: string) {
  await db.insertInto("app_license_grants").values({
    license_id: licenseId, app_id: app, license_type_id: type, user_address: holder.toLowerCase(),
    issued_by: OWNER, created_at: at(-90), kind: null, user_did: null,
  }).execute();
}

async function legacyType(input: {
  app: string; kind: string; label: string; validityDays: number; template: TemplateShape | null;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
}): Promise<string> {
  const gw = createReactorLicenseTypeGateway(client as never);
  const id = await gw.create();
  const acts: Action[] = [typeActions.setLicenseTypeDetails({ app: input.app, kind: input.kind, label: input.label, validityDays: input.validityDays })];
  if (input.template) {
    acts.push(typeActions.setTemplate({ size: input.template.size, baseDomain: input.template.baseDomain, packageRegistry: input.template.packageRegistry }));
    for (const s of input.template.services) {
      acts.push(typeActions.addTemplateService({ id: s.id, type: s.type as never, prefix: s.prefix, artifactName: s.artifactName, artifactChannel: null }));
    }
    for (const p of input.template.packages) {
      acts.push(typeActions.addTemplatePackage({ id: p.id, packageName: p.packageName, version: p.version }));
    }
  }
  if (input.status !== "DRAFT") acts.push(typeActions.publishLicenseType({}));
  if (input.status === "RETIRED") acts.push(typeActions.retireLicenseType({}));
  await gw.execute(id, acts);
  return id;
}

/** An environment built from `template`, owned by `holder`. */
async function environment(holder: string, template: TemplateShape): Promise<string> {
  const envs = createReactorEnvGateway(client as never);
  const id = await envs.create();
  await envs.execute(id, renderCreateActions({ label: "Project", subdomain: `s-${id.slice(0, 8)}`, owner: holder, template }));
  return id;
}

const TABLES = [
  "app_licensing_state", "app_licensing_intent", "app_license_grants", "app_user_environments",
  "license_chain", "license_environments", "app_allow_list", "invite_codes", "invite_redemptions",
  "licensing_migration_type_map", "licensing_migration_steps", "license_lifecycle",
] as const;

/** Every licensing row, every document's revision: a run that changes nothing leaves this equal. */
async function snapshot() {
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    const rows = await db.selectFrom(t).selectAll().execute();
    tables[t] = rows.map((r) => JSON.stringify(r)).sort();
  }
  const revisions: Record<string, unknown> = {};
  for (const type of [APP_DOC_TYPE, LICENSE_DOC_TYPE, LEGACY_LICENSE_TYPE_DOC_TYPE, "powerhouse/vetra-cloud-environment"]) {
    for (const d of (await findAllOfType(client as never, type)) as { header: { id: string; revision: unknown } }[]) {
      revisions[d.header.id] = d.header.revision;
    }
  }
  return { tables, revisions };
}

const countOf = async (type: string) => (await findAllOfType(client as never, type)).length;
const rawState = async (id: string) =>
  ((await client.get(id)) as unknown as { state: { global: Record<string, unknown> } }).state.global;

beforeAll(async () => {
  client = await new ReactorClientBuilder()
    .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
    .build();
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  accessDb = new Kysely<LegacyAccessDB>({ dialect: new PGliteDialect(new PGlite()) });
  await legacyTables(accessDb);

  const ledger = createAppLedger({ db, source: reactorLedgerSource(client as never), now: () => NOW });
  // As the vetra-apps backfill: create records the ledger, writes go through it.
  appDocs = createReactorAppDocStore(client as never, undefined, async () => ledger);
  reads = createReactorLicenseReads(client as never);
  const lifecycle = createLifecycleStore(db, () => NOW);

  // APP_KV exists with a document (backfilled, recorded).
  await appDocs.create(APP_KV);
  await appDocs.execute(APP_KV, [appActions.setAppDetails({ name: "KV", slug: "kv", owner: OWNER }), appActions.setStatus({ status: "ACTIVE" })]);

  // Legacy licence types. T_FREE is production's one: DRAFT, no template.
  ids.T_FREE = await legacyType({ app: APP_DT, kind: "Free", label: "Friday", validityDays: 365, template: null, status: "DRAFT" });
  ids.T_DEL = await legacyType({ app: APP_DEL, kind: "Gone", label: "Gone", validityDays: 30, template: PRO_TEMPLATE, status: "ACTIVE" });
  ids.T_PRO = await legacyType({ app: APP_KV, kind: "PRO", label: "Pro", validityDays: 30, template: PRO_TEMPLATE, status: "ACTIVE" });
  ids.T_OLD = await legacyType({ app: APP_KV, kind: "PRO", label: "Pro (old)", validityDays: 30, template: OLD_TEMPLATE, status: "RETIRED" });

  // Legacy licences of APP_KV.
  ids.L1 = await legacyLicence({ app: APP_KV, type: ids.T_PRO, holder: HOLDER_A, start: at(-40), end: at(20), status: "ACTIVE" });
  ids.L2 = await legacyLicence({ app: APP_KV, type: ids.T_PRO, holder: HOLDER_A, start: at(-5), end: at(25), status: "ACTIVE" });
  ids.L3 = await legacyLicence({ app: APP_KV, type: ids.T_OLD, holder: HOLDER_B, start: at(-80), end: at(-50), status: "EXPIRED" });
  ids.L4 = await legacyLicence({ app: APP_KV, type: ids.T_PRO, holder: HOLDER_C, start: at(-3), end: at(27), status: "ACTIVE" });
  // A chain from before kinds: L5 replaced by L6.
  ids.L5 = await legacyLicence({ app: APP_KV, type: ids.T_OLD, holder: HOLDER_C, start: at(-70), end: at(-40), status: "ACTIVE" });
  ids.L6 = await legacyLicence({ app: APP_KV, type: ids.T_PRO, holder: HOLDER_C, start: at(-41), end: at(10), status: "ACTIVE" });
  await createReactorLicenseGateway(client as never).execute(ids.L5, [licenseActions.replaceLicense({ replacedBy: ids.L6 })]);
  for (const [l, type, holder] of [
    [ids.L1, ids.T_PRO, HOLDER_A], [ids.L2, ids.T_PRO, HOLDER_A], [ids.L3, ids.T_OLD, HOLDER_B],
    [ids.L5, ids.T_OLD, HOLDER_C], [ids.L6, ids.T_PRO, HOLDER_C],
  ] as const) {
    await legacyGrant(l, APP_KV, type, holder);
  }
  await db.insertInto("license_chain").values({ license_id: ids.L6, root_license_id: ids.L5, app_id: APP_KV, label: null, created_at: at(-41) }).execute();
  // The keeper activated L1 after license_lifecycle existed: a record without an end.
  await db.insertInto("license_lifecycle").values({ license_id: ids.L1, status: "ACTIVE", end_at: null, replaced_by: null, updated_at: at(-1) }).execute();
  void lifecycle;

  // Live environments of the old keeper: ENV_A already matches T_PRO's template, ENV_B does not match T_OLD's.
  ids.ENV_A = await environment(HOLDER_A, PRO_TEMPLATE);
  ids.ENV_B = await environment(HOLDER_B, { ...OLD_TEMPLATE, packages: [] });
  await db.insertInto("app_user_environments").values([
    { app_id: APP_KV, user_address: HOLDER_A, environment_id: ids.ENV_A, license_id: ids.L1, template_hash: "old-hash-a", created_at: at(-40), updated_at: at(-40) },
    { app_id: APP_KV, user_address: HOLDER_B, environment_id: ids.ENV_B, license_id: ids.L3, template_hash: "old-hash-b", created_at: at(-80), updated_at: at(-80) },
  ]).execute();

  // A document someone squatted at the public studio id before Vetra created it.
  const squat = appUtils.createDocument();
  squat.header = createPresignedHeader(STUDIO_APP_ID, APP_DOC_TYPE);
  await client.create(squat);
  await client.execute(STUDIO_APP_ID, "main", [
    appActions.setAppDetails({ name: "Totally Studio", slug: "vetra-studio", owner: addr(0xbad) }),
    appActions.setStatus({ status: "ACTIVE" }),
    appActions.addTemplate({ id: "evil-tpl", name: "Evil", mode: "DEDICATED" }),
    appActions.addTemplateService({ templateId: "evil-tpl", id: "s", type: "CONNECT", prefix: null, artifactName: null, artifactChannel: null }),
    appActions.addTerm({ id: "evil-term", kind: STUDIO_KIND, label: "Forever", templateId: "evil-tpl", validityDays: null, issuers: ["INVITE_CODE"] }),
    appActions.publishTerm({ id: "evil-term" }),
  ]);

  // Legacy access codes: 3 named codes and filler, as vetra-access-codes stored them.
  await accessDb.insertInto("invite_codes").values([
    { code: "cohort-1", label: "Cohort 1", active: true, expires_at: null, max_uses: 100, created_at: at(-200), anthropic_key_ciphertext: "vault:v1:abc" },
    { code: "cohort-2", label: null, active: true, expires_at: at(60), max_uses: null, created_at: at(-150), anthropic_key_ciphertext: null },
    { code: "lapsed", label: "Old", active: false, expires_at: at(-5), max_uses: 3, created_at: at(-300), anthropic_key_ciphertext: "vault:v1:old" },
    ...Array.from({ length: 20 }, (_, i) => ({
      code: `filler-${i}`, label: null, active: true, expires_at: null, max_uses: 1, created_at: at(-100), anthropic_key_ciphertext: null,
    })),
  ]).execute();
  // 46 holders, 7 of them live; several redemptions each, some under two chain spellings.
  for (let i = 0; i < 46; i++) {
    const address = addr(0x1000 + i);
    const h: SeedHolder = { address, redemptions: [] };
    if (i % 3 === 0) {
      h.redemptions.push({ code: "lapsed", did: `did:pkh:eip155:1:${address}`, redeemed: at(-100 - i), expires: at(-70 - i) });
    }
    if (i === 0) {
      // Live with a keyed code, then redeemed a keyless one: the key stays.
      h.redemptions.push({ code: "cohort-1", did: `did:pkh:eip155:1:${address}`, redeemed: at(-20), expires: at(10) });
      h.redemptions.push({ code: "filler-0", did: `did:pkh:eip155:1:${address}`, redeemed: at(-10), expires: at(20) });
    } else {
      const live = i < 7;
      const code = i % 2 === 0 ? "cohort-1" : "cohort-2";
      const redeemed = live ? at(-10) : at(-60 - i);
      const expires = live ? at(20) : at(-30 - i);
      h.redemptions.push({ code, did: `did:pkh:eip155:1:${address}`, redeemed, expires });
      if (i % 5 === 0) {
        // The same wallet redeemed the same code from another chain earlier.
        h.redemptions.unshift({ code, did: `did:pkh:eip155:137:${address}`, redeemed: at(live ? -11 : -61 - i), expires: at(live ? 19 : -31 - i) });
      }
    }
    holders.push(h);
  }
  await accessDb.insertInto("invite_redemptions").values(
    holders.flatMap((h) => h.redemptions.map((r) => ({ code: r.code, user_did: r.did, redeemed_at: r.redeemed, access_expires: r.expires }))),
  ).execute();

  const appLedger = createAppLedger({ db, source: reactorLedgerSource(client as never), now: () => NOW });
  deps = {
    db,
    accessDb,
    appRows: async () => appRows,
    legacyTypeDocs: () => findAllOfType(client as never, LEGACY_LICENSE_TYPE_DOC_TYPE),
    licences: () => reads.allLicenceRecords(),
    apps: createAppReads(client as never, {
      ledger: appLedger.lookup,
      trustedIds: async () => new Set([...appRows.map((r) => r.id), STUDIO_APP_ID]),
    }),
    appWriter: createAppLicensingWriter({
      docs: createReactorDocGateway(client as never, APP_DOC_TYPE, "app", async () => {}),
      ledger: appLedger,
    }),
    ledger: appLedger,
    createAppDocument: (id) => appDocs.create(id),
    protectAppDocument: protect,
    licenseGateway: createReactorLicenseGateway(client as never, { lifecycle }),
    envState: (id) => createReactorEnvGateway(client as never).getState(id),
    deleteDocument: async (id) => {
      await client.deleteDocument(id);
    },
    grants: createGrantStore(db),
    cfg: { migration: "apply", deleteLicenseTypes: false, studioAppSlug: "vetra-studio", studioPublisher: PUBLISHER },
    now: () => NOW,
    logger,
  };
}, 180_000);

const dryRun = () => runLicensingMigration({ ...deps, cfg: { ...deps.cfg, migration: "dry-run" } });

describe("startup migration on production-shaped data", { timeout: 60_000 }, () => {
  it("dry-run writes nothing at all and lists, one line each, what it would do", async () => {
    const before = await snapshot();
    const report = await dryRun();
    expect(await snapshot()).toStrictEqual(before);
    expect(report.complete).toBe(false);
    expect(protect).not.toHaveBeenCalled();
    expect(await db.selectFrom("licensing_migration_steps").selectAll().execute()).toStrictEqual([]);

    // The licence type waits for its app's document; the DELETED app's is skipped, not pending.
    expect(report.problems).toStrictEqual([
      `licence type ${ids.T_FREE}: app ${APP_DT} has no document yet (waiting for the vetra-apps backfill)`,
    ]);
    expect(report.actions).toContain(
      `licence type ${ids.T_DEL} ("Gone"): app ${APP_DEL} is DELETED; skipped, recorded in the type map without a term`,
    );
    expect(report.actions.filter((a) => a.startsWith(`app ${APP_KV}: licence type`))).toHaveLength(2);
    // Planned kinds carry into the licence plan: nothing is "not mapped yet".
    expect(report.actions).toContain(`licence ${ids.L1}: MIGRATE_LICENSE onto kind PRO, holder ${didOf(HOLDER_A)}`);
    expect(report.actions.filter((a) => a.startsWith("studio: holder "))).toHaveLength(46);
    expect(report.actions.filter((a) => a.startsWith("studio: move code "))).toHaveLength(23);
    expect(report.actions.some((a) => a.includes("cohort-1"))).toBe(false); // codes are logged by reference
    expect(report.warnings.some((w) => w.includes("squatted"))).toBe(true);

    const lines = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(
      `[licensing] migration dry-run: studio: move code ${report.actions.find((a) => a.startsWith("studio: move code "))!.slice("studio: move code ".length)}`,
    );
    expect(logger.warn.mock.calls.map((c) => String(c[0]))).toContain(
      `[licensing] migration (dry-run): ${report.actions.length} actions, 1 problems, ${report.warnings.length} warnings`,
    );
  });

  it("apply migrates everything it can and is not complete while an app document is missing", async () => {
    const report = await runLicensingMigration(deps);
    expect(report.problems).toStrictEqual([
      `licence type ${ids.T_FREE}: app ${APP_DT} has no document yet (waiting for the vetra-apps backfill)`,
    ]);
    expect(report.complete).toBe(false);
    expect(await db.selectFrom("licensing_migration_steps").selectAll().execute()).toStrictEqual([]);
  });

  it("turns licence types into templates and terms with fidelity, through the ledger", async () => {
    const app = (await deps.apps.app(APP_KV))!;
    expect(app).toMatchObject({ tampered: false, unverified: false });
    expect(app.terms.find((t) => t.id === `term-${ids.T_PRO}`)).toStrictEqual({
      id: `term-${ids.T_PRO}`, kind: "PRO", label: "Pro", templateId: `tpl-${ids.T_PRO}`, validityDays: 30,
      issuers: ["PUBLISHER_GRANT"], status: "ACTIVE",
    });
    const old = app.terms.find((t) => t.id === `term-${ids.T_OLD}`)!;
    expect(old).toMatchObject({ kind: `PRO-${ids.T_OLD.slice(0, 8)}`, status: "RETIRED", label: "Pro (old)" });
    const tpl = app.templates.find((t) => t.id === `tpl-${ids.T_PRO}`)!;
    expect(tpl).toMatchObject({ mode: "DEDICATED", name: "Pro" });
    expect(tpl.template.services.map((s) => [s.type, s.prefix])).toStrictEqual([["CONNECT", "connect"], ["SWITCHBOARD", "switchboard"]]);
    expect(tpl.template.packages).toStrictEqual([{ id: "p-kv", packageName: "@kv/pkg", version: "1.2.0" }]);
    expect(await db.selectFrom("licensing_migration_type_map").select(["license_type_id", "app_id", "kind", "term_id"]).orderBy("license_type_id").execute())
      .toStrictEqual([
        { license_type_id: ids.T_DEL, app_id: APP_DEL, kind: "Gone", term_id: "" },
        { license_type_id: ids.T_OLD, app_id: APP_KV, kind: `PRO-${ids.T_OLD.slice(0, 8)}`, term_id: `term-${ids.T_OLD}` },
        { license_type_id: ids.T_PRO, app_id: APP_KV, kind: "PRO", term_id: `term-${ids.T_PRO}` },
      ].sort((a, b) => a.license_type_id.localeCompare(b.license_type_id)));
  });

  it("migrates licences onto kinds and DIDs, fills grants, and records the lifecycle of every chain member", async () => {
    const l1 = (await reads.licenceRecord(ids.L1))!;
    expect(l1).toMatchObject({ kind: "PRO", user: didOf(HOLDER_A), stage: ids.ENV_A });
    expect(JSON.parse(l1.details!)).toStrictEqual({ legacyLicenseType: ids.T_PRO, issuedBy: OWNER });
    const raw = await rawState(ids.L1);
    expect(Object.keys(raw)).not.toContain("licenseType");
    expect(Object.keys(raw)).not.toContain("issuedBy");
    expect((await reads.licenceRecord(ids.L3))!.kind).toBe(`PRO-${ids.T_OLD.slice(0, 8)}`);

    expect(await db.selectFrom("app_license_grants").select(["license_id", "kind", "user_did"]).orderBy("license_id").execute())
      .toStrictEqual([
        { license_id: ids.L1, kind: "PRO", user_did: didOf(HOLDER_A) },
        { license_id: ids.L2, kind: "PRO", user_did: didOf(HOLDER_A) },
        { license_id: ids.L3, kind: `PRO-${ids.T_OLD.slice(0, 8)}`, user_did: didOf(HOLDER_B) },
        { license_id: ids.L5, kind: `PRO-${ids.T_OLD.slice(0, 8)}`, user_did: didOf(HOLDER_C) },
        { license_id: ids.L6, kind: "PRO", user_did: didOf(HOLDER_C) },
        ...(await db.selectFrom("app_license_grants").select(["license_id", "kind", "user_did"]).where("app_id", "=", STUDIO_APP_ID).execute()),
      ].sort((a, b) => a.license_id.localeCompare(b.license_id)));
    // L4 has no grant row: migrated, still unauthorised (held), no lifecycle row.
    expect((await reads.licenceRecord(ids.L4))!.kind).toBe("PRO");

    const lifecycle = new Map((await db.selectFrom("license_lifecycle").selectAll().execute()).map((r) => [r.license_id, r]));
    expect(lifecycle.get(ids.L1)).toMatchObject({ status: "ACTIVE", end_at: at(20) }); // end upserted
    expect(lifecycle.get(ids.L3)).toMatchObject({ status: "EXPIRED", end_at: at(-50) });
    expect(lifecycle.get(ids.L5)).toMatchObject({ status: "REPLACED", replaced_by: ids.L6, end_at: at(-40) });
    expect(lifecycle.get(ids.L6)).toMatchObject({ status: "ACTIVE", end_at: at(10) });
    expect(lifecycle.has(ids.L4)).toBe(false);
  });

  it("re-keys live environments without touching them, seeding the hash only where the environment already matches", async () => {
    const rows = await db.selectFrom("license_environments").selectAll().orderBy("root_license_id").execute();
    const a = rows.find((r) => r.environment_id === ids.ENV_A)!;
    const b = rows.find((r) => r.environment_id === ids.ENV_B)!;
    expect(rows).toHaveLength(2);
    expect(a).toMatchObject({
      root_license_id: ids.L1, license_id: ids.L1, user_did: didOf(HOLDER_A), app_id: APP_KV,
      template_id: `tpl-${ids.T_PRO}`, template_hash: templateHash(PRO_TEMPLATE), ended_at: null, stopped_at: null,
    });
    // Does not meet its template: the legacy hash stays, so the handler re-templates it within its cap.
    expect(b).toMatchObject({ root_license_id: ids.L3, template_hash: "old-hash-b", template_id: `tpl-${ids.T_OLD}` });
    expect(b.template_hash).not.toBe(UNAPPLIED_TEMPLATE_HASH);
    // The holder's second ACTIVE licence joins the existing environment's chain.
    expect(await deps.grants.chainRootOf(ids.L2)).toBe(ids.L1);
    expect((await deps.grants.allowList(APP_KV)).map((e) => e.user).sort()).toStrictEqual(
      [didOf(HOLDER_A), didOf(HOLDER_B), didOf(HOLDER_C)].sort(),
    );
  });

  it("reconciles the squatted studio document to exactly the studio template and term, loudly", async () => {
    expect(protect).toHaveBeenCalledWith(STUDIO_APP_ID);
    expect(logger.error.mock.calls.map((c) => String(c[0])).some((m) => m.includes("squatted") && m.includes("evil-term"))).toBe(true);
    const studio = (await deps.apps.appBySlug("vetra-studio"))!;
    expect(studio).toMatchObject({
      id: STUDIO_APP_ID, name: "Vetra Studio", owner: PUBLISHER, status: "ACTIVE", tampered: false, unverified: false,
    });
    expect(studio.templates.map((t) => [t.id, t.mode])).toStrictEqual([[STUDIO_TEMPLATE_ID, "SHARED"]]);
    expect(studio.terms).toStrictEqual([{
      id: STUDIO_TERM_ID, kind: STUDIO_KIND, label: "Studio early access (30 days)", templateId: STUDIO_TEMPLATE_ID,
      validityDays: 30, issuers: ["INVITE_CODE"], status: "ACTIVE",
    }]);
  });

  it("moves every code with its cap, flags, expiry and ciphertext", async () => {
    const codes = await db.selectFrom("invite_codes").selectAll().orderBy("code").execute();
    expect(codes).toHaveLength(23);
    expect(codes.every((c) => c.app_id === STUDIO_APP_ID && c.kind === STUDIO_KIND)).toBe(true);
    expect(codes.find((c) => c.code === "cohort-1")).toMatchObject({
      label: "Cohort 1", active: true, expires_at: null, max_uses: 100, anthropic_key_ciphertext: "vault:v1:abc",
    });
    expect(codes.find((c) => c.code === "lapsed")).toMatchObject({
      active: false, expires_at: at(-5), max_uses: 3, anthropic_key_ciphertext: "vault:v1:old",
    });
  });

  it("gives each of the 46 holders one studio licence from their newest redemption, ACTIVE or EXPIRED", async () => {
    const grants = await db.selectFrom("app_license_grants").selectAll().where("app_id", "=", STUDIO_APP_ID).execute();
    expect(grants).toHaveLength(46);
    expect(new Set(grants.map((g) => g.user_did)).size).toBe(46);
    expect(grants.every((g) => g.kind === STUDIO_KIND && g.issued_by === "vetra-access-codes")).toBe(true);
    const lifecycle = new Map((await db.selectFrom("license_lifecycle").selectAll().execute()).map((r) => [r.license_id, r]));
    let active = 0;
    for (const h of holders) {
      const did = didOf(h.address);
      const g = grants.find((x) => x.user_did === did)!;
      const newest = h.redemptions.at(-1)!;
      const l = (await reads.licenceRecord(g.license_id))!;
      const status = newest.expires > NOW ? "ACTIVE" : "EXPIRED";
      if (status === "ACTIVE") active++;
      expect(l).toMatchObject({ app: STUDIO_APP_ID, user: did, kind: STUDIO_KIND, issuer: "INVITE_CODE", status, start: newest.redeemed, end: newest.expires });
      expect(lifecycle.get(g.license_id)).toMatchObject({ status, end_at: newest.expires });
      // Every redemption of the holder stays resolvable by (licence, holder).
      const rows = await db.selectFrom("invite_redemptions").selectAll().where("user_did", "=", did).execute();
      expect(rows.length).toBe(new Set(h.redemptions.map((r) => r.code)).size);
      expect(rows.every((r) => r.license_id === g.license_id)).toBe(true);
    }
    expect(active).toBe(7);
    // Redemptions merged across chain spellings: one row per (code, holder).
    expect(await db.selectFrom("invite_redemptions").select("user_did").where("user_did", "like", "did:pkh:eip155:137:%").execute()).toStrictEqual([]);
  });

  it("a second apply changes nothing while still waiting", async () => {
    const before = await snapshot();
    const report = await runLicensingMigration(deps);
    expect(report.actions).toStrictEqual([]);
    expect(report.complete).toBe(false);
    expect(await snapshot()).toStrictEqual(before);
  });

  it("completes once the backfill creates the app document, and never touches an environment", async () => {
    await appDocs.create(APP_DT);
    await appDocs.execute(APP_DT, [appActions.setAppDetails({ name: "dtbau", slug: "dtbau-package", owner: OWNER }), appActions.setStatus({ status: "ACTIVE" })]);
    const envsBefore = (await snapshot()).revisions;
    const report = await runLicensingMigration(deps);
    expect(report.problems).toStrictEqual([]);
    expect(report.actions).toStrictEqual([
      `app ${APP_DT}: licence type ${ids.T_FREE} ("Friday") -> term term-${ids.T_FREE} (kind Free, DRAFT, 365 days, no template)`,
    ]);
    expect(report.complete).toBe(true);
    expect(await db.selectFrom("licensing_migration_steps").select("step").execute()).toStrictEqual([{ step: "complete" }]);
    const dt = (await deps.apps.app(APP_DT))!;
    expect(dt.terms).toStrictEqual([{
      id: `term-${ids.T_FREE}`, kind: "Free", label: "Friday", templateId: null, validityDays: 365, issuers: ["PUBLISHER_GRANT"], status: "DRAFT",
    }]);
    expect(dt.templates).toStrictEqual([]);
    const after = (await snapshot()).revisions;
    for (const id of [ids.ENV_A, ids.ENV_B]) expect(after[id]).toStrictEqual(envsBefore[id]);
    // Every trusted app with a document is in the ledger: nothing reads as unverified.
    for (const id of [APP_DT, APP_KV, STUDIO_APP_ID]) {
      expect(await deps.apps.app(id)).toMatchObject({ unverified: false, tampered: false });
    }
  });

  it("a run after completion changes nothing", async () => {
    const before = await snapshot();
    const report = await runLicensingMigration(deps);
    expect(report).toMatchObject({ complete: true, actions: [], problems: [] });
    expect(await snapshot()).toStrictEqual(before);
  });

  it("serves the studio key end to end for a migrated holder", async () => {
    const studio = createStudioAccessDeps({
      client: client as never,
      licensingDb: db,
      trustedIds: async () => new Set([...appRows.map((r) => r.id), STUDIO_APP_ID]),
      transit: fakeTransit,
      slug: "vetra-studio",
    });
    const [h0, h1, h7] = [holders[0]!, holders[1]!, holders[7]!];
    // Live, newest code keyless, an older live redemption keyed: the key comes from it.
    expect(await studioKeyForDid(studio, `did:pkh:eip155:137:${h0.address}`)).toBe("plain:vault:v1:abc");
    expect(await studioAccess(studio, didOf(h0.address))).toMatchObject({ allowed: true, hasAttachedKey: true, expires: at(20) });
    // Live on a keyless code.
    expect(await studioAccess(studio, didOf(h1.address))).toMatchObject({ allowed: true, hasAttachedKey: false });
    // Lapsed: not allowed, but the licence is there for the "ended" banner.
    const lapsed = await studioAccess(studio, didOf(h7.address));
    expect(lapsed).toMatchObject({ allowed: false, expires: h7.redemptions.at(-1)!.expires });
    expect(lapsed.licenseId).not.toBeNull();
    const holderLicences = createHolderLicences({ licences: reads, lifecycle: createLifecycleStore(db, () => NOW), grants: deps.grants });
    expect((await holderLicences(STUDIO_APP_ID, didOf(h7.address))).map((l) => l.status)).toStrictEqual(["EXPIRED"]);
  });

  it("deletes the legacy licence types only when asked, after completion, archiving each one", async () => {
    expect(await countOf(LEGACY_LICENSE_TYPE_DOC_TYPE)).toBe(4);
    await runLicensingMigration({ ...deps, cfg: { ...deps.cfg, migration: "dry-run", deleteLicenseTypes: true } });
    expect(await countOf(LEGACY_LICENSE_TYPE_DOC_TYPE)).toBe(4);
    const report = await runLicensingMigration({ ...deps, cfg: { ...deps.cfg, deleteLicenseTypes: true } });
    expect(report.problems).toStrictEqual([]);
    expect(report.actions.filter((a) => a.startsWith("delete licence type document "))).toHaveLength(4);
    expect(report.deletionComplete).toBe(true);
    expect(await countOf(LEGACY_LICENSE_TYPE_DOC_TYPE)).toBe(0);
    const archived = await db.selectFrom("licensing_migration_steps").selectAll().where("step", "like", "legacy-license-type:%").execute();
    expect(archived.map((r) => r.step).sort()).toStrictEqual(
      [ids.T_FREE, ids.T_DEL, ids.T_PRO, ids.T_OLD].map((id) => `legacy-license-type:${id}`).sort(),
    );
    expect(JSON.parse(archived.find((r) => r.step.endsWith(ids.T_FREE!))!.detail!)).toMatchObject({ kind: "Free", label: "Friday", validityDays: 365, template: null });
    expect(logger.warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[licensing] migration: deleted 4 app-license-type document(s); none remain",
    );
    // Licences and environments are untouched by the deletion.
    expect(await db.selectFrom("license_environments").selectAll().execute()).toHaveLength(2);
  });
});
