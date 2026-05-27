import type { Kysely } from "kysely";
import type { DocumentNode } from "graphql";
import { createResolvers } from "./resolvers.js";
import { KyselyEnvVarsStore } from "./store.js";
import type { EnvVarsTable } from "./store.js";
import { typeDefs } from "./schema.js";
import type { EnvVarsStore } from "./types.js";

export type VetraCloudRuntimeConfigOptions = {
  /**
   * Storage backend. Defaults to a `KyselyEnvVarsStore` wired to the
   * `relationalDb` from the subgraph args. Tests and alternative
   * deployments can pass an in-memory or custom implementation.
   */
  store?: EnvVarsStore;
};

/**
 * Vetra Cloud Runtime Config subgraph. Exposes `runtimeConfig` /
 * `setRuntimeConfig` for the deployed Connect instance of a tenant.
 *
 * Wired in deployment: instantiate with `new VetraCloudRuntimeConfigSubgraph(args)`
 * inside the Switchboard's subgraph registration flow, the same way
 * `vetra-cloud-secrets` is registered. The class deliberately does NOT
 * extend `BaseSubgraph` at the package level so we avoid a hard dependency
 * on a specific `@powerhousedao/reactor-api` major; the deployment can
 * subclass and add framework-specific glue (lifecycle hooks, permission
 * services) if needed.
 */
export class VetraCloudRuntimeConfigSubgraph {
  public readonly name = "vetra-cloud-runtime-config";
  public readonly hasSubscriptions = false;
  public readonly typeDefs: DocumentNode = typeDefs;
  public readonly resolvers: ReturnType<typeof createResolvers>;

  constructor(
    args: {
      relationalDb?: unknown;
      options?: VetraCloudRuntimeConfigOptions;
    } = {},
  ) {
    const store =
      args.options?.store ??
      new KyselyEnvVarsStore(args.relationalDb as Kysely<EnvVarsTable>);
    this.resolvers = createResolvers({ store });
  }
}
