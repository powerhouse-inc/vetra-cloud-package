import { GraphQLError } from "graphql";
import { callerIsAdmin } from "../../shared/admins.js";
import { createProjectionWait } from "../../shared/projection-wait.js";
import { decodeJwtPayload } from "../vetra-apps/auth.js";
import {
  OWNER_ONLY_ACCESS,
  type EnvAccess,
  type EnvAccessRow,
} from "../vetra-cloud-observability/env-access.js";

/** Subset of the reactor-api resolver context used here. */
export interface SecretsContext {
  /** Set by reactor-api from the verified Renown bearer. */
  user?: { address: string };
  headers?: Record<string, string | string[] | undefined>;
  isAdmin?: (address: string) => boolean;
}

export interface TenantAccessDeps {
  /**
   * The environments deployed as this tenant (owner, owning organisation and
   * linked app), from the vetra-cloud-environment projection. Empty when no
   * environment is known by this tenant id (yet).
   */
  tenantEnvironments(tenantId: string): Promise<EnvAccessRow[]>;
  /**
   * Environment access (shared/org-access.ts `canOperate`, app DID resolved
   * as in the observability subgraph). Defaults to OWNER_ONLY_ACCESS: org
   * environments are then admin-only.
   */
  access?: Pick<EnvAccess, "canOperate">;
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
 * allowed to operate) so a caller cannot tell whether a tenant exists.
 */
const DENIED = "Not allowed to manage this tenant's configuration";

function forbidden(): GraphQLError {
  return new GraphQLError(DENIED, { extensions: { code: "FORBIDDEN" } });
}

/**
 * Builds the guard every envVars/secrets query and mutation runs first.
 *
 * Allowed: a Renown-authenticated platform admin, or a caller who may
 * operate EVERY environment deployed as the tenant, per shared/org-access.ts
 * `canOperate`:
 *  - personal environment (no ownerOrgId): `owner` set and equal to the
 *    caller, lowercased; Renown is never consulted;
 *  - organisation environment: the caller's membership has publisher
 *    capability (OWNER/ADMIN, or PUBLISHER whose scope covers the env's app
 *    DID). An unreadable app link or Renown failure denies (fail closed).
 * Reads require the same as writes: env vars can hold configuration secrets,
 * so a plain org MEMBER (canView) is refused. CI/workload tokens (bearer
 * carries a `vetra` claim) are refused, as in vetra-apps.
 *
 * In-process callers (environment processor gitops, studio-pool claim,
 * licensing applyStudioKey) use SecretsService directly and never reach this.
 */
export function createTenantGuard(deps: TenantAccessDeps) {
  const access = deps.access ?? OWNER_ONLY_ACCESS;
  // Bounded wait (shared/projection-wait.ts): one in-flight poll per tenant,
  // at most `maxWaiters` tenants at once; over the cap (null) is a refusal.
  const findEnvironments = createProjectionWait(
    (tenantId) => deps.tenantEnvironments(tenantId),
    { ...deps.tenantWait, maxWaiters: deps.maxWaiters },
  );
  const knownEnvironments = async (tenantId: string, wait: boolean): Promise<EnvAccessRow[]> =>
    (await findEnvironments(tenantId, { wait })) ?? [];

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

    let envs: EnvAccessRow[];
    try {
      envs = await knownEnvironments(tenantId, opts.wait === true);
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
    if (envs.length === 0) throw forbidden();
    if (callerIsAdmin(ctx, caller)) return;
    const who = { address: caller, isAdmin: false };
    for (const env of envs) {
      // canOperate fails closed itself; a throw is a refusal too.
      const ok = await access.canOperate(who, env).catch(() => false);
      if (!ok) throw forbidden();
    }
  };
}
