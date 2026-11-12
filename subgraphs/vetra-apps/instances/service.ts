import type { Caller } from "../auth.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { publicUrlOf } from "./public-host.js";
import {
  customDomainJson,
  type InstanceCustomDomainJson,
} from "../domains/service.js";
import { listInstances, type InstanceRow } from "./repo.js";

export interface InstanceJson {
  id: string;
  kind: string;
  /** shared/own: the plan it serves. */
  planId: string | null;
  /** own: the holder's address. */
  holder: string | null;
  name: string;
  branch: string | null;
  pr: number | null;
  url: string | null;
  status: string;
  reason: string | null;
  targetVersion: string | null;
  targetDigest: string | null;
  runningVersion: string | null;
  runningDigest: string | null;
  /** The App settings revision the instance should run (VETRA_SETTINGS_REVISION). */
  settingsRevision: string | null;
  /** The settings revision it last ran healthy. */
  runningSettingsRevision: string | null;
  health: string | null;
  healthCheck: string | null;
  healthReason: string | null;
  healthCheckedAt: string | null;
  observedDigest: string | null;
  observedDigestSource: string | null;
  environmentId: string | null;
  /** own: how many settings its holder set (never their names, H2). */
  holderSettingsCount: number;
  customDomain: InstanceCustomDomainJson | null;
  updatedAt: string;
}

/** holderSettingsCount is 0 here; appInstancesFor fills it in. */
export function instanceJson(r: InstanceRow): InstanceJson {
  return {
    id: r.id,
    kind: r.kind,
    planId: r.plan_id ?? null,
    holder: r.holder_address ?? null,
    name: r.name,
    branch: r.branch,
    pr: r.pr,
    url: publicUrlOf(r),
    status: r.status,
    reason: r.reason,
    targetVersion: r.target_version,
    targetDigest: r.target_digest,
    runningVersion: r.running_version,
    runningDigest: r.running_digest,
    settingsRevision: r.target_settings,
    runningSettingsRevision: r.running_settings,
    health: r.health,
    healthCheck: r.health_check,
    healthReason: r.health_reason,
    healthCheckedAt: r.health_checked_at,
    observedDigest: r.observed_digest,
    observedDigestSource: r.observed_digest_source,
    environmentId: r.environment_id,
    holderSettingsCount: 0,
    customDomain: customDomainJson(r),
    updatedAt: r.updated_at,
  };
}

/** The App's instances (spec section 11, App page → Instances); tombstones are not shown. */
export async function appInstancesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<InstanceJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const rows = (await listInstances(deps.db, app.id)).filter(
    (r) => r.status !== "removed",
  );
  const own = rows.filter((r) => r.kind === "own").map((r) => r.id);
  const counts = new Map<string, number>();
  if (own.length > 0)
    for (const c of await deps.db
      .selectFrom("instance_settings")
      .select(["instance_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("instance_id", "in", own)
      .groupBy("instance_id")
      .execute())
      counts.set(c.instance_id, Number(c.n));
  return rows.map((r) => ({
    ...instanceJson(r),
    holderSettingsCount: counts.get(r.id) ?? 0,
  }));
}
