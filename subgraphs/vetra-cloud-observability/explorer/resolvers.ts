import type { Kysely } from "kysely";
import type { Pool } from "pg";
import { requireOwner } from "./auth.js";
import { describeDatabase, type DatabaseSchema } from "./describe.js";
import {
  executeReadOnlyQuery,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type DatabaseQueryResult,
} from "./execute.js";

type Caller = { user?: { address: string } };

type EnvRow = { id: string; tenantId: string | null; owner: string | null };

async function loadEnv(
  envDb: Kysely<any>,
  tenantId: string,
): Promise<EnvRow | null> {
  const row = (await envDb
    .selectFrom("environments")
    .select(["id", "tenantId", "owner"])
    .where("tenantId", "=", tenantId)
    .executeTakeFirst()) as EnvRow | undefined;
  return row ?? null;
}

export type ExplorerResolverDeps = {
  envDb: Kysely<any>;
  /**
   * Returns a `pg.Pool` for the supplied tenant namespace. The factory
   * is responsible for k8s secret reads + caching; the resolver
   * deliberately doesn't see those concerns. Errors thrown here (e.g.
   * secret missing, pooler unreachable) propagate as GraphQL errors.
   */
  getPool: (tenantNs: string) => Promise<Pool>;
};

/**
 * Factory mirroring `createDumpResolvers` from the dumps module. Both
 * the query and the mutation share the same owner-check shape:
 *   1. Load the env row by tenantId.
 *   2. Call `requireOwner` — throws UNAUTHENTICATED / FORBIDDEN /
 *      ENV_NOT_FOUND on a mismatch.
 *   3. Resolve the tenant pool and delegate to the pure helper.
 *
 * The pure helpers (`describeDatabase`, `executeReadOnlyQuery`) own
 * the actual sandboxing + statement-timeout logic; this file is just
 * the auth wrapper + GraphQL projection.
 */
export function createExplorerResolvers(deps: ExplorerResolverDeps) {
  const { envDb, getPool } = deps;

  return {
    Query: {
      describeDatabase: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ): Promise<DatabaseSchema> => {
        const env = await loadEnv(envDb, args.tenantId);
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });
        const pool = await getPool(args.tenantId);
        return describeDatabase(pool);
      },
    },
    Mutation: {
      executeReadOnlyQuery: async (
        _p: unknown,
        args: { tenantId: string; sql: string; limit?: number | null },
        ctx: Caller,
      ): Promise<DatabaseQueryResult> => {
        const env = await loadEnv(envDb, args.tenantId);
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });
        const limit =
          args.limit === null || args.limit === undefined
            ? DEFAULT_LIMIT
            : Math.min(MAX_LIMIT, Math.max(1, args.limit));
        const pool = await getPool(args.tenantId);
        return executeReadOnlyQuery(pool, args.sql, limit);
      },
    },
  };
}
