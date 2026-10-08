import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as licenseActions } from "document-models/app-owner-license";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { createReactorEnvGateway } from "../../vetra-apps/envs.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { APP_DOC_TYPE, createAppReads } from "../app-reads.js";
import { createAppLedger, createAppLicensingWriter, reactorLedgerSource } from "../licensing-ledger.js";
import { createReactorDocGateway } from "../doc-gateway.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createLifecycleStore } from "../lifecycle.js";
import { createGrantStore } from "../grants.js";
import { createReactorLicenseReads, findAllOfType, LICENSE_DOC_TYPE } from "../reads.js";
import { LEGACY_LICENSE_TYPE_DOC_TYPE, type LegacyAccessDB } from "../migration/legacy.js";
import { STUDIO_APP_ID, STUDIO_KIND } from "../migration/studio.js";
import type { MigrationDeps } from "../migration/steps.js";
import { runLicensingMigration } from "../migration/run.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
const NOW = at(0);
const PUBLISHER = "0x00000000000000000000000000000000000000bb";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const didOf = (a: string) => `did:pkh:eip155:1:${a}`;

/** A fresh reactor + licensing db, and the migration's deps over them. */
async function world(input: { legacy: "none" | "empty-namespace" | "tables" }) {
  const client = await new ReactorClientBuilder()
    .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
    .build();
  const db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  let accessDb: Kysely<LegacyAccessDB> | null = null;
  if (input.legacy !== "none") {
    accessDb = new Kysely<LegacyAccessDB>({ dialect: new PGliteDialect(new PGlite()) });
    if (input.legacy === "tables") {
      await accessDb.schema.createTable("invite_codes")
        .addColumn("code", "varchar(255)", (c) => c.primaryKey())
        .addColumn("label", "varchar(255)")
        .addColumn("active", "boolean", (c) => c.notNull())
        .addColumn("expires_at", "varchar(255)")
        .addColumn("max_uses", "integer")
        .addColumn("created_at", "varchar(255)", (c) => c.notNull())
        .addColumn("anthropic_key_ciphertext", "text")
        .execute();
      await accessDb.schema.createTable("invite_redemptions")
        .addColumn("code", "varchar(255)", (c) => c.notNull())
        .addColumn("user_did", "varchar(255)", (c) => c.notNull())
        .addColumn("redeemed_at", "varchar(255)", (c) => c.notNull())
        .addColumn("access_expires", "varchar(255)")
        .addPrimaryKeyConstraint("pk", ["code", "user_did"])
        .execute();
    }
  }
  const ledger = createAppLedger({ db, source: reactorLedgerSource(client as never), now: () => NOW });
  const appDocs = createReactorAppDocStore(client as never, undefined, async () => ledger);
  const reads = createReactorLicenseReads(client as never);
  const lifecycle = createLifecycleStore(db, () => NOW);
  const gateway = createReactorLicenseGateway(client as never, { lifecycle });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const protect = vi.fn(async (_id: string) => {});
  const deps: MigrationDeps = {
    db,
    accessDb,
    appRows: async () => [],
    legacyTypeDocs: () => findAllOfType(client as never, LEGACY_LICENSE_TYPE_DOC_TYPE),
    licences: () => reads.allLicenceRecords(),
    apps: createAppReads(client as never, { ledger: ledger.lookup, trustedIds: async () => new Set([STUDIO_APP_ID]) }),
    appWriter: createAppLicensingWriter({
      docs: createReactorDocGateway(client as never, APP_DOC_TYPE, "app", async () => {}),
      ledger,
    }),
    ledger,
    createAppDocument: (id) => appDocs.create(id),
    protectAppDocument: protect,
    licenseGateway: gateway,
    envState: (id) => createReactorEnvGateway(client as never).getState(id),
    deleteDocument: async (id) => {
      await client.deleteDocument(id);
    },
    grants: createGrantStore(db),
    cfg: { migration: "apply", deleteLicenseTypes: true, studioAppSlug: "vetra-studio", studioPublisher: PUBLISHER },
    now: () => NOW,
    logger,
  };
  return { client, db, accessDb, deps, reads, gateway, protect, logger };
}

describe("startup migration: edges", { timeout: 60_000 }, () => {
  it("on a fresh install creates and protects the studio app and completes in one run", async () => {
    const w = await world({ legacy: "empty-namespace" });
    const report = await runLicensingMigration(w.deps);
    expect(report.problems).toStrictEqual([]);
    expect(report.complete).toBe(true);
    expect(report.deletionComplete).toBe(true); // nothing to delete
    expect(report.warnings).toContain("studio: no legacy vetra-access-codes tables; nothing to move");
    expect(w.protect).toHaveBeenCalledWith(STUDIO_APP_ID);
    expect(await w.deps.apps.appBySlug("vetra-studio")).toMatchObject({
      id: STUDIO_APP_ID, owner: PUBLISHER, unverified: false, tampered: false,
      terms: [expect.objectContaining({ kind: STUDIO_KIND, status: "ACTIVE" })],
    });
    expect(w.logger.error).not.toHaveBeenCalled();
  });

  it("without the legacy namespace at all, still builds the studio app", async () => {
    const w = await world({ legacy: "none" });
    expect(await runLicensingMigration(w.deps)).toMatchObject({ complete: true, problems: [] });
  });

  it("logs unreadable legacy rows as problems, never crashes, migrates the rest, and completes once they are fixed", async () => {
    const w = await world({ legacy: "tables" });
    const access = w.accessDb!;
    await access.insertInto("invite_codes").values([
      { code: "good-code", label: null, active: true, expires_at: null, max_uses: null, created_at: at(-50), anthropic_key_ciphertext: null },
      { code: "odd-expiry", label: null, active: true, expires_at: "next tuesday", max_uses: null, created_at: "whenever", anthropic_key_ciphertext: null },
    ]).execute();
    await access.insertInto("invite_redemptions").values([
      { code: "good-code", user_did: `did:pkh:eip155:1:${addr(1)}`, redeemed_at: at(-10), access_expires: at(20) },
      { code: "good-code", user_did: `did:pkh:eip155:1:${addr(2)}`, redeemed_at: at(-10), access_expires: "soon" },
      { code: "good-code", user_did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", redeemed_at: at(-10), access_expires: at(20) },
      // No expiry at all: an open-ended licence.
      { code: "good-code", user_did: `did:pkh:eip155:10:${addr(3)}`, redeemed_at: at(-10), access_expires: null },
    ]).execute();

    const report = await runLicensingMigration(w.deps);
    expect(report.complete).toBe(false);
    expect(report.problems).toStrictEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^studio: holder ${didOf(addr(2))}: redemption of code#[0-9a-f]{12} has an unreadable date`)),
      expect.stringMatching(/^studio: redemption of code#[0-9a-f]{12} by did:key:.*: not an EVM wallet DID, not migrated$/),
      expect.stringMatching(/^studio: code code#[0-9a-f]{12}: expires_at "next tuesday" does not parse; not moved$/),
    ]));
    expect(report.problems).toHaveLength(3);
    const grants = await w.db.selectFrom("app_license_grants").select(["user_did", "license_id"]).orderBy("user_did").execute();
    expect(grants.map((g) => g.user_did)).toStrictEqual([didOf(addr(1)), didOf(addr(3))]);
    const open = (await w.reads.licenceRecord(grants[1]!.license_id))!;
    expect(open).toMatchObject({ status: "ACTIVE", end: null });
    expect(await w.db.selectFrom("invite_codes").select("code").execute()).toStrictEqual([{ code: "good-code" }]);

    // The operator fixes the rows; the next run completes.
    await access.updateTable("invite_redemptions").set({ access_expires: at(-1) }).where("access_expires", "=", "soon").execute();
    await access.deleteFrom("invite_redemptions").where("user_did", "like", "did:key:%").execute();
    await access.updateTable("invite_codes").set({ expires_at: at(30) }).where("code", "=", "odd-expiry").execute();
    const fixed = await runLicensingMigration(w.deps);
    expect(fixed.problems).toStrictEqual([]);
    expect(fixed.complete).toBe(true);
    const lapsed = await w.db.selectFrom("app_license_grants").select("license_id").where("user_did", "=", didOf(addr(2))).executeTakeFirstOrThrow();
    expect(await w.reads.licenceRecord(lapsed.license_id)).toMatchObject({ status: "EXPIRED", end: at(-1) });
    expect((await w.db.selectFrom("invite_codes").selectAll().where("code", "=", "odd-expiry").executeTakeFirstOrThrow()).created_at).toBe("whenever");
  });

  it("adopts the licence a crashed run left without a grant, but never a look-alike with better terms", async () => {
    const w = await world({ legacy: "tables" });
    // The studio app first, so the licences below have somewhere to belong.
    expect((await runLicensingMigration(w.deps)).complete).toBe(true);
    await w.db.deleteFrom("licensing_migration_steps").execute(); // pretend we are mid-migration again
    const A = addr(0xa);
    const B = addr(0xb);
    await w.accessDb!.insertInto("invite_codes").values({ code: "c1", label: null, active: true, expires_at: null, max_uses: null, created_at: at(-50), anthropic_key_ciphertext: null }).execute();
    await w.accessDb!.insertInto("invite_redemptions").values([
      { code: "c1", user_did: didOf(A), redeemed_at: at(-10), access_expires: at(20) },
      { code: "c1", user_did: didOf(B), redeemed_at: at(-10), access_expires: at(20) },
    ]).execute();
    const issue = (user: string, end: string) =>
      licenseActions.issueLicense({
        app: STUDIO_APP_ID, user, issuer: "INVITE_CODE", kind: STUDIO_KIND, stage: null,
        details: JSON.stringify({ code: "c1", issuedBy: "vetra-access-codes", migratedFrom: "vetra-access-codes", redemptions: 1 }),
        issued: at(-10), start: at(-10), end,
      });
    // A's: exactly what the migration issues, written before the crash.
    const crashed = await w.gateway.create();
    await w.gateway.execute(crashed, [issue(didOf(A), at(20)), licenseActions.activateLicense({})]);
    // B's: someone else's look-alike that never ends.
    const plain = createReactorLicenseGateway(w.client as never);
    const forged = await plain.create();
    await plain.execute(forged, [issue(didOf(B), at(3650)), licenseActions.activateLicense({})]);

    const report = await runLicensingMigration(w.deps);
    expect(report.problems).toStrictEqual([]);
    expect(report.complete).toBe(true);
    const grants = new Map((await w.db.selectFrom("app_license_grants").select(["user_did", "license_id"]).execute()).map((g) => [g.user_did, g.license_id]));
    expect(grants.get(didOf(A))).toBe(crashed);
    expect(grants.get(didOf(B))).not.toBe(forged);
    expect(await w.reads.licenceRecord(grants.get(didOf(B))!)).toMatchObject({ end: at(20), status: "ACTIVE" });
    expect(report.actions.find((a) => a.includes(didOf(A)))).toMatch(
      new RegExp(`^studio: holder ${didOf(A)}: chain; grant for adopted licence ${crashed}; link 1 redemption\\(s\\) \\(newest of 1: code#[0-9a-f]{12}\\)$`),
    );
    expect(await findAllOfType(w.client as never, LICENSE_DOC_TYPE)).toHaveLength(3);
  });

  it("treats an unmappable licence as a problem only when the system authorised it", async () => {
    const w = await world({ legacy: "none" });
    const plain = createReactorLicenseGateway(w.client as never);
    const legacy = async () => {
      const id = await plain.create();
      await plain.execute(id, [
        licenseActions.issueLicense({
          app: "app-x", licenseType: "ghost-type", kind: null, user: addr(5), issuer: "PUBLISHER_GRANT",
          issuedBy: PUBLISHER, stage: null, details: null, issued: at(-5), start: at(-5), end: null,
        }),
      ]);
      return id;
    };
    const granted = await legacy();
    const stray = await legacy();
    await w.db.insertInto("app_license_grants").values({
      license_id: granted, app_id: "app-x", license_type_id: "ghost-type", user_address: addr(5), issued_by: PUBLISHER,
      created_at: at(-5), kind: null, user_did: null,
    }).execute();
    const report = await runLicensingMigration(w.deps);
    expect(report.problems).toStrictEqual([`licence ${granted}: its licence type ghost-type is not migrated yet`]);
    expect(report.warnings).toContain(`licence ${stray} (no provenance; held regardless): its licence type ghost-type is not migrated yet`);
    expect(report.complete).toBe(false);
  });
});
