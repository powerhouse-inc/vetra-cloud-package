import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { ChainEnvRows } from "./environments.js";

/**
 * A licence chain whose environment the holder deleted: the license_environments row outlives
 * the document, and provisionChain holds such a chain ("never recreate behind the row's back").
 * The holder asking for a new environment (recreateEnvironment, or a redeem onto the chain) is
 * what lets it go: the row is dropped, so the next provision creates a fresh environment.
 */
export interface DropDeps {
  rows: Pick<ChainEnvRows, "byRoot" | "remove">;
  envState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
  /** The old environment's reporting token. */
  forgetEnvironment(environmentId: string): Promise<void>;
  /** The chain's lock (lockChain), so provisioning never races the drop. */
  lock<T>(root: string, fn: () => Promise<T>): Promise<T>;
}

/** Drops the chain's row when its environment is gone; the dropped environment id, else null. */
export async function dropDeletedEnvironment(
  deps: DropDeps,
  chain: { root: string; userDid: string; appId: string },
): Promise<string | null> {
  return deps.lock(chain.root, async () => {
    const row = await deps.rows.byRoot(chain.root);
    if (!row || row.user_did !== chain.userDid || row.app_id !== chain.appId) return null;
    if (await deps.envState(row.environment_id)) return null;
    await deps.forgetEnvironment(row.environment_id);
    await deps.rows.remove(row.environment_id);
    return row.environment_id;
  });
}
