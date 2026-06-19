import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { VetraGithubAuthDB } from "./db/schema.js";

/**
 * Binds a user's Renown identity to the GitHub App installation they own, and
 * brokers short-lived installation push tokens for the agent. Owns its own
 * relational table in an isolated namespace; every resolver is keyed off the
 * gateway-verified caller DID. App secrets (private key, client secret) are
 * read from the environment by `github-app.ts`, never stored here.
 */
export class VetraGithubAuthSubgraph extends BaseSubgraph {
  name = "vetra-github-auth";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-github-auth",
    )) as unknown as Kysely<VetraGithubAuthDB>;

    await up(db as Kysely<any>);
    this.resolvers = createResolvers(db);
  }
}
