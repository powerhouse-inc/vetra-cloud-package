import { createHash } from "node:crypto";
import { planPoolSize, plansConfigOf } from "../config.js";
import {
  insertInstance,
  listInstances,
  type InstanceRow,
  type NewInstance,
} from "../instances/repo.js";
import type { InstanceTarget } from "../instances/targets.js";
import { wantsInstances } from "../instances/reconciler.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { listPlans, type PlanRow } from "./repo.js";
import { removeUnclaimedWarm } from "./pool-repo.js";
import { planTarget } from "./sync.js";

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

/**
 * Keeps each own plan's warm pool (W2, W5, W9). Under the App's lock, after
 * syncPlanInstances (so a new holder claims before the pool refills). Only
 * rows with warm = true and no holder are ever created or removed here.
 */
export async function syncPlanPools(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  const warm = (await listInstances(deps.db, app.id, "own")).filter(
    (r) => r.warm === true && !r.holder_address && !r.removed_at,
  );
  const on =
    plansConfigOf(deps.cfg).enabled &&
    deps.cfg.instances.enabled &&
    wantsInstances(app);
  // Nothing to keep and nothing to drain: the common case with pools off.
  if (!on && warm.length === 0) return;
  const plans = on ? await listPlans(deps.db, app.id) : [];
  const byPlan = new Map(plans.map((p) => [p.id, p]));
  // Rows of a plan that is gone, or of an App without pools, drain.
  for (const r of warm.filter((r) => !byPlan.has(r.plan_id ?? "")))
    await removeUnclaimedWarm(deps.db, r.id, POOL_OFF, nowIso);
  for (const plan of plans) {
    const rows = warm.filter((r) => r.plan_id === plan.id);
    const size = planPoolSize(deps.cfg, plan);
    if (size === 0 && rows.length === 0) continue;
    const target = size > 0 ? await planTarget(deps, plan) : null;
    const p = planPool(rows, {
      size,
      digest: target?.target_digest ?? null,
      targetSize: plan.size,
    });
    for (const r of p.remove)
      await removeUnclaimedWarm(deps.db, r.id, r.reason, nowIso);
    if (p.create && target)
      await insertInstance(deps.db, warmRow(deps, app, plan, target, nowIso));
  }
}

export function warmRow(
  deps: AppsDeps,
  app: AppRow,
  plan: PlanRow,
  target: InstanceTarget,
  nowIso: string,
): NewInstance {
  const id = deps.newId();
  return {
    id,
    app_id: app.id,
    kind: "own",
    name: warmInstanceName(id),
    branch: null,
    pr: null,
    host: null,
    environment_id: null,
    ...target,
    running_version: null,
    running_digest: null,
    running_repository: null,
    status: "pending",
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: plan.id,
    holder_address: null,
    licence_root_id: null,
    licence_ended_at: null,
    stop_reason: null,
    stopped_by_vetra: false,
    target_size: plan.size,
    warm: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
