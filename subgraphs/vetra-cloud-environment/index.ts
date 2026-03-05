import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import { schema } from "./schema.js";
import { getResolvers } from "./resolvers.js";

export class VetraCloudEnvironmentSubgraph extends BaseSubgraph {
  override name = "vetra-cloud-environment";
  override typeDefs: DocumentNode = schema;
  override resolvers = getResolvers(this);
  override async onSetup() {}
}
