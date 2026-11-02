import { DEAD_STATUSES } from "../vetra-studio-pool/reconcile.js";
import type { TemplateShape } from "./template.js";
import type { WarmRow } from "./warm-pool-db.js";

/** One (app, template) pool the keeper should keep filled. */
export interface PoolTarget {
  appId: string;
  appName: string;
  templateId: string;
  /** The RESOLVED template's hash, as provisionChain records it. */
  templateHash: string;
  size: number;
  /** The RESOLVED template. */
  template: TemplateShape;
}

export interface PoolPlanItem {
  /** New warm environments to create. */
  create: number;
  /** WARMING rows whose environment is READY: mark AVAILABLE. */
  promote: string[];
  /** Unclaimed rows to retire and whose environments to delete. */
  remove: string[];
}

const READY = "READY";

/**
 * The keeper's plan for one pool. Pure. `rows` are the pool's live rows;
 * `envStatus` maps an environment id to its document's status, null when the
 * document is missing. A CLAIMED row belongs to a licence and is never
 * promoted, removed or counted.
 *
 * `target` null (size 0, app suspended or gone, no active term) drains every
 * unclaimed row. Otherwise:
 *  - remove: rows on another template hash (recycle), rows whose environment
 *    is dead or missing (heal), and the surplus over min(size, maxPerTemplate):
 *    WARMING newest first, then AVAILABLE oldest first;
 *  - promote: the remaining WARMING rows whose environment is READY (they
 *    count as AVAILABLE for the surplus order);
 *  - create: the deficit after removal.
 */
export function computeAppPoolPlan(
  rows: WarmRow[],
  target: PoolTarget | null,
  envStatus: Record<string, string | null>,
  maxPerTemplate: number,
): PoolPlanItem {
  const unclaimed = rows.filter(
    (r) => r.state === "WARMING" || r.state === "AVAILABLE",
  );
  if (!target) {
    return {
      create: 0,
      promote: [],
      remove: unclaimed.map((r) => r.environment_id),
    };
  }

  const statusOf = (r: WarmRow): string | null =>
    envStatus[r.environment_id] ?? null;
  const unusable = (r: WarmRow): boolean => {
    const status = statusOf(r);
    return (
      r.template_hash !== target.templateHash ||
      status === null ||
      DEAD_STATUSES.has(status)
    );
  };
  const remove = unclaimed.filter(unusable).map((r) => r.environment_id);
  const kept = unclaimed.filter((r) => !unusable(r));
  const ready = (r: WarmRow) =>
    r.state === "AVAILABLE" || statusOf(r) === READY;

  const byCreated = (a: WarmRow, b: WarmRow) =>
    a.created_at.localeCompare(b.created_at);
  const warming = kept
    .filter((r) => !ready(r))
    .sort(byCreated)
    .reverse();
  const available = kept.filter(ready).sort(byCreated);
  const cap = Math.max(0, Math.min(target.size, maxPerTemplate));
  const surplus = Math.max(0, kept.length - cap);
  const surplusRows = [...warming, ...available].slice(0, surplus);
  const surplusIds = new Set(surplusRows.map((r) => r.environment_id));
  remove.push(...surplusRows.map((r) => r.environment_id));

  const promote = kept
    .filter(
      (r) =>
        r.state === "WARMING" &&
        statusOf(r) === READY &&
        !surplusIds.has(r.environment_id),
    )
    .map((r) => r.environment_id);

  return {
    create: Math.max(0, cap - (kept.length - surplus)),
    promote,
    remove,
  };
}
