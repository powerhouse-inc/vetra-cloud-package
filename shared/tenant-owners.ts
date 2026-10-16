import {
  createProjectionWait,
  type ProjectionWaitOptions,
} from "./projection-wait.js";

const UNDEFINED_TABLE = "42P01";

export type TenantOwnersResult =
  | { ok: true; owners: (string | null)[] }
  | { ok: false; reason: "UNVERIFIABLE" | "BUSY" | "UNKNOWN" };

/**
 * The owners of a tenant's environments, waiting for the projection: the cold
 * path writes a new Studio's tenant config right after pushing its document,
 * before the environment processor may have projected it. The wait is shared
 * per tenant and capped across tenants (projection-wait.ts): every slot taken
 * is BUSY. Still unknown after the window: UNKNOWN. A missing projection table
 * (42P01) fails closed as UNVERIFIABLE, logged. Moved from licensing's
 * applyStudioKey so vetra-llm's provisionStudioLlm checks exactly the same way.
 */
export function createTenantOwnersCheck(
  lookup: (tenantId: string) => Promise<(string | null)[]>,
  wait: ProjectionWaitOptions,
  logPrefix: string,
): (tenantId: string) => Promise<TenantOwnersResult> {
  let find: ReturnType<typeof createProjectionWait<string | null>> | null =
    null;
  return async (tenantId) => {
    find ??= createProjectionWait(lookup, wait);
    let owners: (string | null)[] | null;
    try {
      owners = await find(tenantId, { wait: true });
    } catch (err) {
      if ((err as { code?: unknown }).code === UNDEFINED_TABLE) {
        console.error(
          `${logPrefix}: tenant projection unreadable (${UNDEFINED_TABLE})`,
        );
        return { ok: false, reason: "UNVERIFIABLE" };
      }
      throw err;
    }
    if (owners === null) return { ok: false, reason: "BUSY" };
    if (owners.length === 0) return { ok: false, reason: "UNKNOWN" };
    return { ok: true, owners };
  };
}
