import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { SecretsDB } from "./db/schema.js";
import { OpenBaoTransitClient } from "./openbao-transit.js";

const DEFAULT_ROLE = "vetra-secrets";

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

  async onDisconnect() {
    // No long-running resources to clean up
  }
}
