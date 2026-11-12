import type { Caller } from "../auth.js";
import { INSTANCE_BASE_DOMAIN } from "../instances/reconciler.js";
import type { AppsDeps } from "../service.js";
import { liveKindsOfHolder } from "./holders.js";

export interface HolderInstanceJson {
  instanceId: string;
  appId: string;
  appName: string;
  planName: string;
  access: string;
  url: string | null;
  status: string;
  reason: string | null;
  runningVersion: string | null;
}

/** The instances the caller holds a licence for (spec section 11: a holder's own instances under their licences). */
export async function myInstancesFor(
  deps: AppsDeps,
  caller: Caller,
): Promise<HolderInstanceJson[]> {
  if (!deps.licensingDb) return [];
  const address = caller.address.toLowerCase();
  const base = () =>
    deps.db
      .selectFrom("instances")
      .innerJoin("plans", "plans.id", "instances.plan_id")
      .innerJoin("apps", "apps.id", "instances.app_id")
      .select([
        "instances.id as instanceId",
        "instances.app_id as appId",
        "apps.name as appName",
        "plans.name as planName",
        "plans.access as access",
        "instances.host as host",
        "instances.status as status",
        "instances.reason as reason",
        "instances.running_version as runningVersion",
      ])
      .where("instances.status", "!=", "removed");
  const own = await base()
    .where("instances.kind", "=", "own")
    .where("instances.holder_address", "=", address)
    .orderBy("instances.created_at")
    .execute();
  const kinds = await liveKindsOfHolder(
    deps.licensingDb,
    address,
    deps.now().toISOString(),
  );
  const shared: typeof own = [];
  for (const k of kinds)
    shared.push(
      ...(await base()
        .where("instances.kind", "=", "shared")
        .where("plans.access", "=", "shared")
        .where("plans.app_id", "=", k.appId)
        .where("plans.kind", "=", k.kind)
        .execute()),
    );
  return [...own, ...shared].map(({ host, ...r }) => ({
    ...r,
    url: host ? `https://${host}.${INSTANCE_BASE_DOMAIN}` : null,
  }));
}
