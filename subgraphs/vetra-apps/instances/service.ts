import type { Caller } from "../auth.js";
import { appsError } from "../errors.js";
import { getGateToken } from "../gate/repo.js";
import { instanceGateJson, type InstanceGateJson } from "../gate/service.js";
import { releaseByVersion, type ReleaseRow } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { publicUrlOf } from "./public-host.js";
import {
  customDomainJson,
  type InstanceCustomDomainJson,
} from "../domains/service.js";
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
  /** own: how many settings its holder set (never their names, H2). */
  holderSettingsCount: number;
  customDomain: InstanceCustomDomainJson | null;
  updatedAt: string;
  /** shared only: the licence gate (releases phase 3 slice 5). */
  gate: InstanceGateJson | null;
}

/** Without the gate (null) and holderSettingsCount 0; appInstances adds them. */
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
  const rows = (await listInstances(deps.db, app.id)).filter(
    (r) => r.status !== "removed",
  );
  const counts = await holderSettingCounts(
    deps,
    rows.filter((r) => r.kind === "own").map((r) => r.id),
  );
  return Promise.all(
    rows.map(async (r) => ({
      ...(await withGateJson(deps, r, release)),
      holderSettingsCount: counts.get(r.id) ?? 0,
    })),
  );
}

/** How many settings each own instance's holder set (never their names, H2). */
async function holderSettingCounts(
  deps: AppsDeps,
  own: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (own.length > 0)
    for (const c of await deps.db
      .selectFrom("instance_settings")
      .select(["instance_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("instance_id", "in", own)
      .groupBy("instance_id")
      .execute())
      counts.set(c.instance_id, Number(c.n));
  return counts;
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
  const counts = await holderSettingCounts(deps, r.kind === "own" ? [r.id] : []);
  return {
    ...(await withGateJson(deps, r, releaseReader(deps, r.app_id))),
    holderSettingsCount: counts.get(r.id) ?? 0,
  };
}
