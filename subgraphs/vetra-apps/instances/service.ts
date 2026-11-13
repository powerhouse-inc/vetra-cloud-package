import type { Caller } from "../auth.js";
import { appsError } from "../errors.js";
import { getGateToken } from "../gate/repo.js";
import { instanceGateJson, type InstanceGateJson } from "../gate/service.js";
import { releaseByVersion, type ReleaseRow } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { INSTANCE_BASE_DOMAIN } from "./reconciler.js";
import { getInstance, listInstances, type InstanceRow } from "./repo.js";

export interface InstanceJson {
  id: string;
  kind: string;
  /** shared/own: the plan it serves. */
  planId: string | null;
  /** own: the holder's address. */
  holder: string | null;
  /** own: the release the publisher pinned it to; rollouts skip it. */
  pinnedVersion: string | null;
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
  /** A warm-pool instance: no holder yet, closed to everyone. */
  warm: boolean;
  /** When a holder claimed it from the warm pool. */
  claimedAt: string | null;
  updatedAt: string;
  /** shared only: the licence gate (releases phase 3 slice 5). */
  gate: InstanceGateJson | null;
}

/** Without the gate (null); appInstances adds it for shared instances. */
export function instanceJson(r: InstanceRow): InstanceJson {
  return {
    id: r.id,
    kind: r.kind,
    planId: r.plan_id ?? null,
    holder: r.holder_address ?? null,
    pinnedVersion: r.pinned_version ?? null,
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
    settingsRevision: r.target_settings,
    runningSettingsRevision: r.running_settings,
    health: r.health,
    healthCheck: r.health_check,
    healthReason: r.health_reason,
    healthCheckedAt: r.health_checked_at,
    observedDigest: r.observed_digest,
    observedDigestSource: r.observed_digest_source,
    environmentId: r.environment_id,
    warm: r.warm === true,
    claimedAt: r.claimed_at ?? null,
    updatedAt: r.updated_at,
    gate: null,
  };
}

/** Releases by version, each read once per call (instances of a plan share one). */
function releaseReader(deps: AppsDeps, appId: string) {
  const seen = new Map<string, Promise<ReleaseRow | null>>();
  return (version: string | null) => {
    if (!version) return Promise.resolve(null);
    let r = seen.get(version);
    if (!r) {
      r = releaseByVersion(deps.db, appId, version).then((x) => x ?? null);
      seen.set(version, r);
    }
    return r;
  };
}

async function withGateJson(
  deps: AppsDeps,
  r: InstanceRow,
  release: ReturnType<typeof releaseReader>,
): Promise<InstanceJson> {
  if (r.kind !== "shared") return instanceJson(r);
  const [token, rel] = await Promise.all([
    getGateToken(deps.db, r.id),
    release(r.running_version ?? r.target_version),
  ]);
  return { ...instanceJson(r), gate: instanceGateJson(deps, token, rel) };
}

/** The App's instances (spec section 11, App page → Instances); tombstones are not shown. */
export async function appInstancesFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<InstanceJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const release = releaseReader(deps, app.id);
  return Promise.all(
    (await listInstances(deps.db, app.id))
      .filter((r) => r.status !== "removed")
      .map((r) => withGateJson(deps, r, release)),
  );
}

/** One instance as appInstances shows it. */
export async function instanceJsonFor(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<InstanceJson> {
  const r = await getInstance(deps.db, instanceId);
  if (!r) throw appsError("NOT_FOUND", "Instance not found");
  await loadAppForOwner(deps, caller, r.app_id, { need: "view" });
  return withGateJson(deps, r, releaseReader(deps, r.app_id));
}
