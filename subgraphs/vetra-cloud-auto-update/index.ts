import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";

export class VetraCloudAutoUpdateSubgraph extends BaseSubgraph {
  name = "vetra-cloud-auto-update";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  async onSetup() {
    this.resolvers = createResolvers(this.reactorClient);
    console.info("[auto-update] Subgraph initialized");
  }

  async onDisconnect() {
    // No cleanup needed
  }
}
