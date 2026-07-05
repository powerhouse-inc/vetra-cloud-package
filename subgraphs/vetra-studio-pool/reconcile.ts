export interface PoolRow {
  id: string;
  poolState: string | null; // WARMING | AVAILABLE | CLAIMED | null
  pinnedVersion: string | null;
  status: string | null;
}

export interface PoolTarget {
  size: number;
  version: string;
}

export interface PoolPlan {
  /** How many new warm envs to create to reach the target. */
  toCreate: number;
  /** Unclaimed live envs on a stale version → terminate (recycle). */
  toRecycle: string[];
  /**
   * The keeper's OWN dead warm envs (unclaimed WARMING/AVAILABLE that died, plus
   * any legacy FAILED marker) → DELETE them (full teardown). Merely clearing
   * poolState (the old behavior) left the namespace/pod/cert as an orphan AND
   * un-counted it, so the keeper endlessly recreated replacements — an unbounded
   * leak. Deleting removes the row too, so the next tick recreates exactly the
   * deficit rather than accumulating garbage.
   */
  toTerminate: string[];
  /**
   * Dead CLAIMED (user-owned) envs → clear poolState only. Their lifecycle
   * belongs to the owner, so we stop tracking them in the pool but never delete.
   */
  toClear: string[];
}

/**
 * Statuses that mean the env is dead or going away. A pool row in any of these
 * is a "zombie" — its poolState must be cleared so it's neither counted toward
 * the pool nor claimable. NOTE: the document model misspells the failure status
 * as "DEPLOYMENt_FAILED" (lowercase t) — match it exactly.
 */
export const DEAD_STATUSES = new Set<string>([
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
  "DEPLOYMENt_FAILED",
  "STOPPED",
]);

function isDead(status: string | null): boolean {
  return status !== null && DEAD_STATUSES.has(status);
}

/**
 * Decide the keeper's actions from the current pool rows:
 *  - `toClear`: any pool row (WARMING/AVAILABLE/CLAIMED) whose env is dead →
 *    clear its poolState (so recycled/terminated/failed envs stop counting and
 *    can't be claimed).
 *  - `toRecycle`: unclaimed LIVE envs on a stale version → terminate.
 *  - `toCreate`: deficit of LIVE current-version unclaimed envs vs target size.
 *
 * Only live (non-dead) WARMING/AVAILABLE envs count toward the pool, so a
 * WARMING env stuck in DEPLOYMENt_FAILED is cleared and replaced rather than
 * permanently occupying a slot.
 */
export function computePoolPlan(rows: PoolRow[], target: PoolTarget): PoolPlan {
  // The keeper's own dead warm envs — unclaimed WARMING/AVAILABLE that died,
  // plus any legacy FAILED marker — are garbage the pool created. DELETE them
  // (full teardown), never merely un-count them: an un-counted-but-undeleted
  // env orphans a namespace/pod/cert while the keeper recreates a replacement,
  // which is the runaway leak this fixes.
  const toTerminate = rows
    .filter(
      (r) =>
        r.poolState === "FAILED" ||
        ((r.poolState === "WARMING" || r.poolState === "AVAILABLE") &&
          isDead(r.status)),
    )
    .map((r) => r.id);

  // Dead CLAIMED envs are user-owned: stop tracking them in the pool, but never
  // delete — the owner controls that env's lifecycle.
  const toClear = rows
    .filter((r) => r.poolState === "CLAIMED" && isDead(r.status))
    .map((r) => r.id);

  const liveUnclaimed = rows.filter(
    (r) =>
      (r.poolState === "WARMING" || r.poolState === "AVAILABLE") &&
      !isDead(r.status),
  );
  const staleLive = liveUnclaimed.filter((r) => r.pinnedVersion !== target.version);
  const currentLive = liveUnclaimed.filter((r) => r.pinnedVersion === target.version);

  return {
    toCreate: Math.max(0, target.size - currentLive.length),
    toRecycle: staleLive.map((r) => r.id),
    toTerminate,
    toClear,
  };
}
