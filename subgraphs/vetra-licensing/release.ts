import type { AppUserEnvironments } from "./db/schema.js";

export interface ReleaseDeps {
  findRowByEnvironment(
    environmentId: string,
  ): Promise<AppUserEnvironments | null>;
  /** Drives the environment document to STOPPED. Never destroys it. */
  stopEnvironment(environmentId: string): Promise<void>;
  deleteRow(appId: string, user: string): Promise<void>;
}

/**
 * Stop an environment and forget the mapping. Archival and destruction stay
 * with the existing housekeeping ladder: ReleaseDeps offers no way to delete a
 * document. Returns false when there is nothing to do (or the environment is
 * another app's), so the handler can call it freely.
 */
export async function releaseEnvironment(
  deps: ReleaseDeps,
  callerAppId: string,
  environmentId: string,
): Promise<boolean> {
  const row = await deps.findRowByEnvironment(environmentId);
  if (!row || row.app_id !== callerAppId) return false;

  await deps.stopEnvironment(environmentId);
  await deps.deleteRow(row.app_id, row.user_address);
  return true;
}
