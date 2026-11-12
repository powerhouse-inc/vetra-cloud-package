import type { Caller } from "../auth.js";
import { plansConfigOf } from "../config.js";
import { appsError, notConfigured } from "../errors.js";
import { getInstance, type InstanceRow } from "../instances/repo.js";
import { getPlan, type PlanRow } from "../plans/repo.js";
import { getApp, type AppRow } from "../repo.js";
import { assertNotWorkload, type AppsDeps } from "../service.js";

export interface OwnInstance {
  row: InstanceRow;
  app: AppRow;
  plan: PlanRow;
}

const notFound = () => appsError("NOT_FOUND", "Instance not found");

/** Plans on, or SERVICE_NOT_CONFIGURED (holder APIs, Global Constraints). */
export function assertPlansOn(deps: AppsDeps): void {
  if (!plansConfigOf(deps.cfg).enabled) throw notConfigured("Plans");
}

/**
 * An own instance by id, not removed, its App not DELETED, its plan known.
 * NOT_FOUND otherwise. No caller check: internal paths (slice 9) only.
 */
export async function loadOwnInstance(
  deps: AppsDeps,
  instanceId: string,
): Promise<OwnInstance> {
  assertPlansOn(deps);
  const row = await getInstance(deps.db, instanceId);
  if (!row || row.kind !== "own" || row.status === "removed" || !row.plan_id)
    throw notFound();
  const app = await getApp(deps.db, row.app_id);
  if (!app || app.status === "DELETED") throw notFound();
  const plan = await getPlan(deps.db, row.plan_id);
  if (!plan) throw notFound();
  return { row, app, plan };
}

/**
 * The caller's own instance (spec 14.5): kind own, holder_address = caller,
 * not removed, its App not DELETED. Holder-only (H3): no platform-admin or
 * publisher bypass. NOT_FOUND for anything else (never "exists but not
 * yours"). SERVICE_NOT_CONFIGURED while plans are off. An App's workload
 * identity is refused as on the owner paths.
 */
export async function loadOwnInstanceForHolder(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<OwnInstance> {
  assertPlansOn(deps);
  await assertNotWorkload(deps, caller);
  const own = await loadOwnInstance(deps, instanceId);
  if (own.row.holder_address?.toLowerCase() !== caller.address.toLowerCase())
    throw notFound();
  return own;
}
