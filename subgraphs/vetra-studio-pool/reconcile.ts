export interface PoolRow {
  id: string;
  poolState: string | null; // WARMING | AVAILABLE | CLAIMED | FAILED
  pinnedVersion: string | null;
  status: string | null;
}

export interface PoolTarget {
  size: number;
  version: string;
}

export interface PoolPlan {
  toCreate: number;
  toRecycle: string[];
}

/**
 * Decide how many warm envs to create and which unclaimed stale-version envs to
 * recycle. Counts only WARMING/AVAILABLE envs on the target version toward the
 * pool. CLAIMED envs are never touched. FAILED envs are ignored.
 */
export function computePoolPlan(rows: PoolRow[], target: PoolTarget): PoolPlan {
  const unclaimed = rows.filter(
    (r) => r.poolState === "WARMING" || r.poolState === "AVAILABLE",
  );
  const stale = unclaimed.filter((r) => r.pinnedVersion !== target.version);
  const current = unclaimed.filter((r) => r.pinnedVersion === target.version);
  return {
    toCreate: Math.max(0, target.size - current.length),
    toRecycle: stale.map((r) => r.id),
  };
}
