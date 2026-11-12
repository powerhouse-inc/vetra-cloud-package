import { deriveStudioPowerState, type StudioPowerStatus } from "./policy.js";
import type { StudioRow } from "./db.js";
import type { StudioPowerStateResult } from "./resolvers.js";

export function studioPowerResult(
  host: string,
  row: StudioRow | null,
  status: StudioPowerStatus,
): StudioPowerStateResult {
  return {
    host,
    envId: row?.envId ?? null,
    subdomain: row?.subdomain ?? null,
    owner: row?.owner ?? null,
    status,
  };
}

/**
 * NOTE: this guard covers the housekeeping wake path only. A WAKE_ENVIRONMENT
 * dispatched directly on the environment document bypasses it; offboarding
 * re-sleeps such an environment on its next tick (stopped_at stays set).
 */
export function createWake(deps: {
  findStudioByHost(host: string): Promise<StudioRow | null>;
  dispatchWake(envId: string): Promise<void>;
  /** An environment stopped by licence offboarding stays stopped until re-licensed. */
  isLicenceStopped(envId: string): Promise<boolean>;
  /**
   * Held by housekeeping (VETRA_HOUSEKEEPING_KEEPS_DATABASE): asleep although its
   * status reads READY; `dispatchWake` releases the hold.
   */
  isHeld?(envId: string): Promise<boolean>;
}): (host: string) => Promise<StudioPowerStateResult> {
  return async (host) => {
    const row = await deps.findStudioByHost(host);
    if (!row) throw new Error("STUDIO_NOT_FOUND");
    const current = (await deps.isHeld?.(row.envId))
      ? "SLEEPING"
      : deriveStudioPowerState(row);
    // Idempotent: only a SLEEPING studio is woken; otherwise report state.
    if (current !== "SLEEPING") return studioPowerResult(host, row, current);
    if (await deps.isLicenceStopped(row.envId)) return studioPowerResult(host, row, "SLEEPING");
    await deps.dispatchWake(row.envId);
    return studioPowerResult(host, row, "WAKING");
  };
}
