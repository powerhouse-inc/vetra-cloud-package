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
import { createReactorLicenseGateway } from "./license-gateway.js";
import { LicenseKeeper } from "./keeper.js";
import { ProvisioningKeeper } from "./provisioning-keeper.js";
import { createPublisherResolvers } from "./publisher-resolvers.js";
import { createReactorLicenseTypeGateway } from "./license-type-gateway.js";
import { applyEnvironmentTemplate, type ProvisionDeps } from "./provision.js";
import { mergeResolvers } from "./merge-resolvers.js";
import { releaseEnvironment } from "./release.js";
import type { AppUserEnvironments } from "./db/schema.js";

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
    // Human surface. Ownership is checked against apps.owner_address on every
    // call; platform admins (the ADMINS env) pass via resolveOwnerApp.
    const publisherResolvers = createPublisherResolvers(db, {
      auth: {
        findAppById: (id) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "name", "status", "owner_address"])
            .where("id", "=", id)
            .executeTakeFirst()
            .then((r) => r ?? null),
        listAppsForOwner: (address) =>
          appsDb
            .selectFrom("apps")
            .select(["id", "name", "status", "owner_address"])
            .where("owner_address", "=", address)
            .execute(),
      },
      reads,
      cfg,
      typeGateway,
      licenseGateway: gateway,
      grant: deps.grant,
    }) as Record<string, Record<string, unknown>>;

    this.resolvers = mergeResolvers(machineResolvers, publisherResolvers);

    // Same row-level operations createResolvers builds privately; the keeper
    // needs them outside a resolver call.
    const findRow = (appId: string, user: string) =>
      db
        .selectFrom("app_user_environments")
        .selectAll()
        .where("app_id", "=", appId)
        .where("user_address", "=", user.toLowerCase())
        .executeTakeFirst()
        .then((r) => r ?? null);
    const reread = (row: AppUserEnvironments) =>
      db
        .selectFrom("app_user_environments")
        .selectAll()
        .where("app_id", "=", row.app_id)
        .where("user_address", "=", row.user_address)
        .executeTakeFirstOrThrow();
    const provisionDeps: ProvisionDeps = {
      ...deps.provision,
      findRow,
      countForApp: (appId) =>
        db
          .selectFrom("app_user_environments")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("app_id", "=", appId)
          .executeTakeFirstOrThrow()
          .then((r) => Number(r.n)),
      maxForApp: (appId) =>
        db
          .selectFrom("app_environment_limits")
          .select("max_environments")
          .where("app_id", "=", appId)
          .executeTakeFirst()
          .then((r) => r?.max_environments ?? cfg.defaultMaxEnvironments),
      claimRow: async (input) => {
        const row = { ...input, user_address: input.user_address.toLowerCase() };
        await db
          .insertInto("app_user_environments")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["app_id", "user_address"]).doNothing(),
          )
          .execute();
        return reread(row);
      },
      upsertRow: async (input) => {
        const row = { ...input, user_address: input.user_address.toLowerCase() };
        await db
          .insertInto("app_user_environments")
          .values(row)
          .onConflict((oc) =>
            oc.columns(["app_id", "user_address"]).doUpdateSet({
              license_id: row.license_id,
              template_hash: row.template_hash,
              updated_at: row.updated_at,
            }),
          )
          .execute();
        return reread(row);
      },
    };

    // Inert unless cfg.enabled (default false); dry-run (default true) is
    // honoured inside the keeper. Same cfg object as everything above.
    this.provisioningKeeper = new ProvisioningKeeper({
      allLicenses: reads.allLicenses,
      licenseTypes: reads.licenseTypes,
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
        // Resolve the template from the licence type document's details (with
        // a document-type check), not from reads.templateFor.
        const type = (await reads.licenseTypeDetails(appId)).find(
          (t) => t.id === licence.licenseTypeId,
        );
        if (!type) {
          console.warn(
            `[licensing] licence ${licence.licenseId}: type ${licence.licenseTypeId} not found for app ${appId}; skipping`,
          );
          return;
        }
        if (type.templateHash !== licence.templateHash) {
          console.warn(
            `[licensing] licence ${licence.licenseId}: type ${type.id} template changed since it was planned; skipping`,
          );
          return;
        }
        await applyEnvironmentTemplate(provisionDeps, {
          appId,
          user: licence.user,
          licenseId: licence.licenseId,
          template: type.template,
          label: type.label ?? type.kind,
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
