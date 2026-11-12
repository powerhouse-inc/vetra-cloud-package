import { plansConfigOf } from "../config.js";
import type { Caller } from "../auth.js";
import type { HolderDirectoryEntry } from "../directory.js";
import { publicUrlOf } from "../instances/public-host.js";
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
        "instances.custom_domain as custom_domain",
        "instances.custom_domain_status as custom_domain_status",
        "instances.status as status",
        "instances.reason as reason",
        "instances.running_version as runningVersion",
      ])
      .where("instances.status", "!=", "removed")
      // A soft-deleted App is gone for everyone but an admin.
      .where("apps.status", "!=", "DELETED");
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
  return [...own, ...shared].map(
    ({ host, custom_domain, custom_domain_status, ...r }) => ({
      ...r,
      url: publicUrlOf({ host, custom_domain, custom_domain_status }),
    }),
  );
}

/**
 * The App directory's plan instances for `address` ("Open your Sektar"): its
 * own instances of the App, and the App's shared instances of the plan kinds
 * it holds live. Not removed, of a live App, with an environment. Holder-only:
 * the service identity owns these documents, so the owner path never lists
 * them (directory.ts runsApp).
 */
export async function holderInstancesFor(
  deps: AppsDeps,
  appId: string,
  address: string,
): Promise<HolderDirectoryEntry[]> {
  // Plans off (production today): no plan instances to list, no licensing reads.
  if (!deps.licensingDb || !plansConfigOf(deps.cfg).enabled) return [];
  const holder = address.toLowerCase();
  const base = () =>
    deps.db
      .selectFrom("instances")
      .innerJoin("plans", "plans.id", "instances.plan_id")
      .innerJoin("apps", "apps.id", "instances.app_id")
      .select([
        "instances.environment_id as environmentId",
        "apps.name as appName",
        "plans.name as planName",
        "instances.host as host",
        "instances.custom_domain as custom_domain",
        "instances.custom_domain_status as custom_domain_status",
        "instances.status as status",
      ])
      .where("instances.app_id", "=", appId)
      .where("instances.status", "!=", "removed")
      .where("instances.environment_id", "is not", null)
      .where("apps.status", "!=", "DELETED");
  const own = await base()
    .where("instances.kind", "=", "own")
    .where("instances.holder_address", "=", holder)
    .orderBy("instances.created_at")
    .execute();
  const kinds = (
    await liveKindsOfHolder(deps.licensingDb, holder, deps.now().toISOString())
  ).filter((k) => k.appId === appId);
  const shared: typeof own = [];
  for (const k of kinds)
    shared.push(
      ...(await base()
        .where("instances.kind", "=", "shared")
        .where("plans.access", "=", "shared")
        .where("plans.kind", "=", k.kind)
        .execute()),
    );
  return [...own, ...shared].map((r) => ({
    environmentId: r.environmentId!,
    name: `${r.appName} (${r.planName})`,
    url: publicUrlOf(r),
    status: r.status,
  }));
}
