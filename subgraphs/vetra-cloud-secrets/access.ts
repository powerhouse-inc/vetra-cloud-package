import { GraphQLError } from "graphql";
import { callerIsAdmin } from "../../shared/admins.js";
import { decodeJwtPayload } from "../vetra-apps/auth.js";

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
  /** Max distinct tenants being waited on at once (default 16). */
  maxWaiters?: number;
}

/**
 * Does the Authorization header carry a workload (CI) token? Extracted the
 * way the host does (`header.split(" ")[1]`, any scheme, any case) so a header
 * the host authenticates can never slip past this check. Not verified on
 * purpose: any token with a `vetra` claim is refused.
 */
function carriesWorkloadToken(headers: SecretsContext["headers"]): boolean {
  const key = Object.keys(headers ?? {}).find(
    (k) => k.toLowerCase() === "authorization",
  );
  const raw = key ? headers?.[key] : undefined;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const token = header?.split(" ")[1];
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  return !!payload && payload.vetra !== undefined && payload.vetra !== null;
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
  const maxWaiters = deps.maxWaiters ?? 16;
  // One in-flight wait per tenant, shared by every caller asking for it.
  const inFlight = new Map<string, Promise<(string | null)[]>>();

  const poll = async (tenantId: string): Promise<(string | null)[]> => {
    const { timeoutMs, intervalMs } = deps.tenantWait;
    const attempts = Math.floor(timeoutMs / intervalMs) + 1;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const owners = await deps.tenantOwners(tenantId);
      if (owners.length > 0) return owners;
    }
    return [];
  };

  const knownOwners = async (
    tenantId: string,
    wait: boolean,
  ): Promise<(string | null)[]> => {
    const owners = await deps.tenantOwners(tenantId);
    if (owners.length > 0 || !wait) return owners;
    let pending = inFlight.get(tenantId);
    if (!pending) {
      if (inFlight.size >= maxWaiters) return []; // over the cap: refuse now
      pending = poll(tenantId).finally(() => inFlight.delete(tenantId));
      inFlight.set(tenantId, pending);
    }
    return pending;
  };

  /**
   * `wait` is true only for mutations: a just-created environment may not be
   * projected yet. Queries refuse an unknown tenant immediately.
   */
  return async function requireTenantAccess(
    ctx: SecretsContext | undefined,
    tenantId: string,
    opts: { wait?: boolean } = {},
  ): Promise<void> {
    if (!ctx?.user?.address) throw forbidden();
    const caller = ctx.user.address.toLowerCase();
    if (carriesWorkloadToken(ctx.headers)) throw forbidden();
    if (!tenantId) throw forbidden();

    let owners: (string | null)[];
    try {
      owners = await knownOwners(tenantId, opts.wait === true);
    } catch (err) {
      // Projection unreadable (e.g. table missing): fail closed, but leave a
      // trace. Only the error code/message, never request values.
      const e = (err ?? {}) as { code?: unknown; message?: unknown };
      console.error(
        "[secrets] tenant projection lookup failed:",
        typeof e.code === "string" ? e.code : "",
        typeof e.message === "string" ? e.message : "",
      );
      throw forbidden();
    }
    if (owners.length === 0) throw forbidden();
    if (callerIsAdmin(ctx, caller)) return;
    const ownsAll = owners.every((o) => !!o && o.toLowerCase() === caller);
    if (!ownsAll) throw forbidden();
  };
}
