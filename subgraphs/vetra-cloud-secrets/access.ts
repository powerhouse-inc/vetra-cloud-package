import { GraphQLError } from "graphql";
import { callerIsAdmin } from "../../shared/admins.js";
import { bearerHasVetraClaim } from "../vetra-apps/auth.js";

/** Subset of the reactor-api resolver context used here. */
export interface SecretsContext {
  /** Set by reactor-api from the verified Renown bearer. */
  user?: { address: string };
  headers?: Record<string, string | string[] | undefined>;
  isAdmin?: (address: string) => boolean;
}

export interface TenantAccessDeps {
  /**
   * Owners (lowercased, null when unset) of the environments deployed as this
   * tenant, from the vetra-cloud-environment projection. Empty when no
   * environment is known by this tenant id (yet).
   */
  tenantOwners(tenantId: string): Promise<(string | null)[]>;
  /**
   * How long to wait for an unknown tenant to be projected: vetra.io writes a
   * new environment's config right after pushing its document, before the
   * processor may have projected it (same window as applyStudioKey).
   */
  tenantWait: { timeoutMs: number; intervalMs: number };
}

/**
 * One message for every refusal (anonymous, CI token, unknown tenant, not
 * the owner) so a caller cannot tell whether a tenant exists.
 */
const DENIED = "Not allowed to manage this tenant's configuration";

function forbidden(): GraphQLError {
  return new GraphQLError(DENIED, { extensions: { code: "FORBIDDEN" } });
}

/**
 * Builds the guard every envVars/secrets query and mutation runs first.
 *
 * Allowed: a Renown-authenticated platform admin, or the owner of every
 * environment deployed as the tenant (same owner rule as the observability
 * subgraph's owner-or-admin mutations: `owner` set and equal to the caller,
 * lowercased). CI/workload tokens (bearer carries a `vetra` claim) are
 * refused, as in vetra-apps.
 *
 * In-process callers (environment processor gitops, studio-pool claim,
 * licensing applyStudioKey) use SecretsService directly and never reach this.
 *
 * TODO(organisations): extend to org environments via
 * shared/org-access.ts `canOperate` once the organisations branch lands.
 */
export function createTenantGuard(deps: TenantAccessDeps) {
  const knownOwners = async (tenantId: string): Promise<(string | null)[]> => {
    const { timeoutMs, intervalMs } = deps.tenantWait;
    const attempts = Math.floor(timeoutMs / intervalMs) + 1;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const owners = await deps.tenantOwners(tenantId);
      if (owners.length > 0) return owners;
    }
    return [];
  };

  return async function requireTenantAccess(
    ctx: SecretsContext | undefined,
    tenantId: string,
  ): Promise<void> {
    if (!ctx?.user?.address) throw forbidden();
    const caller = ctx.user.address.toLowerCase();
    if (bearerHasVetraClaim({ headers: ctx.headers })) throw forbidden();
    if (!tenantId) throw forbidden();

    let owners: (string | null)[];
    try {
      owners = await knownOwners(tenantId);
    } catch {
      // Projection unreadable (e.g. table missing): fail closed.
      throw forbidden();
    }
    if (owners.length === 0) throw forbidden();
    if (callerIsAdmin(ctx, caller)) return;
    const ownsAll = owners.every((o) => !!o && o.toLowerCase() === caller);
    if (!ownsAll) throw forbidden();
  };
}
