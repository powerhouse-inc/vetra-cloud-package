import type { Kysely } from "kysely";
import type { Pool } from "pg";
import { requireOwner } from "../dumps/auth.js";
import {
  restartAppDeployments,
  restartSingleService,
  truncateUserTables,
  type ResetK8sClient,
  type RestartableService,
} from "./service.js";

// Project invariant: tenantId IS the k8s namespace name. Every resolver
// that touches k8s resources (dump jobs, restore jobs, explorer pool,
// reset/restart) passes the GraphQL `tenantId` arg directly as the
// namespace. The dumps watcher and protection reconciler rely on the
// same identity. If this ever needs to diverge, add a mapping layer in
// ResetResolverDeps and update the dumps client too.

type Caller = { user?: { address: string } };

type EnvRow = { id: string; tenantId: string | null; owner: string | null };

/**
 * Shared env-row lookup. Duplicated in `dumps/resolvers.ts` and
 * `explorer/resolvers.ts` because the three modules were added at
 * different times and a shared "loadEnv" helper would be a single
 * extra file for ~10 lines — not worth the indirection yet. When a
 * fourth surface needs the same shape, lift it to a shared module.
 */
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

export type ResetResolverDeps = {
  envDb: Kysely<any>;
  /**
   * Returns a `pg.Pool` for the supplied tenant namespace. Reused
   * from the explorer module — the explorer's factory is the
   * canonical per-tenant pool cache; we deliberately don't create
   * a second pool so the subgraph's connection budget is one shared
   * resource.
   *
   * Optional: `resetEnvironment` throws `RESET_NOT_CONFIGURED` when
   * absent, but `restartEnvironmentService` keeps working — the
   * restart path only needs the k8s surface, not the DB pool. This
   * matters in environments where the explorer feature flag is off
   * (no per-tenant pool factory) but k8s access is wired and
   * Liberuum-style operators still need to restart services.
   */
  getPool?: (tenantNs: string) => Promise<Pool>;
  /**
   * Tenant-app k8s surface (list + restart deployments). Wired from
   * the same `DumpsK8sClient` that the dumps feature uses, with the
   * two new methods (`listAppDeployments`, `patchDeploymentRestart`)
   * added in commit 3.
   *
   * Optional: when absent both mutations throw their respective
   * NOT_CONFIGURED codes (reset needs k8s to restart deployments
   * after the truncate; restart needs it for the patch).
   */
  k8sClient?: ResetK8sClient;
};

/**
 * Factory mirroring `createDumpResolvers` and
 * `createExplorerResolvers`. Both mutations follow the same owner-
 * check shape — load the env by tenantId, requireOwner, then
 * delegate to the pure helpers in `service.ts`.
 *
 * Configuration fallback: when deps are absent the outer resolver
 * wires a fallback that throws RESET_NOT_CONFIGURED /
 * RESTART_NOT_CONFIGURED so the GraphQL non-null contract is
 * honoured (same pattern as dumps / explorer).
 */
export function createResetResolvers(deps: ResetResolverDeps) {
  const { envDb, getPool, k8sClient } = deps;

  return {
    Mutation: {
      resetEnvironment: async (
        _p: unknown,
        args: { tenantId: string },
        ctx: Caller,
      ): Promise<{
        ok: boolean;
        tablesCleared: number;
        deploymentsRestarted: number;
        message: string | null;
      }> => {
        // Reset needs both surfaces — pool for TRUNCATE, k8s for the
        // post-truncate rollout-restart. Either being absent gates
        // the whole feature with one error code so the UI's "Reset"
        // affordance can be hidden uniformly.
        if (!getPool || !k8sClient) throw new Error("RESET_NOT_CONFIGURED");

        const env = await loadEnv(envDb, args.tenantId);
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });
        // requireOwner already throws ENV_NOT_FOUND when owner is null,
        // but a missing row (owner === undefined → null) returns the
        // same error. Be explicit here for the case where requireOwner
        // would otherwise have raised UNAUTHENTICATED before reaching
        // the env check.
        if (!env) throw new Error("ENV_NOT_FOUND");

        const pool = await getPool(args.tenantId);

        let tablesCleared: number;
        try {
          tablesCleared = await truncateUserTables(pool);
        } catch (err) {
          throw new Error(
            "TRUNCATE_FAILED: " +
              (err instanceof Error ? err.message : String(err)),
          );
        }

        const { restarted, failed } = await restartAppDeployments(
          k8sClient,
          args.tenantId,
        );

        return {
          ok: true,
          tablesCleared,
          deploymentsRestarted: restarted,
          message:
            failed.length > 0
              ? `RESTART_PARTIAL: ${failed.length} deployment(s) failed: ${failed
                  .map((f) => f.name)
                  .join(", ")}`
              : null,
        };
      },
      restartEnvironmentService: async (
        _p: unknown,
        args: {
          tenantId: string;
          service: RestartableService;
          agentPrefix?: string | null;
        },
        ctx: Caller,
      ): Promise<{
        ok: boolean;
        deploymentName: string;
        message: string | null;
      }> => {
        // Restart only needs the k8s surface. Reusing the explorer's
        // pool factory was a convenience in `buildResetDeps`, but
        // operators can wire k8s without the explorer flag — in that
        // shape, reset is correctly gated above while restart still
        // works.
        if (!k8sClient) throw new Error("RESTART_NOT_CONFIGURED");

        const env = await loadEnv(envDb, args.tenantId);
        requireOwner({
          caller: ctx.user?.address ?? null,
          envOwner: env?.owner ?? null,
        });
        if (!env) throw new Error("ENV_NOT_FOUND");

        const deploymentName = await restartSingleService(
          k8sClient,
          args.tenantId,
          args.service,
          args.agentPrefix ?? undefined,
        );
        return { ok: true, deploymentName, message: null };
      },
    },
  };
}
