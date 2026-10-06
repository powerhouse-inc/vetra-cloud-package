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
        deleteRow: async (appId, user) => {
          await db
            .deleteFrom("app_user_environments")
            .where("app_id", "=", appId)
            .where("user_address", "=", user.toLowerCase())
            .execute();
        },
      },
      cfg,
      read: {
        licenses: reads.licenses,
        licenseTypes: reads.licenseTypes,
        templateFor: reads.templateFor,
      },
    };

    this.resolvers = createResolvers(db, deps);

    // Inert unless the environment sets cfg.enabled; dry-run by default.
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
    await super.onDisconnect();
  }
}
