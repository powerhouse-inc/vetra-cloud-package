import type { Caller } from "../auth.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { INSTANCE_BASE_DOMAIN } from "./reconciler.js";
import { listInstances, type InstanceRow } from "./repo.js";

export interface InstanceJson {
  id: string;
  kind: string;
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
  environmentId: string | null;
  updatedAt: string;
}

export function instanceJson(r: InstanceRow): InstanceJson {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    branch: r.branch,
    pr: r.pr,
    url: r.host ? `https://${r.host}.${INSTANCE_BASE_DOMAIN}` : null,
    status: r.status,
    reason: r.reason,
    targetVersion: r.target_version,
    targetDigest: r.target_digest,
    runningVersion: r.running_version,
    runningDigest: r.running_digest,
    environmentId: r.environment_id,
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
  return (await listInstances(deps.db, app.id))
    .filter((r) => r.status !== "removed")
    .map(instanceJson);
}
