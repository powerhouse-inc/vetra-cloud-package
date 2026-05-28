import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { RuntimeConfigDB } from "./db/schema.js";
import { RUNTIME_CONFIG_DB_NAMESPACE } from "./types.js";

/**
 * GraphQL surface for editing the deployed Connect SPA's powerhouse.config.json
 * for a given tenant.
 *
 * Storage: writes to its own Postgres schema
 *   `hashNamespace("vetra-cloud-runtime-config")`
 * via `this.relationalDb.createNamespace(...)`. One row per tenant in
 * `tenant_runtime_config(tenantId, value, updatedAt)` where `value` is the
 * JSON-encoded `connect.*` subtree.
 *
 * Propagation: every write emits `pg_notify('vetra_runtime_config_changed',
 * tenantId)` in the same transaction. The standalone `secrets-controller`
 * pod (see `/secrets-controller/main.ts`) listens on that channel, reads
 * the runtime-config row, and projects it as a single
 * `PH_CONNECT_CONFIG_JSON` entry in the tenant's `<tenantId>-env`
 * ConfigMap — alongside the secrets-controller's existing env var and
 * secret projections. Stakater Reloader then rolls the Connect pod, whose
 * entrypoint deep-merges `PH_CONNECT_CONFIG_JSON` into
 * `/dist/powerhouse.config.json`.
 */
export class RuntimeConfigSubgraph extends BaseSubgraph {
  name = "runtime-config";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      RUNTIME_CONFIG_DB_NAMESPACE,
    )) as unknown as Kysely<RuntimeConfigDB>;

    await up(db as Kysely<any>);

    this.resolvers = createResolvers(db);
  }
}
