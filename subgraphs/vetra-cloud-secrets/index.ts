import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { SecretsDB } from "./db/schema.js";
import { OpenBaoTransitClient } from "./openbao-transit.js";

const DEFAULT_ROLE = "vetra-secrets";

/**
 * GraphQL surface for tenant env vars + secrets.
 *
 * Reads/writes go through the encrypted Postgres tables; on every write
 * the resolvers `pg_notify('vetra_secrets_changed', tenantId)` so the
 * standalone `secrets-controller` pod (see `/secrets-controller`) can
 * reconcile that tenant's `<tenantId>-env` ConfigMap and
 * `<tenantId>-secrets` Secret in the tenant namespace.
 *
 * History note: between commits e98be36 and the standalone-controller
 * restoration in May 2026, this subgraph also embedded the reconcile
 * loop directly. The management switchboard's ServiceAccount has no
 * cross-namespace RBAC, so every reconcile attempt failed and no
 * tenant ever saw its secrets reach a pod. The reconciler now lives in
 * its own deployment with its own ClusterRole; this subgraph is a
 * pure GraphQL service again.
 */
export class VetraCloudSecretsSubgraph extends BaseSubgraph {
  name = "vetra-cloud-secrets";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-secrets",
    )) as unknown as Kysely<SecretsDB>;

    await up(db as Kysely<any>);

    const openbaoAddr = process.env.OPENBAO_ADDR;
    if (!openbaoAddr) {
      throw new Error(
        "[secrets] OPENBAO_ADDR is required — secrets cannot be encrypted without transit engine access",
      );
    }

    const transit = new OpenBaoTransitClient({
      addr: openbaoAddr,
      role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_ROLE,
      keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
    });

    this.resolvers = createResolvers(db, transit);
  }
}
