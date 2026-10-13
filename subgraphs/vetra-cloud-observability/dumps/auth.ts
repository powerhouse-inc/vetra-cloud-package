import type { EnvAccess, EnvAccessRow } from "../env-access.js";

/**
 * Auth predicate for the dumps surface.
 *
 * Stricter than the rest of the observability subgraph (where logs/pods
 * etc. trust tenantId). A dump file IS the database — anyone holding the
 * presigned URL can download every row, so we enforce access on every
 * mutation and every list call, with no platform-admin bypass. A
 * personal env admits its owner only; an org env admits an OWNER or
 * ADMIN of the owning organisation only, not publishers (fail closed
 * when Renown is unreachable). The presigned
 * URL is minted at read time, not stored, so a leaked URL has at most
 * 15-min authority.
 */
export type AuthorizeDumpInput = {
  caller: string | null | undefined;
  env: EnvAccessRow | null | undefined;
};

export async function authorizeDump(
  access: EnvAccess,
  { caller, env }: AuthorizeDumpInput,
): Promise<void> {
  if (!caller) throw new Error("UNAUTHENTICATED");
  if (!env || (!env.owner && !env.ownerOrgId)) throw new Error("ENV_NOT_FOUND");
  const who = { address: caller.toLowerCase(), isAdmin: false };
  const allowed = env.ownerOrgId
    ? await access.isOrgAdmin(who, env.ownerOrgId)
    : await access.canOperate(who, env);
  if (!allowed) {
    throw new Error("FORBIDDEN");
  }
}
