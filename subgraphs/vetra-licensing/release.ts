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
  /**
   * Hard-deletes the environment document. releaseEnvironment calls it for a
   * DRAFT document and for nothing else.
   */
  deleteEnvironment(environmentId: string): Promise<void>;
  logger: Pick<Console, "warn">;
}

/**
 * Statuses from which SLEEP_ENVIRONMENT is either pointless or rejected, and
 * which already mean "this environment is not serving anyone". Releasing one
 * is just forgetting the row. DRAFT is included because it means the document
 * was never deployed, so there is nothing to put to sleep.
 */
const ALREADY_RELEASED = new Set([
  "DRAFT",
  "STOPPED",
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
]);

/**
 * Stop an environment and forget the mapping. Archival and destruction stay
 * with the existing housekeeping ladder; the single exception is a document
 * still at exactly DRAFT, which this subgraph created and never initialised
 * (a claim whose action list was rejected). It holds no customer state and no
 * row will reference it once the row is dropped, so it is reclaimed here
 * rather than leaked. Anything that was ever READY never reaches that path.
 * Returns false when there is nothing to do (or the environment is
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
  // Exact equality, deliberately: not a status list, not a negation.
  if (status === "DRAFT") {
    try {
      await deps.deleteEnvironment(environmentId);
    } catch (err) {
      // Never block forgetting the row: the next tick would only fail the same
      // way. The document is leaked in that case, so say so.
      deps.logger.warn(
        `[licensing] could not delete DRAFT environment ${environmentId} while releasing it; the document is now unreferenced: ${String(err)}`,
      );
    }
  }
  await deps.deleteRow(row.app_id, row.user_address);
  return true;
}
