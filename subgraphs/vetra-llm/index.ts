import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import { defaultRenownOrgs } from "../../shared/renown-orgs.js";
import { createTenantOwnersCheck } from "../../shared/tenant-owners.js";
import { createReactorEnvGateway } from "../vetra-apps/envs.js";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import {
  appDidLookup,
  appDisputeLookup,
  createEnvAccess,
} from "../vetra-cloud-observability/env-access.js";
import type { SecretsDB } from "../vetra-cloud-secrets/db/schema.js";
import { createSecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import type { VetraLicensingDB } from "../vetra-licensing/db/schema.js";
import {
  appsTrustedIds,
  createStudioAccessDeps,
} from "../vetra-licensing/studio-access-factory.js";
import { up } from "./db/migrations.js";
import type { VetraLlmDB } from "./db/schema.js";
import { createLlmKeyStore } from "./store.js";
import { createProcessBroker, transitFromEnv } from "./factory.js";
import { createLlmResolvers } from "./resolvers.js";
import { schema } from "./schema.js";

/**
 * Vetra LLM: the OpenRouter key broker. One capped key per Studio, from the
 * licence's monthly budget (namespace "vetra-llm"). Without
 * OPENROUTER_MANAGEMENT_KEY or OPENBAO_ADDR the subgraph still loads and its
 * mutations answer SERVICE_NOT_CONFIGURED; no other subgraph breaks.
 */
export class VetraLlmSubgraph extends BaseSubgraph {
  name = "vetra-llm";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  protected timers: ReturnType<typeof setInterval>[] = [];

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-llm",
    )) as unknown as Kysely<VetraLlmDB>;
    await up(db as Kysely<any>);

    const transit = transitFromEnv(process.env);
    if (!transit)
      console.warn(
        "[vetra-llm] OPENBAO_ADDR unset — keys cannot be stored or written",
      );
    const secrets = transit
      ? createSecretsService({
          db: (await this.relationalDb.createNamespace(
            "vetra-cloud-secrets",
          )) as unknown as Kysely<SecretsDB>,
          transit,
        })
      : null;
    const licensingDb = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;
    const appsDb = (await this.relationalDb.createNamespace(
      "vetra-apps",
    )) as unknown as Kysely<VetraAppsDB>;
    const studio = createStudioAccessDeps({
      client: this.reactorClient as never,
      licensingDb,
      trustedIds: appsTrustedIds(appsDb),
      transit,
    });
    const { broker, cfg } = createProcessBroker({
      db,
      transit,
      secrets,
      studio,
      env: process.env,
    });
    if (!cfg.managementKey) {
      console.warn(
        "[vetra-llm] OPENROUTER_MANAGEMENT_KEY unset — Vetra LLM keys disabled (SERVICE_NOT_CONFIGURED)",
      );
    }

    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<DB>;
    const envs = createReactorEnvGateway(this.reactorClient as never);

    this.resolvers = createLlmResolvers({
      broker,
      tenantOwners: createTenantOwnersCheck(
        async (tenantId) =>
          (
            await envDb
              .selectFrom("environments")
              .select("owner")
              .where("tenantId", "=", tenantId)
              .execute()
          ).map((r) => r.owner?.toLowerCase() ?? null),
        { timeoutMs: 10_000, intervalMs: 500 },
        "[vetra-llm] provisionStudioLlm",
      ),
      envIdsByTenant: async (tenantId) =>
        (
          await envDb
            .selectFrom("environments")
            .select("id")
            .where("tenantId", "=", tenantId)
            .execute()
        ).map((r) => r.id),
      envRow: async (environmentId) =>
        (await envDb
          .selectFrom("environments")
          .select(["owner", "ownerOrgId", "appId", "tenantId"])
          .where("id", "=", environmentId)
          .executeTakeFirst()) ?? null,
      keyStatus: async (environmentId) =>
        (await createLlmKeyStore(db).get(environmentId))?.status ?? null,
      envState: (environmentId) => envs.getState(environmentId),
      access: createEnvAccess({
        orgs: defaultRenownOrgs(),
        appDidOf: appDidLookup(appsDb),
        appOrgDisputed: appDisputeLookup(appsDb),
      }),
      secrets,
      logger: console,
    });
  }

  async onDisconnect() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
