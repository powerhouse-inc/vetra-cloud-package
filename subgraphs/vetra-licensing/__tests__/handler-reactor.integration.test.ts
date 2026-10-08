import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import { documentModels } from "../../../document-models/document-models.js";
import { createReactorAppDocStore } from "../../vetra-apps/app-doc-store.js";
import { createReactorEnvGateway, ENV_DOC_TYPE } from "../../vetra-apps/envs.js";
import { generateSubdomain } from "../../../shared/subdomain-generator.js";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { createAppReads } from "../app-reads.js";
import { createReactorLicenseReads } from "../reads.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createGrantStore } from "../grants.js";
import { issueLicense } from "../issue.js";
import { createAppLedger, reactorLedgerSource } from "../licensing-ledger.js";
import { loadLicensingConfig } from "../config.js";
import { createChainEnvironmentRows, provisionChain, type ChainEnvDeps } from "../environments.js";
import { AppLicenseHandler } from "../handler.js";
import { createLifecycleStore } from "../lifecycle.js";

/**
 * The handler against a REAL reactor and a REAL database (PGlite), wired with
 * the production pieces: licence reads, grant store, app reads with the
 * licensing ledger (so the app is verified, not merely unverified), chain rows,
 * provisionChain over the reactor env gateway, and SET_STAGE through the
 * licence gateway.
 */
const APP = "3c1e2b7a-5d4f-4e6a-8b9c-0d1e2f3a4b5c";
const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const DID2 = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const NOW = "2026-10-08T00:00:00.000Z";

type Client = Awaited<ReturnType<ReactorClientBuilder["build"]>>;

describe("AppLicenseHandler against a real reactor + real database", () => {
  let client: Client;
  let db: Kysely<VetraLicensingDB>;
  let handler: AppLicenseHandler;
  let envs: ReturnType<typeof createReactorEnvGateway>;
  let reads: ReturnType<typeof createReactorLicenseReads>;
  let issueDeps: Parameters<typeof issueLicense>[0];
  let migrated = true;
  const ended: string[] = [];
  let appReads: ReturnType<typeof createAppReads>;

  const countEnvDocuments = async (): Promise<number> => {
    let cursor = "0";
    let n = 0;
    for (let page = 0; page < 20; page++) {
      const res = await (
        client as unknown as {
          find(s: object, v?: unknown, p?: object): Promise<{ results: unknown[]; nextCursor?: string }>;
        }
      ).find({ type: ENV_DOC_TYPE }, undefined, { cursor, limit: 200 });
      n += res.results.length;
      if (!res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    return n;
  };
  const rows = () => db.selectFrom("license_environments").selectAll().orderBy("created_at").orderBy("root_license_id").execute();

  beforeAll(async () => {
    client = await new ReactorClientBuilder()
      .withReactorBuilder(new ReactorBuilder().withDocumentModelSources([...documentModels]))
      .build();
    db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
    await up(db as Kysely<any>);

    const ledger = createAppLedger({ db, source: reactorLedgerSource(client as never), now: () => NOW });
    const appDocs = createReactorAppDocStore(client as never, undefined, async () => ledger);
    await appDocs.create(APP);
    await appDocs.execute(APP, [
      appActions.setProductionEnvironment({ environmentId: "env-app" }),
      appActions.addTemplate({ id: "ded", name: null, mode: "DEDICATED" }),
      appActions.addTemplateService({ templateId: "ded", id: "c", type: "CONNECT", prefix: null }),
      appActions.addTemplate({ id: "max", name: null, mode: "DEDICATED" }),
      appActions.addTemplateService({ templateId: "max", id: "c", type: "CONNECT", prefix: null }),
      appActions.addTemplateService({ templateId: "max", id: "s", type: "SWITCHBOARD", prefix: null }),
      appActions.addTemplate({ id: "sh", name: null, mode: "SHARED" }),
      appActions.addTerm({ id: "k1", kind: "pro", label: "Pro", templateId: "ded", validityDays: null, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k1" }),
      appActions.addTerm({ id: "k2", kind: "max", label: "Max", templateId: "max", validityDays: null, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k2" }),
      appActions.addTerm({ id: "k3", kind: "free", label: "Free", templateId: "sh", validityDays: null, issuers: ["PUBLISHER_GRANT"] }),
      appActions.publishTerm({ id: "k3" }),
    ]);

    appReads = createAppReads(client as never, { ledger: ledger.lookup, heal: ledger.heal });
    expect(await appReads.app(APP)).toMatchObject({ tampered: false, unverified: false });

    reads = createReactorLicenseReads(client as never);
    const lifecycle = createLifecycleStore(db, () => NOW);
    const licenseGateway = createReactorLicenseGateway(client as never, { lifecycle });
    const grants = createGrantStore(db);
    envs = createReactorEnvGateway(client as never);
    issueDeps = {
      owners: { findAppById: async (id) => (id === APP ? { id, name: "KV", status: "ACTIVE", owner_address: "0xo" } : null) },
      apps: appReads,
      licence: (id) => reads.licenceRecord(id),
      createLicenseDocument: licenseGateway.create,
      executeLicence: licenseGateway.execute,
      grants,
      logger: console,
    };

    const cfg = { ...loadLicensingConfig({}), enabled: true, dryRun: false, scanIntervalMs: 1_000 };
    const chainRows = createChainEnvironmentRows(db, cfg);
    const chainEnvDeps: ChainEnvDeps = { rows: chainRows, envs, generateSubdomain };
    handler = new AppLicenseHandler({
      licences: () => reads.allLicenceRecords(),
      chainRoots: () => grants.chainRoots(),
      grants: () => grants.provenance(),
      lifecycle: () => lifecycle.all(),
      chainLabel: (root) => grants.chainLabel(root),
      app: (id) => appReads.app(id),
      environments: (appId) => chainRows.forApp(appId),
      environmentAppIds: () => chainRows.appIds(),
      provision: (input) => provisionChain(chainEnvDeps, input),
      setStage: (licenseId, stage) => licenseGateway.execute(licenseId, [licenseActions.setStage({ stage })]),
      onEnded: async (_appId, env) => { ended.push(env); },
      onResumed: async () => {},
      afterApp: async () => {},
      migrationComplete: async () => migrated,
      cfg,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => NOW,
    });
  }, 120_000);

  it("does nothing while the migration is incomplete", async () => {
    migrated = false;
    const before = await countEnvDocuments();
    await issueLicense(issueDeps, { appId: APP, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", label: "Vault A", now: NOW });
    await handler.reconcileOnce();
    expect(await rows()).toHaveLength(0);
    expect(await countEnvDocuments()).toBe(before);
    migrated = true;
  });

  it("DEDICATED: provisions one environment owned by the holder and binds the licence", async () => {
    await handler.reconcileOnce();
    const all = await rows();
    expect(all).toHaveLength(1);
    const licenseId = all[0]!.license_id;
    const state = await envs.getState(all[0]!.environment_id);
    expect(state).toMatchObject({ owner: ADDR, label: "Vault A" });
    expect(state!.services.filter((s) => s.enabled).map((s) => s.type)).toStrictEqual(["CONNECT"]);
    expect((await reads.licenceRecord(licenseId))!.stage).toBe(all[0]!.environment_id);
    expect(all[0]).toMatchObject({ app_id: APP, user_did: DID, root_license_id: licenseId, template_id: "ded" });
    const documents = await countEnvDocuments();
    await handler.reconcileOnce();
    expect(await rows()).toHaveLength(1);
    expect(await countEnvDocuments()).toBe(documents);
  });

  it("a second purchase creates a second environment; an upgrade re-templates in place", async () => {
    const second = await issueLicense(issueDeps, { appId: APP, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", label: "Vault B", now: NOW });
    await handler.reconcileOnce();
    expect(await rows()).toHaveLength(2);
    const upgraded = await issueLicense(issueDeps, { appId: APP, user: DID, kind: "max", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", upgrades: second.licenseId, now: NOW });
    const documents = await countEnvDocuments();
    await handler.reconcileOnce();
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(await countEnvDocuments()).toBe(documents);
    const row = all.find((r) => r.root_license_id === second.licenseId)!;
    expect(row).toMatchObject({ license_id: upgraded.licenseId, template_id: "max", label: "Vault B" });
    const state = await envs.getState(row.environment_id);
    expect(state!.services.filter((s) => s.enabled).map((s) => s.type).sort()).toStrictEqual(["CONNECT", "SWITCHBOARD"]);
    expect((await reads.licenceRecord(second.licenseId))!.status).toBe("REPLACED");
    expect((await reads.licenceRecord(upgraded.licenseId))!.stage).toBe(row.environment_id);
  });

  it("SHARED: never provisions, binds the stage to the App Environment", async () => {
    const before = await countEnvDocuments();
    const { licenseId } = await issueLicense(issueDeps, { appId: APP, user: DID2, kind: "free", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "0xo", now: NOW });
    await handler.reconcileOnce();
    expect(await countEnvDocuments()).toBe(before);
    expect((await reads.licenceRecord(licenseId))!.stage).toBe("env-app");
  });
  it("a forged REVOKE on a licence document holds its chain instead of ending it", async () => {
    const all = await rows();
    const row = all.find((r) => r.label === "Vault A")!;
    expect(await db.selectFrom("license_lifecycle").select("status").where("license_id", "=", row.license_id).executeTakeFirst())
      .toStrictEqual({ status: "ACTIVE" });
    // Bypasses the gateway, as a direct document write would.
    await client.execute(row.license_id, "main", [licenseActions.revokeLicense({ reason: "forged" })]);
    expect((await reads.licenceRecord(row.license_id))!.status).toBe("REVOKED");
    await handler.reconcileOnce();
    expect(ended).toStrictEqual([]);
  });

  it("a system REVOKE through the gateway ends the chain", async () => {
    const gateway = createReactorLicenseGateway(client as never, { lifecycle: createLifecycleStore(db, () => NOW) });
    const row = (await rows()).find((r) => r.label === "Vault B")!;
    await gateway.execute(row.license_id, [licenseActions.revokeLicense({ reason: "refund" })]);
    await handler.reconcileOnce();
    expect(ended).toStrictEqual([row.environment_id]);
  });

  it("a write to the app outside Vetra holds the app: nothing is re-templated", async () => {
    const before = await rows();
    // Bypasses the ledger, as a direct document write would.
    await client.execute(APP, "main", [appActions.setTermDetails({ id: "k1", templateId: "max" })]);
    const app = await appReads.app(APP);
    expect(app).toMatchObject({ tampered: true });
    expect(app!.terms.find((t) => t.id === "k1")!.templateId).toBe("max");
    await handler.reconcileOnce();
    const after = await rows();
    expect(after).toStrictEqual(before);
    for (const row of after) {
      const state = await envs.getState(row.environment_id);
      const enabled = state!.services.filter((s) => s.enabled).map((s) => s.type).sort();
      expect(enabled).toStrictEqual(row.template_id === "max" ? ["CONNECT", "SWITCHBOARD"] : ["CONNECT"]);
    }
  });
}, 300_000);
