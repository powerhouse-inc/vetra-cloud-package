import type { AppUserEnvironments } from "./db/schema.js";

export interface ReleaseDeps {
  findRowByEnvironment(
    environmentId: string,
  ): Promise<AppUserEnvironments | null>;
  /** Current status of the environment document, or null when it is gone. */
  environmentStatus(environmentId: string): Promise<string | null>;
  /** Drives the environment document to STOPPED. Never destroys it. */
  stopEnvironment(environmentId: string): Promise<void>;
  deleteRow(appId: string, user: string): Promise<void>;
}

/**
 * Statuses from which SLEEP_ENVIRONMENT is either pointless or rejected, and
 * which already mean "this environment is not serving anyone". Releasing one
 * is just forgetting the row.
 */
const ALREADY_RELEASED = new Set([
  "STOPPED",
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
]);

/**
 * Stop an environment and forget the mapping. Archival and destruction stay
 * with the existing housekeeping ladder: ReleaseDeps offers no way to delete a
 * document. Returns false when there is nothing to do (or the environment is
 * another app's), so the handler can call it freely.
 *
 * Idempotent in the same way as the housekeeping subgraph's own sleep helper:
 * an environment already asleep, being torn down, or gone entirely is reported
 * as released and its row dropped. Only a transient status (DEPLOYING, say)
 * lets the rejection propagate, which keeps the row for the next tick to retry.
 */
export async function releaseEnvironment(
  deps: ReleaseDeps,
  callerAppId: string,
  environmentId: string,
): Promise<boolean> {
  const row = await deps.findRowByEnvironment(environmentId);
  if (!row || row.app_id !== callerAppId) return false;

  const status = await deps.environmentStatus(environmentId);
  if (status !== null && !ALREADY_RELEASED.has(status)) {
    await deps.stopEnvironment(environmentId);
  }
  await deps.deleteRow(row.app_id, row.user_address);
  return true;
}
