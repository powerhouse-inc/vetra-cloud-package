import { createHash } from "node:crypto";
import type { InstanceRow } from "../instances/repo.js";

/** The environment label's name part while warm: `<App> · own (warm)`. */
export const WARM_LABEL = "own (warm)";
export const MAX_WARM_POOL_SIZE = 10;
export const POOL_STALE = "warm pool: the plan's target or size moved";
export const POOL_SURPLUS = "warm pool: over the pool size";
export const POOL_OFF = "warm pool: the plan has no pool";

/** Stable per row, holder-neutral; renamed to ownInstanceName(root) by the claim. */
export const warmInstanceName = (id: string) =>
  `own-warm-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

export interface PoolWant {
  size: number;
  /** The plan's target digest; null: no target, the pool drains. */
  digest: string | null;
  targetSize: string;
}
export type PoolRow = Pick<
  InstanceRow,
  | "id"
  | "status"
  | "target_digest"
  | "running_digest"
  | "target_size"
  | "created_at"
>;
export interface PoolPlan {
  create: boolean;
  remove: Array<{ id: string; reason: string }>;
}

const ready = (r: PoolRow) =>
  r.status === "ready" && r.running_digest === r.target_digest;
const byAge = (a: PoolRow, b: PoolRow) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * One pass of a plan's warm pool (W5, W6), after licensing's
 * computeAppPoolPlan: the surplus goes (not ready newest first, then ready
 * oldest first), stale rows (another target or size) go once the pool would
 * be over size, and one row is created while fresh ones are short.
 */
export function planPool(rows: PoolRow[], want: PoolWant): PoolPlan {
  if (want.size <= 0 || !want.digest)
    return {
      create: false,
      remove: [...rows]
        .sort(byAge)
        .map((r) => ({ id: r.id, reason: POOL_OFF })),
    };
  const isFresh = (r: PoolRow) =>
    r.target_digest === want.digest && r.target_size === want.targetSize;
  const fresh = rows.filter(isFresh);
  const stale = rows.filter((r) => !isFresh(r)).sort(byAge);
  const remove: PoolPlan["remove"] = [];
  const surplus = Math.max(0, fresh.length - want.size);
  const order = [
    ...fresh
      .filter((r) => !ready(r))
      .sort(byAge)
      .reverse(),
    ...fresh.filter(ready).sort(byAge),
  ];
  for (const r of order.slice(0, surplus))
    remove.push({ id: r.id, reason: POOL_SURPLUS });
  const freshKept = fresh.length - surplus;
  let staleKept = stale.length;
  for (const r of stale) {
    if (freshKept + staleKept <= want.size) break;
    remove.push({ id: r.id, reason: POOL_STALE });
    staleKept--;
  }
  return { create: freshKept < want.size, remove };
}
