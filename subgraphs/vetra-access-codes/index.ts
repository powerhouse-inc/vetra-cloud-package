import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { VetraAccessCodesDB } from "./db/schema.js";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import {
  createSecretsService,
  type SecretsService,
} from "../vetra-cloud-secrets/services/secrets-service.js";
import type { SecretsDB } from "../vetra-cloud-secrets/db/schema.js";

const DEFAULT_TRANSIT_ROLE = "vetra-secrets";

/**
 * Early-access invite codes for vetra.to. Owns its own relational tables in
 * an isolated namespace; the management mutations are gated behind the
 * gateway's admin allowlist (see resolvers). No document model is involved.
 *
 * Codes may carry an attached Claude API key. The key is encrypted at rest via
 * OpenBao transit and, on studio provisioning, written into the tenant secret
 * store server-side — reusing the `vetra-cloud-secrets` service in-process so
 * the key never leaves the reactor.
 */
export class VetraAccessCodesSubgraph extends BaseSubgraph {
  name = "vetra-access-codes";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-access-codes",
    )) as unknown as Kysely<VetraAccessCodesDB>;

    await up(db as Kysely<any>);

    const openbaoAddr = process.env.OPENBAO_ADDR;
    if (!openbaoAddr) {
      throw new Error(
        "[access-codes] OPENBAO_ADDR is required — attached Claude keys cannot be encrypted without transit engine access",
      );
    }
    const transit = new OpenBaoTransitClient({
      addr: openbaoAddr,
      role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_TRANSIT_ROLE,
      keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
    });

    // Reuse the vetra-cloud-secrets tables in-process to write tenant secrets.
    // The secrets subgraph owns the schema (runs its own `up()`); we only
    // read/write through the shared service, mirroring how the gitops
    // processor consumes it.
    const secretsDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-secrets",
    )) as unknown as Kysely<SecretsDB>;
    const secretsService: SecretsService = createSecretsService({
      db: secretsDb,
      transit,
    });

    this.resolvers = createResolvers(db, { transit, secretsService });
  }
}
