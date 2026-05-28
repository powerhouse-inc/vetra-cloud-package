import { hashNamespace } from "@powerhousedao/shared/processors";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { SecretsDB } from "../subgraphs/vetra-cloud-secrets/db/schema.js";
import { createRepository as createSubgraphRepository } from "../subgraphs/vetra-cloud-secrets/repository.js";
import type { SecretsRepository } from "../subgraphs/vetra-cloud-secrets/repository.js";
import type { RuntimeConfigDB } from "../subgraphs/runtime-config/db/schema.js";
import { createRepository as createRuntimeConfigSubgraphRepository } from "../subgraphs/runtime-config/repository.js";
import type { RuntimeConfigRepository } from "../subgraphs/runtime-config/repository.js";

/**
 * Resolve the Postgres schema name for the given reactor namespace.
 *
 * Reactor-api hashes the human-readable namespace ("vetra-cloud-secrets")
 * to a fixed-length lowercase base-26 string and uses that as the schema
 * name. The standalone controller doesn't have access to the reactor-api
 * runtime — but it needs to read from the same schema — so we recompute
 * the hash directly using the shared package's `hashNamespace`.
 */
export function resolveSchema(namespace: string): string {
  return hashNamespace(namespace);
}

export interface OwnedRepository extends SecretsRepository {
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * Build a `SecretsRepository` backed by a fresh Postgres pool the
 * controller fully owns (vs. the subgraph case which reuses the
 * reactor-api kysely). Returns the repo plus a `close()` for graceful
 * shutdown.
 */
export function createOwnedRepository(opts: {
  databaseUrl: string;
  namespace: string;
}): OwnedRepository {
  const schema = resolveSchema(opts.namespace);
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const baseDb = new Kysely<SecretsDB>({
    dialect: new PostgresDialect({ pool }),
  });
  const db = baseDb.withSchema(schema);
  const repo = createSubgraphRepository(db);

  return {
    schema,
    envVarsForTenant: (tenantId) => repo.envVarsForTenant(tenantId),
    secretsForTenant: (tenantId) => repo.secretsForTenant(tenantId),
    allTenantIds: () => repo.allTenantIds(),
    close: () => baseDb.destroy(),
  };
}

export interface OwnedRuntimeConfigRepository extends RuntimeConfigRepository {
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * Build a `RuntimeConfigRepository` backed by a fresh Postgres pool the
 * controller fully owns. The schema is recomputed via `hashNamespace` so the
 * controller reads the same schema that the runtime-config subgraph wrote.
 *
 * Mirrors `createOwnedRepository` for the secrets schema — the two pools
 * are independent so connection lifecycle is self-contained per source.
 */
export function createOwnedRuntimeConfigRepository(opts: {
  databaseUrl: string;
  namespace: string;
}): OwnedRuntimeConfigRepository {
  const schema = resolveSchema(opts.namespace);
  const pool = new Pool({ connectionString: opts.databaseUrl });
  const baseDb = new Kysely<RuntimeConfigDB>({
    dialect: new PostgresDialect({ pool }),
  });
  const db = baseDb.withSchema(schema);
  const repo = createRuntimeConfigSubgraphRepository(db);

  return {
    schema,
    runtimeConfigForTenant: (tenantId) => repo.runtimeConfigForTenant(tenantId),
    allTenantIds: () => repo.allTenantIds(),
    close: () => baseDb.destroy(),
  };
}
