import { randomUUID } from "node:crypto";
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { up } from "./db/migrations.js";
import type { VetraLicensingDB } from "./db/schema.js";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import { createReactorEnvGateway } from "../vetra-apps/envs.js";
import { generateSubdomain } from "../../shared/subdomain-generator.js";
import { sleepEnvironment, wakeEnvironment } from "document-models/vetra-cloud-environment";
import { createResolvers, type ResolverDeps } from "./resolvers.js";
import { loadLicensingConfig } from "./config.js";
import { createReactorLicenseReads } from "./reads.js";
import { createAppReads } from "./app-reads.js";
import { createOwnerAppLookup } from "./owner-apps.js";
import { STUDIO_APP_ID, studioPublisherAddress } from "./studio-app.js";
import {
  createAppLedger,
  createAppLicensingWriter,
  reactorLedgerSource,
} from "./licensing-ledger.js";
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
import {
  confirmedEndedRows,
  markEnded,
  markResumed,
  tickOffboarding,
  type OffboardingDeps,
} from "./offboarding.js";
import { createGrantStore } from "./grants.js";
import { actions as licenseActions } from "document-models/app-owner-license";
import { createPublisherResolvers } from "./publisher-resolvers.js";
import { mergeResolvers } from "./merge-resolvers.js";
import { APP_DOC_TYPE } from "./app-reads.js";
import { createReactorDocGateway } from "./doc-gateway.js";
import { createKeyVault } from "./key-vault.js";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";

/** As vetra-access-codes: the same role and key prefix, so stored keys still decrypt. */
const DEFAULT_TRANSIT_ROLE = "vetra-secrets";

/**
 * Encrypts the Claude keys attached to invite codes. Null (keys refused, the
 * subgraph still loads) when OPENBAO_ADDR is unset.
 */
function inviteKeyVault() {
  const addr = process.env.OPENBAO_ADDR;
  if (!addr) {
    console.warn("[licensing] OPENBAO_ADDR unset — invite-code Claude keys disabled");
    return null;
  }
  return createKeyVault(
    new OpenBaoTransitClient({
      addr,
      role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_TRANSIT_ROLE,
      keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
    }),
  );
}

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

    // Human surface. Ownership is checked on every call against the apps
    // table row (the studio app: the configured studio publisher), never the
    // document. Platform admins (the ADMINS env) pass via resolveOwnerApp.
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
    const ownerLookup = createOwnerAppLookup({
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
    });
    // Template and term writes go through the ledger writer only, so the
    // app's recorded licensing-state hash stays valid.
    const appWriter = createAppLicensingWriter({
      docs: createReactorDocGateway(this.reactorClient as never, APP_DOC_TYPE, "app", () =>
        Promise.reject(new Error("the publisher surface never creates app documents")),
      ),
      ledger: appLedger,
    });
    const grants = createGrantStore(db);
    const chainRows = createChainEnvironmentRows(db, cfg);
    const publisherResolvers = createPublisherResolvers({
      // Ownership of environments comes from the apps tables, never documents.
      appEnvironments: async (appId) => {
        const [row, previews] = await Promise.all([
          appsDb
            .selectFrom("apps")
            .select("production_environment_id")
            .where("id", "=", appId)
            .executeTakeFirst(),
          appsDb
            .selectFrom("app_previews")
            .select("environment_id")
            .where("app_id", "=", appId)
            .execute(),
        ]);
        return [
          ...(row ? [row.production_environment_id] : []),
          ...previews.map((p) => p.environment_id),
        ];
      },
      auth: ownerLookup,
      apps: appReads,
      appWriter,
      licences: reads,
      lifecycle,
      licenseGateway: gateway,
      issue: {
        owners: ownerLookup,
        apps: appReads,
        licence: (id) => reads.licenceRecord(id),
        createLicenseDocument: () => gateway.create(),
        executeLicence: (id, acts) => gateway.execute(id, acts),
        grants,
        lifecycle,
        logger: console,
      },
      grants,
      envRows: chainRows,
      codes: db,
      keyVault: inviteKeyVault(),
      cfg,
      newId: () => randomUUID(),
      now: () => new Date().toISOString(),
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
    const chainEnvDeps: ChainEnvDeps = { rows: chainRows, envs, generateSubdomain };
    const offboarding: OffboardingDeps = {
      rows: chainRows,
      envStatus: async (id) => (await envs.getState(id))?.status ?? null,
      sleep: async (id) => {
        await envs.execute(id, [sleepEnvironment({})]);
      },
      wake: async (id) => {
        await envs.execute(id, [wakeEnvironment({})]);
      },
      destroy: (id) => envs.delete(id),
      cfg,
      logger: console,
      now: () => new Date().toISOString(),
    };
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
      onEnded: (_appId, env) => markEnded(offboarding, env),
      onResumed: (_appId, env) => markResumed(offboarding, env),
      afterApp: (_appId, rows, confirmedEndedRoots) =>
        tickOffboarding(offboarding, confirmedEndedRows(rows, confirmedEndedRoots)),
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
