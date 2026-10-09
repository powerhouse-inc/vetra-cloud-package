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
import { createOwnerAppLookup } from "./owner-apps.js";
import { studioPublisherAddress } from "./studio-app.js";
import { createAppLicensingWriter } from "./licensing-ledger.js";
import { createReactorAppDocStore } from "../vetra-apps/app-doc-store.js";
import { createAppReads } from "./app-reads.js";

import { type LegacyAccessDB } from "./migration/legacy.js";
import { startLicensingMigration } from "./migration/run.js";
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
  lockChain,
  provisionChainExclusive,
  type ChainEnvDeps,
  type ProvisionChainInput,
} from "./environments.js";
import {
  confirmedEndedRows,
  markEnded,
  markResumed,
  tickOffboarding,
  type OffboardingDeps,
} from "./offboarding.js";
import { createGrantStore } from "./grants.js";
import type { AcquireOptions } from "./keyed-mutex.js";
import { actions as licenseActions } from "document-models/app-owner-license";
import { createPublisherResolvers } from "./publisher-resolvers.js";
import { createRenownProfileRelay } from "./renown-profile.js";
import { mergeResolvers } from "./merge-resolvers.js";
import { APP_DOC_TYPE } from "./app-reads.js";
import { createReactorDocGateway } from "./doc-gateway.js";
import { createKeyVault } from "./key-vault.js";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import { createSecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { SecretsDB } from "../vetra-cloud-secrets/db/schema.js";
import { createHolderLicences } from "./licence-view.js";
import { appsTrustedIds, buildStudioAccessDeps, createLicensingAppReads } from "./studio-access-factory.js";
import { createSubscriptionResolvers } from "./subscriptions-resolvers.js";
import { getTenantId } from "../../processors/vetra-cloud-environment/gitops.js";
import { loadAppsConfig } from "../vetra-apps/config.js";
import { createRenownStatsClient, type RenownStatsClient } from "./renown-stats.js";
import {
  createReportingTokenIssuer,
  deleteReportingToken,
  newReportingToken,
  relayUserStat,
  type RelayDeps,
  type ReportingDeps,
} from "./reporting.js";

/** As vetra-access-codes: the same role and key prefix, so stored keys still decrypt. */
const DEFAULT_TRANSIT_ROLE = "vetra-secrets";

/**
 * The OpenBao transit client, built exactly as vetra-access-codes built it
 * (OPENBAO_TRANSIT_ROLE, OPENBAO_TRANSIT_KEY_PREFIX): it encrypts and
 * decrypts the Claude keys attached to invite codes and writes tenant
 * secrets. Null (keys refused, the subgraph still loads) when OPENBAO_ADDR is
 * unset.
 */
function openBaoTransit(): OpenBaoTransitClient | null {
  const addr = process.env.OPENBAO_ADDR;
  if (!addr) {
    console.warn("[licensing] OPENBAO_ADDR unset — invite-code Claude keys disabled");
    return null;
  }
  return new OpenBaoTransitClient({
    addr,
    role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_TRANSIT_ROLE,
    keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
  });
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
  private stats: RenownStatsClient | null = null;
  private migration: { stop(): void } | null = null;

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
    const { appLedger, appReads } = createLicensingAppReads({
      client: this.reactorClient as never,
      db,
      trustedIds: appsTrustedIds(appsDb),
    });
    const ownerLookup = createOwnerAppLookup({
      table: {
        byId: (id) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "name", "status", "owner_address", "identity_did"])
            .where("id", "=", id)
            .executeTakeFirst()
            .then((r) => r ?? null),
        byOwner: (address) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "name", "status", "owner_address", "identity_did"])
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
    const transit = openBaoTransit();
    const keyVault = createKeyVault(transit);
    const migrationComplete = async () =>
      (await db
        .selectFrom("licensing_migration_steps")
        .select("step")
        .where("step", "=", "complete")
        .executeTakeFirst()) !== undefined;
    const issueDeps = {
      owners: ownerLookup,
      apps: appReads,
      licence: (id: string) => reads.licenceRecord(id),
      createLicenseDocument: () => gateway.create(),
      executeLicence: (id: string, acts: Parameters<typeof gateway.execute>[1]) => gateway.execute(id, acts),
      grants,
      lifecycle,
      migrationComplete,
      logger: console,
    };
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
      issue: issueDeps,
      grants,
      envRows: chainRows,
      codes: db,
      keyVault,
      cfg,
      newId: () => randomUUID(),
      now: () => new Date().toISOString(),
      // App profiles on Renown, relayed with the registration token. Off
      // while RENOWN_STATS_URL or RENOWN_WORKLOAD_REGISTRATION_TOKEN is unset.
      renownProfile: createRenownProfileRelay({
        statsUrl: cfg.renownStatsUrl,
        registrationToken: loadAppsConfig(process.env).renown?.registrationToken ?? null,
      }),
    }) as Record<string, Record<string, unknown>>;

    // Owner surface. Everything a holder owns is read from grant rows and the
    // lifecycle record (licence-view.ts), never from licence documents.
    const holderLicences = createHolderLicences({ licences: reads, lifecycle, grants });
    const studio = buildStudioAccessDeps({
      appReads,
      holderLicences,
      db,
      keyVault,
    });
    // Tenant secrets are written through the vetra-cloud-secrets service
    // in-process (its subgraph owns the schema), as vetra-access-codes did.
    const secretsService = transit
      ? createSecretsService({
          db: (await this.relationalDb.createNamespace(
            "vetra-cloud-secrets",
          )) as unknown as Kysely<SecretsDB>,
          transit,
        })
      : null;
    // The environment processor's projection: which environment owns a tenant.
    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<{ environments: { tenantId: string | null; owner: string | null } }>;
    const subscriptionResolvers = createSubscriptionResolvers({
      issuer: {
        ...issueDeps,
        db,
        activeLicencesOf: async (appId, userDid) =>
          (await holderLicences(appId, userDid)).filter((l) => l.status === "ACTIVE"),
      },
      apps: appReads,
      licences: reads,
      lifecycle,
      grants,
      envRows: chainRows,
      envState: (id) => envs.getState(id),
      licenseGateway: gateway,
      studio,
      secrets: secretsService,
      // A missing table (42P01) propagates: applyStudioKey fails closed.
      tenantOwners: async (tenantId) =>
        (
          await envDb
            .selectFrom("environments")
            .select("owner")
            .where("tenantId", "=", tenantId)
            .execute()
        ).map((r) => r.owner?.toLowerCase() ?? null),
      tenantWait: { timeoutMs: 10_000, intervalMs: 500 },
      now: () => new Date().toISOString(),
    }) as Record<string, Record<string, unknown>>;

    // Provisioning, shared by the handler and the machine API: one DEDICATED
    // environment per licence chain, under the chain's lock.
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
      forgetEnvironment: async (id) => {
        await deleteReportingToken(db, id);
        tokenIssuer.forget(id);
      },
      cfg,
      logger: console,
      now: () => new Date().toISOString(),
    };
    // The handler waits for a chain as long as it takes (its own step timeout
    // reports a hang); the machine API passes a bounded wait (BUSY).
    const provision = (input: ProvisionChainInput, opts?: AcquireOptions) =>
      provisionChainExclusive(chainEnvDeps, input, opts);
    /** Offboarding writes of one environment, under its chain's lock. */
    const underChainOf = async (environmentId: string, fn: () => Promise<void>) => {
      const row = await chainRows.byEnvironment(environmentId);
      await (row ? lockChain(row.root_license_id, fn) : fn());
    };

    // Reporting tokens (one per DEDICATED environment, in its secrets) and
    // the Renown stats relay. Off while RENOWN_STATS_URL is unset.
    const renownCfg = loadAppsConfig(process.env).renown;
    const stats = createRenownStatsClient({
      statsUrl: cfg.renownStatsUrl,
      workloadUrl: renownCfg ? `${renownCfg.switchboardUrl}/graphql/renown-workload` : null,
      registrationToken: renownCfg?.registrationToken ?? null,
    });
    this.stats = stats;
    const reporting: ReportingDeps = {
      db,
      secrets: secretsService,
      tenantIdOf: async (id) => {
        const state = await envs.getState(id);
        return state?.genericSubdomain ? getTenantId(state.genericSubdomain, id) : null;
      },
      envStatus: async (id) => (await envs.getState(id))?.status ?? null,
      licensingUrl: cfg.licensingPublicUrl,
      newToken: newReportingToken,
      now: () => new Date().toISOString(),
      logger: console,
    };
    // One budget per handler tick across all apps: writing a token restarts
    // a running environment once (asleep ones are free).
    const tokenIssuer = createReportingTokenIssuer(reporting, cfg.tokensPerTick);
    const relayDeps: RelayDeps = {
      db,
      envRows: chainRows,
      grants,
      lifecycle,
      apps: appReads,
      // The app DID comes from the apps row, never the app document.
      appIdentity: async (appId) => {
        const row = await appsDb
          .selectFrom("apps")
          .select(["identity_did", "status"])
          .where("id", "=", appId)
          .executeTakeFirst();
        return row ? { identityDid: row.identity_did, status: row.status } : null;
      },
      stats,
      logger: console,
      now: () => new Date().toISOString(),
    };

    // Machine surface (app backends, by App identity). Licences come from
    // grant rows and the lifecycle record, environments from
    // license_environments; nothing here touches app_user_environments.
    const machineDeps: ResolverDeps = {
      auth: {
        findAppByIdentityDid: (did) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "status"])
            .where("identity_did", "=", did)
            .executeTakeFirst()
            .then((r) => r ?? null),
      },
      apps: appReads,
      licences: reads,
      lifecycle,
      grants,
      envRows: chainRows,
      provision,
      offboarding,
      issue: issueDeps,
      migrationComplete,
      cfg,
      now: () => new Date().toISOString(),
      relay: (token, input) => relayUserStat(relayDeps, token, input),
    };
    const machineResolvers = createResolvers(machineDeps) as Record<string, Record<string, unknown>>;

    this.resolvers = mergeResolvers(
      mergeResolvers(machineResolvers, publisherResolvers),
      subscriptionResolvers,
    );

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

    // The startup migration (LICENSING_MIGRATION: dry-run by default, apply,
    // off): legacy licence types, licences, environments and access codes
    // onto terms, chains and the vetra-studio app. Not awaited, retried every
    // 10 minutes until complete; the handler below idles until then. Nothing
    // here can fail setup.
    try {
      // The legacy namespace still exists (Task 17 deletes code, never tables);
      // createNamespace on an existing one is a lookup.
      const accessDb = (await this.relationalDb
        .createNamespace("vetra-access-codes")
        .catch(() => null)) as unknown as Kysely<LegacyAccessDB> | null;
      // Ledger-checked reads that never heal: a dry-run must not write.
      const migrationAppReads = createAppReads(this.reactorClient as never, {
        ledger: appLedger.lookup,
        trustedIds: appsTrustedIds(appsDb),
      });
      const appDocs = createReactorAppDocStore(this.reactorClient as never, undefined, () =>
        Promise.resolve(appLedger),
      );
      this.migration = startLicensingMigration({
        db,
        accessDb,
        appRows: () => appsDb.selectFrom("apps").select(["id", "status"]).execute(),
        licences: () => reads.allLicenceRecords(),
        apps: migrationAppReads,
        appWriter,
        ledger: appLedger,
        createAppDocument: (id) => appDocs.create(id),
        protectAppDocument: perm
          ? createAppDocProtector(
              perm,
              createAppDocOwnerResolver(rowOwner, studioPublisher),
              this.reactorClient as never,
              console,
            )
          : null,
        protectLicenceDocument: perm
          ? createAppDocProtector(perm, platformOwner, this.reactorClient as never, console, "licence document")
          : null,
        licenseGateway: gateway,
        envState: (id) => envs.getState(id),
        deleteDocument: async (id) => {
          await this.reactorClient.deleteDocument(id);
        },
        grants,
        cfg,
        now: () => new Date().toISOString(),
        logger: console,
      });
    } catch (err) {
      console.warn(`[licensing] migration not started: ${String(err)}`);
    }

    // Provisioning: one DEDICATED environment per licence chain. Inert unless
    // cfg.enabled (default false); dry-run (default true) only logs. It does
    // nothing at all until the startup migration has recorded `complete`.
    // App documents are read through the same ledger-checked appReads as the
    // publisher surface, so a tampered or unverified app is held. The old
    // ProvisioningKeeper (app_user_environments) no longer runs; its tables
    // stay in place, read-only.
    this.handler = new AppLicenseHandler({
      licences: () => reads.allLicenceRecords(),
      chainRoots: () => grants.chainRoots(),
      grants: () => grants.provenance(),
      lifecycle: () => lifecycle.all(),
      chainLabel: (root) => grants.chainLabel(root),
      app: (id) => appReads.app(id),
      environments: (appId) => chainRows.forApp(appId),
      environmentAppIds: () => chainRows.appIds(),
      provision: (input) => provision(input),
      setStage: (licenseId, stage) =>
        gateway.execute(licenseId, [licenseActions.setStage({ stage })]),
      onEnded: (_appId, env) => underChainOf(env, () => markEnded(offboarding, env)),
      onResumed: (_appId, env) => underChainOf(env, () => markResumed(offboarding, env)),
      afterApp: async (_appId, rows, confirmedEndedRoots) => {
        await tickOffboarding(offboarding, confirmedEndedRows(rows, confirmedEndedRoots));
        // Live environments only; failures are caught per environment.
        await tokenIssuer.issue(rows.filter((r) => r.ended_at === null).map((r) => r.environment_id));
      },
      beforeTick: () => tokenIssuer.startTick(),
      afterTick: () => tokenIssuer.endTick(),
      migrationComplete,
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
      listLicenses: () => reads.listLicenses(),
      activate: (id) => gateway.activate(id),
      expire: (id) => gateway.expire(id),
      now: () => new Date().toISOString(),
      cfg,
      logger: console,
    });
    this.keeper.start();
  }

  async onDisconnect(): Promise<void> {
    this.migration?.stop();
    this.migration = null;
    this.keeper?.stop();
    this.keeper = null;
    this.handler?.stop();
    this.handler = null;
    if (this.stats) {
      const stats = this.stats;
      this.stats = null;
      stats.stop();
      // Bounded: whatever Renown does not take within 2 s is dropped (current
      // values; the next report carries the latest).
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        stats.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    }
    await super.onDisconnect();
  }
}
