import { createHash } from "node:crypto";
import { plansConfigOf } from "../config.js";
import type { AppRow } from "../repo.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppsDeps } from "../service.js";
import {
  insertInstance,
  listInstances,
  updateInstance,
  type InstancePatch,
  type InstanceRow,
} from "../instances/repo.js";
import { targetOf, type InstanceTarget } from "../instances/targets.js";
import {
  chainEnds,
  chainKinds,
  licensedRoots,
  liveChains,
  type ChainEntry,
  type ChainHead,
} from "./holders.js";
import { listPlans, type PlanRow } from "./repo.js";
import { isOrgApp, isTeamPlan, TEAM_NOT_ORG } from "./team.js";

export const LICENCE_ENDED = "the licence ended";
export const PLAN_RETIRED = "the plan is retired and has no live licences";
/** The old model took the chain over (overview rule 1): its environment serves the holder. */
export const LICENSED_ENVIRONMENT =
  "the licence chain has a licensed environment";
const DAY_MS = 86_400_000;

export const isPlanKind = (kind: string) => kind === "shared" || kind === "own";

/** Stable per licence chain, holder-neutral (it appears in labels and logs). */
export const ownInstanceName = (root: string) =>
  `own-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;

async function planTarget(
  deps: AppsDeps,
  plan: PlanRow,
): Promise<InstanceTarget | null> {
  if (!plan.target_version) return null;
  const r = await releaseByVersion(deps.db, plan.app_id, plan.target_version);
  if (!r || r.kind !== "release") return null;
  try {
    return targetOf(r);
  } catch (err) {
    deps.logger.warn(`[vetra-apps] plan ${plan.slug}: ${String(err)}`);
    return null;
  }
}

const changed = (row: InstanceRow, p: InstancePatch) =>
  Object.entries(p).some(
    ([k, v]) => (row as unknown as Record<string, unknown>)[k] !== v,
  );

function newRow(
  deps: AppsDeps,
  app: AppRow,
  plan: PlanRow,
  target: InstanceTarget,
  nowIso: string,
  own: ChainHead | null,
) {
  return {
    id: deps.newId(),
    app_id: app.id,
    kind: own ? ("own" as const) : ("shared" as const),
    name: own ? ownInstanceName(own.root) : plan.slug,
    branch: null,
    pr: null,
    host: null,
    environment_id: null,
    ...target,
    running_version: null,
    running_digest: null,
    running_repository: null,
    status: "pending" as const,
    reason: null,
    failed_digest: null,
    update_started_at: null,
    removed_at: null,
    removed_reason: null,
    plan_id: plan.id,
    holder_address: own?.address ?? null,
    licence_root_id: own?.root ?? null,
    licence_ended_at: null,
    stop_reason: null,
    stopped_by_vetra: false,
    target_size: plan.size,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * The own plan serving each live chain: the plan of the head's kind; for a
 * head of no plan's kind (an upgrade or renewal to a term no plan adopted, or
 * an untyped one), the plan of the chain's most recent plan-kind licence.
 * Undefined when that plan is shared, or the chain never held a plan kind.
 */
async function ownPlanResolver(
  deps: AppsDeps,
  app: AppRow,
  plans: PlanRow[],
  live: Map<string, ChainHead>,
): Promise<(head: ChainHead) => PlanRow | undefined> {
  const byKind = new Map(
    plans.flatMap((p) => (p.kind ? [[p.kind, p] as const] : [])),
  );
  const own = (p: PlanRow | undefined) => (p?.access === "own" ? p : undefined);
  // Only chains whose head is of no plan's kind need their history.
  const roots = plans.some((p) => p.access === "own")
    ? [...live.values()]
        .filter((h) => !h.kind || !byKind.has(h.kind))
        .map((h) => h.root)
    : [];
  const history =
    roots.length > 0 && deps.licensingDb
      ? await chainKinds(deps.licensingDb, app.id, roots)
      : new Map<string, ChainEntry[]>();
  return (head) => {
    if (head.kind && byKind.has(head.kind)) return own(byKind.get(head.kind));
    const entries = history.get(head.root) ?? [];
    // Grants after the head (issued, never activated) are not the chain's past.
    const at = entries.findIndex((e) => e.licenseId === head.licenseId);
    for (let i = (at === -1 ? entries.length : at) - 1; i >= 0; i--) {
      const k = entries[i].kind;
      if (k && byKind.has(k)) return own(byKind.get(k));
    }
    return undefined;
  };
}

/**
 * Rows for the App's plan instances (spec section 5): one shared row per shared
 * plan while it is active or has live licences; one own row per live licence
 * chain of an own plan. A new row starts on its plan's target; an existing
 * row's target moves only through rollouts (rollouts/runner.ts) and pins
 * (releases phase 3 slice 3). Own rows exist unless the old model runs a
 * licensed environment for that chain (overview rule 1). A chain whose live head is of no plan's kind
 * stays under the plan of its most recent plan-kind licence when that plan is
 * own (cross-kind upgrades: the plan model owns a chain once it held a plan
 * kind; licensing leaves it alone too). Ended chains (stopAfterDays after the
 * licence's recorded end), chains the old model took over (at once) and
 * retired, unheld shared plans get a stop_reason; removed rows are left
 * alone; nothing is ever deleted here. Off while plans are off.
 */
export async function syncPlanInstances(
  deps: AppsDeps,
  app: AppRow,
): Promise<void> {
  const cfg = plansConfigOf(deps.cfg);
  // The kill switch holds for every caller, not only the reconciler.
  if (!cfg.enabled || !deps.licensingDb) return;
  const plans = await listPlans(deps.db, app.id);
  const shared = await listInstances(deps.db, app.id, "shared");
  const own = await listInstances(deps.db, app.id, "own");
  if (plans.length === 0 && shared.length === 0 && own.length === 0) return;
  const nowIso = deps.now().toISOString();
  const live = await liveChains(deps.licensingDb, app.id, nowIso);
  const licensed = await licensedRoots(deps.licensingDb, app.id);
  const targets = new Map<string, InstanceTarget | null>();
  for (const p of plans) targets.set(p.id, await planTarget(deps, p));
  const patch = (row: InstanceRow, p: InstancePatch) =>
    changed(row, p)
      ? updateInstance(deps.db, row.id, p, nowIso)
      : Promise.resolve(row);

  for (const plan of plans.filter((p) => p.access === "shared")) {
    const target = targets.get(plan.id) ?? null;
    // A kind-less plan (Team) is never held: untyped licences have kind null too.
    const held =
      plan.kind !== null &&
      [...live.values()].some((c) => c.kind === plan.kind);
    const notOrg = isTeamPlan(plan) && !isOrgApp(app);
    const wanted = (plan.status === "active" || held) && !notOrg;
    const row = shared.find((r) => r.plan_id === plan.id);
    if (!row) {
      if (wanted && target)
        await insertInstance(
          deps.db,
          newRow(deps, app, plan, target, nowIso, null),
        );
      continue;
    }
    await patch(row, {
      target_size: plan.size,
      stop_reason: wanted ? null : notOrg ? TEAM_NOT_ORG : PLAN_RETIRED,
    });
  }

  const ownPlanOf = await ownPlanResolver(deps, app, plans, live);
  const served = new Set<string>();
  for (const head of live.values()) {
    const plan = ownPlanOf(head);
    if (!plan || licensed.has(head.root)) continue;
    const target = targets.get(plan.id) ?? null;
    const row = own.find((r) => r.licence_root_id === head.root);
    if (row?.removed_at) {
      served.add(head.root);
      continue;
    }
    if (!row) {
      if (target) {
        await insertInstance(
          deps.db,
          newRow(deps, app, plan, target, nowIso, head),
        );
        served.add(head.root);
      }
      continue;
    }
    served.add(head.root);
    await patch(row, {
      plan_id: plan.id,
      holder_address: head.address,
      target_size: plan.size,
      licence_ended_at: null,
      stop_reason: null,
    });
  }
  const stopAfterMs = cfg.stopAfterDays * DAY_MS;
  const unserved = own.filter(
    (r) => !r.removed_at && !served.has(r.licence_root_id ?? ""),
  );
  const ends = await chainEnds(
    deps.licensingDb,
    app.id,
    unserved.flatMap((r) => (r.licence_root_id ? [r.licence_root_id] : [])),
    nowIso,
  );
  for (const row of unserved) {
    const root = row.licence_root_id ?? "";
    if (licensed.has(root)) {
      // Not an ended licence: the holder is served by the old model's environment now.
      await patch(row, {
        licence_ended_at: null,
        stop_reason: LICENSED_ENVIRONMENT,
      });
      continue;
    }
    // The recorded end when there is one, else when this was first noticed.
    const ended = ends.get(root) ?? row.licence_ended_at ?? nowIso;
    const due = deps.now().getTime() - Date.parse(ended) >= stopAfterMs;
    await patch(row, {
      licence_ended_at: ended,
      stop_reason: due ? LICENCE_ENDED : null,
    });
  }
}
