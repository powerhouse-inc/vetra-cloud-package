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
import {
  createAppDocOwnerResolver,
  sweepAppDocumentProtection,
} from "../vetra-apps/app-doc-protection.js";
import { createReactorLicenseGateway } from "./license-gateway.js";
import { LicenseKeeper } from "./keeper.js";
import { ProvisioningKeeper } from "./provisioning-keeper.js";
import { createPublisherResolvers } from "./publisher-resolvers.js";
import { createReactorLicenseTypeGateway } from "./license-type-gateway.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "./provision.js";
import { mergeResolvers } from "./merge-resolvers.js";
import { releaseEnvironment } from "./release.js";
import { createEnvironmentRows } from "./rows.js";
import {
  createTypeSnapshots,
  resolveTemplateForLicence,
} from "./resolve-template.js";

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
  private provisioningKeeper: ProvisioningKeeper | null = null;

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
    const gateway = createReactorLicenseGateway(this.reactorClient as never);

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
    const studioPublisher = studioPublisherAddress();
    const rowOwner = (id: string) =>
      appsDb
        .selectFrom("apps")
        .select("owner_address")
        .where("id", "=", id)
        .executeTakeFirst()
        .then((r) => r?.owner_address ?? null);
    const appReads = createAppReads(this.reactorClient as never, {
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

    // vetra-app documents are system-write-only. Protect every existing one;
    // best-effort and in the background, so it never blocks or fails setup.
    const perm = this.documentPermissionService;
    if (perm) {
      void sweepAppDocumentProtection({
        perm,
        listAppDocumentIds: () => appReads.allIds(),
        ownerFor: createAppDocOwnerResolver(rowOwner, studioPublisher),
        logger: console,
      });
    }

    // The same row operations the resolvers use, so the per-app environment
    // cap is one implementation on both paths.
    const provisionDeps: ProvisionDeps = {
      ...deps.provision,
      ...createEnvironmentRows(db, cfg),
    };

    // Inert unless cfg.enabled (default false); dry-run (default true) is
    // honoured inside the keeper. Same cfg object as everything above.
    const typeSnapshots = createTypeSnapshots(reads);
    this.provisioningKeeper = new ProvisioningKeeper({
      allLicenses: reads.allLicenses,
      authorizedLicenseIds: async (appId: string) => {
        const rows = await db
          .selectFrom("app_license_grants")
          .select("license_id")
          .where("app_id", "=", appId)
          .execute();
        return new Set(rows.map((r) => r.license_id));
      },
      licenseTypes: typeSnapshots.licenseTypes,
      environments: async (appId) =>
        (
          await db
            .selectFrom("app_user_environments")
            .selectAll()
            .where("app_id", "=", appId)
            .execute()
        ).map((r) => ({
          user: r.user_address,
          environmentId: r.environment_id,
          licenseId: r.license_id,
          templateHash: r.template_hash,
        })),
      applyFor: async (appId, licence) => {
        // The snapshot the keeper just planned from, not a fresh scan.
        const resolved = resolveTemplateForLicence(
          await typeSnapshots.detailsFor(appId),
          licence,
        );
        if (!resolved.ok) {
          console.warn(
            `[licensing] licence ${licence.licenseId} (app ${appId}): ${resolved.reason}; skipping`,
          );
          return;
        }
        await applyEnvironmentTemplate(provisionDeps, {
          appId,
          user: licence.user,
          licenseId: licence.licenseId,
          template: resolved.template,
          label: resolved.label,
          now: new Date().toISOString(),
        });
      },
      releaseFor: async (appId, environmentId) => {
        await releaseEnvironment(deps.release, appId, environmentId);
      },
      cfg,
      logger: console,
    });
    this.provisioningKeeper.start();

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
    this.provisioningKeeper?.stop();
    this.provisioningKeeper = null;
    await super.onDisconnect();
  }
}
