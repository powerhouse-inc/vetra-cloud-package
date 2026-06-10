import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { VetraAccessCodesDB } from "./db/schema.js";

/**
 * Early-access invite codes for vetra.to. Owns its own relational tables in
 * an isolated namespace; the management mutations are gated behind the
 * gateway's admin allowlist (see resolvers). No document model is involved.
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
    this.resolvers = createResolvers(db);
  }
}
