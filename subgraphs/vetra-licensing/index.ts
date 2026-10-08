import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { up } from "./db/migrations.js";
import type { VetraLicensingDB } from "./db/schema.js";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import { createReactorEnvGateway } from "../vetra-apps/envs.js";
import { generateSubdomain } from "../../shared/subdomain-generator.js";
import { sleepEnvironment } from "document-models/vetra-cloud-environment";
import { createResolvers, type ResolverDeps } from "./resolvers.js";
import { loadLicensingConfig } from "./config.js";
import { createReactorLicenseReads } from "./reads.js";
import { createAppReads } from "./app-reads.js";
import { createOwnerAppLookup } from "./owner-apps.js";
import { STUDIO_APP_ID, studioPublisherAddress } from "./studio-app.js";
import { createAppLedger, reactorLedgerSource } from "./licensing-ledger.js";
import {
  createAppDocOwnerResolver,
  sweepAppDocumentProtection,
  createAppDocProtector,
} from "../vetra-apps/app-doc-protection.js";
import {
  createReactorLicenseGateway,
  listLicenceDocumentIds,
} from "./license-gateway.js";
import { createLifecycleStore } from "./lifecycle.js";
import { LicenseKeeper } from "./keeper.js";
import { AppLicenseHandler } from "./handler.js";
import {
  createChainEnvironmentRows,
  provisionChain,
  type ChainEnvDeps,
} from "./environments.js";
import { createGrantStore } from "./grants.js";
import { actions as licenseActions } from "document-models/app-owner-license";
import { createPublisherResolvers } from "./publisher-resolvers.js";
import { createReactorLicenseTypeGateway } from "./license-type-gateway.js";
import { mergeResolvers } from "./merge-resolvers.js";

/**
 * Licence lifecycle and environment provisioning. Owns its own relational
 * tables in an isolated namespace. The licences themselves are documents;
 * these tables are the upsert key and the per-app ceiling.
 */
export class VetraLicensingSubgraph extends BaseSubgraph {
  name = "vetra-licensing";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};
  private keeper: LicenseKeeper | null = null;
  private handler: AppLicenseHandler | null = null;

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;

    await up(db as Kysely<any>);

    // Read-only view of the vetra-apps namespace, for App identity lookup.
    const appsDb = (await this.relationalDb.createNamespace(
      "vetra-apps",
    )) as unknown as Kysely<VetraAppsDB>;

    const envs = createReactorEnvGateway(this.reactorClient as never);

    const cfg = loadLicensingConfig();
    const reads = createReactorLicenseReads(this.reactorClient as never);
    // Licence documents are system-write-only, like vetra-app documents: the
    // platform publisher is their only principal. Every system lifecycle write
    // is also recorded in license_lifecycle, which the handler trusts over the
    // document.
    const studioPublisher = studioPublisherAddress();
    const perm = this.documentPermissionService;
    const platformOwner = () => Promise.resolve(studioPublisher);
    const lifecycle = createLifecycleStore(db, () => new Date().toISOString());
    const gateway = createReactorLicenseGateway(this.reactorClient as never, {
      protect: perm
        ? createAppDocProtector(
            perm,
            platformOwner,
            this.reactorClient as never,
            console,
            "licence document",
          )
        : undefined,
      lifecycle,
      logger: console,
    });

    const deps: ResolverDeps = {
      auth: {
        findAppByIdentityDid: (did) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "status"])
            .where("identity_did", "=", did)
            .executeTakeFirst()
            .then((r) => r ?? null),
      },
      provision: { envs, generateSubdomain },
      release: {
        findRowByEnvironment: (environmentId) =>
          db
            .selectFrom("app_user_environments")
            .selectAll()
            .where("environment_id", "=", environmentId)
            .executeTakeFirst()
            .then((r) => r ?? null),
        environmentStatus: async (environmentId) =>
          (await envs.getState(environmentId))?.status ?? null,
        // Sleep only. Nothing here can delete the environment document.
        stopEnvironment: async (environmentId) => {
          await envs.execute(environmentId, [sleepEnvironment({})]);
        },
        // Reached only for a DRAFT document; see releaseEnvironment.
        deleteEnvironment: (environmentId) => envs.delete(environmentId),
        logger: console,
        deleteRow: async (appId, user) => {
          await db
            .deleteFrom("app_user_environments")
            .where("app_id", "=", appId)
            .where("user_address", "=", user.toLowerCase())
            .execute();
        },
      },
      grant: {
        // No allow-list store exists in this slice. The grant is authorised by
        // the caller's own App identity and by the licence type having to
        // belong to that same app (checked in issuePublisherGrant), so any
        // holder address is accepted. Replace this when a list is introduced.
        isOnAllowList: async () => true,
        recordGrant: async (row) => {
          await db
            .insertInto("app_license_grants")
            .values({
              license_id: row.licenseId,
              app_id: row.appId,
              license_type_id: row.licenseTypeId,
              user_address: row.user.toLowerCase(),
              issued_by: row.issuedBy.toLowerCase(),
              created_at: row.now,
            })
            .onConflict((oc) => oc.column("license_id").doNothing())
            .execute();
        },
        getLicenseType: reads.licenseType,
        createLicenseDocument: gateway.create,
        execute: gateway.execute,
      },
      cfg,
      read: {
        licenses: reads.licenses,
        licenseTypes: reads.licenseTypes,
        templateFor: reads.templateFor,
      },
    };

    const machineResolvers = createResolvers(db, deps) as Record<
      string,
      Record<string, unknown>
    >;

    const typeGateway = createReactorLicenseTypeGateway(
      this.reactorClient as never,
    );
    // Human surface. Ownership is checked on every call: the apps table row
    // wins where one exists; an app that exists only as a document (the
    // vetra-studio app) falls back to the document's owner. Platform admins
    // (the ADMINS env) pass via resolveOwnerApp.
    const rowOwner = (id: string) =>
      appsDb
        .selectFrom("apps")
        .select("owner_address")
        .where("id", "=", id)
        .executeTakeFirst()
        .then((r) => r?.owner_address ?? null);
    const appLedger = createAppLedger({
      db,
      source: reactorLedgerSource(this.reactorClient as never),
      now: () => new Date().toISOString(),
    });
    const appReads = createAppReads(this.reactorClient as never, {
      // Licensing state that differs from what the system last wrote: held,
      // unless the difference is journalled system writes (healed).
      ledger: appLedger.lookup,
      heal: appLedger.heal,
      // Only an app with a row, or the studio app, is trusted by slug.
      trustedIds: async () =>
        new Set([
          ...(await appsDb.selectFrom("apps").select("id").execute()).map(
            (r) => r.id,
          ),
          STUDIO_APP_ID,
        ]),
    });
    const publisherResolvers = createPublisherResolvers(db, {
      auth: createOwnerAppLookup({
        table: {
          byId: (id) =>
            appsDb
              .selectFrom("apps")
              .select(["id", "name", "status", "owner_address"])
              .where("id", "=", id)
              .executeTakeFirst()
              .then((r) => r ?? null),
          byOwner: (address) =>
            appsDb
              .selectFrom("apps")
              .select(["id", "name", "status", "owner_address"])
              .where("owner_address", "=", address)
              .execute(),
        },
        apps: appReads,
        studioPublisher,
      }),
      reads,
      cfg,
      typeGateway,
      licenseGateway: gateway,
      grant: deps.grant,
    }) as Record<string, Record<string, unknown>>;

    this.resolvers = mergeResolvers(machineResolvers, publisherResolvers);

    // vetra-app and licence documents are system-write-only. Protect every
    // existing one; best-effort and in the background, so it never blocks or
    // fails setup.
    if (perm) {
      void sweepAppDocumentProtection({
        perm,
        relationships: this.reactorClient as never,
        listAppDocumentIds: () => appReads.allIds(),
        ownerFor: createAppDocOwnerResolver(rowOwner, studioPublisher),
        logger: console,
      });
      void sweepAppDocumentProtection({
        perm,
        relationships: this.reactorClient as never,
        listAppDocumentIds: () => listLicenceDocumentIds(this.reactorClient as never),
        ownerFor: platformOwner,
        logger: console,
        noun: "licence document",
      });
    }

    // Provisioning: one DEDICATED environment per licence chain. Inert unless
    // cfg.enabled (default false); dry-run (default true) only logs. It does
    // nothing at all until the startup migration has recorded `complete`.
    // App documents are read through the same ledger-checked appReads as the
    // publisher surface, so a tampered or unverified app is held. The old
    // ProvisioningKeeper (app_user_environments) no longer runs; its tables
    // stay in place, read-only.
    const grants = createGrantStore(db);
    const chainRows = createChainEnvironmentRows(db, cfg);
    const chainEnvDeps: ChainEnvDeps = { rows: chainRows, envs, generateSubdomain };
    this.handler = new AppLicenseHandler({
      licences: () => reads.allLicenceRecords(),
      chainRoots: () => grants.chainRoots(),
      grants: () => grants.provenance(),
      lifecycle: () => lifecycle.all(),
      chainLabel: (root) => grants.chainLabel(root),
      app: (id) => appReads.app(id),
      environments: (appId) => chainRows.forApp(appId),
      environmentAppIds: () => chainRows.appIds(),
      provision: (input) => provisionChain(chainEnvDeps, input),
      setStage: (licenseId, stage) =>
        gateway.execute(licenseId, [licenseActions.setStage({ stage })]),
      // Task 10 wires the offboarding clock here. Until then: report only.
      onEnded: async (appId, env) => {
        console.info(`[licensing] chain of environment ${env} (app ${appId}) ended`);
      },
      onResumed: async (appId, env) => {
        console.info(`[licensing] chain of environment ${env} (app ${appId}) resumed`);
      },
      afterApp: async () => {},
      migrationComplete: async () =>
        (await db
          .selectFrom("licensing_migration_steps")
          .select("step")
          .where("step", "=", "complete")
          .executeTakeFirst()) !== undefined,
      cfg,
      logger: console,
      now: () => new Date().toISOString(),
    });
    this.handler.start();

    // cfg.enabled gates the whole write path: the keeper below, and every
    // mutation in createResolvers (they refuse with LicensingDisabledError).
    // Queries stay available either way. cfg.dryRun only affects the keeper.
    // Off by default; dry-run by default. The variable keeps its original name,
    // LICENSING_KEEPER_ENABLED.
    this.keeper = new LicenseKeeper({
      listLicenses: reads.listLicenses,
      activate: gateway.activate,
      expire: gateway.expire,
      now: () => new Date().toISOString(),
      cfg,
      logger: console,
    });
    this.keeper.start();
  }

  async onDisconnect(): Promise<void> {
    this.keeper?.stop();
    this.keeper = null;
    this.handler?.stop();
    this.handler = null;
    await super.onDisconnect();
  }
}
