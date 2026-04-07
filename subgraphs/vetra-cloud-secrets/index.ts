import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { SecretsDB } from "./db/schema.js";
import { OpenBaoKVClient } from "./openbao-kv.js";
import {
  syncEnvVarsToGitops,
  syncSecretsToGitops,
} from "./gitops-sync.js";

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
    let openbao: OpenBaoKVClient | null = null;

    if (openbaoAddr) {
      openbao = new OpenBaoKVClient(openbaoAddr);
      console.info("[secrets] OpenBao KV client initialized");
    } else {
      console.warn(
        "[secrets] OPENBAO_ADDR not set — secret mutations will fail",
      );
    }

    const gitopsFns = {
      syncEnvVarsToGitops,
      syncSecretsToGitops,
    };

    this.resolvers = createResolvers(
      db,
      openbao as OpenBaoKVClient,
      gitopsFns,
    );
  }

  async onDisconnect() {
    // No long-running resources to clean up
  }
}
