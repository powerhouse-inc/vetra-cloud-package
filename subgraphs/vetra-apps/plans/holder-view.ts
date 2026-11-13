import { plansConfigOf, switchoverConfigOf } from "../config.js";
import type { SwitchoverRow } from "../switchover/repo.js";
import { DESTROY_AFTER_DAYS } from "../holders/notices.js";
import type { Caller } from "../auth.js";
import type { HolderDirectoryEntry } from "../directory.js";
import { publicUrlOf } from "../instances/public-host.js";
import {
  customDomainJson,
  type InstanceCustomDomainJson,
} from "../domains/service.js";
import { holderUpdateOf, type HolderUpdateJson } from "../rollouts/holder.js";
import type { AppsDeps } from "../service.js";
import { holderNotices, type HolderNotice } from "../holders/notices.js";
import { liveChains, liveKindsOfHolder } from "./holders.js";

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
  /** own: the holder's custom domain (null: none). */
  customDomain: InstanceCustomDomainJson | null;
  /** The live licence's end (null: open-ended or none live). */
  licenceEndsAt: string | null;
  /** own, licence ended: when Vetra stops the instance (null once stopped). */
  stopsAt: string | null;
  /** own, licence ended and deletion on: when its data is deleted. */
  deletesAt: string | null;
  notices: HolderNotice[];
  /** own, just switched over from a licensed environment: ask the holder to check it (confirmSwitchover). */
  switchover: HolderSwitchoverJson | null;
  /** A coming update of this instance (spec 7 step 3); null when none. */
  update: HolderUpdateJson | null;
}

export interface HolderSwitchoverJson {
  id: string;
  state: string;
  /** Without an answer by then the switch-over counts as confirmed. */
  confirmBy: string;
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
        "plans.kind as planKind",
        "instances.licence_root_id as rootId",
        "instances.licence_ended_at as endedAt",
        "instances.host as host",
        "instances.custom_domain as custom_domain",
        "instances.custom_domain_status as custom_domain_status",
        "instances.custom_domain_reason as custom_domain_reason",
        "instances.custom_domain_since as custom_domain_since",
        "instances.custom_domain_token as custom_domain_token",
        "instances.status as status",
        "instances.reason as reason",
        "instances.running_version as runningVersion",
        "instances.kind as kind",
      ])
      .where("instances.status", "!=", "removed")
      // A soft-deleted App is gone for everyone but an admin.
      .where("apps.status", "!=", "DELETED");
  const own = await base()
    .where("instances.kind", "=", "own")
    .where("instances.holder_address", "=", address)
    // A switch-over owns its instance until it links it: not theirs to see before.
    .where("instances.switchover_id", "is", null)
    .orderBy("instances.created_at")
    .execute();
  const checking = new Map(
    (
      await deps.db
        .selectFrom("switchovers")
        .selectAll()
        .where("holder_address", "=", address)
        .where("mode", "=", "real")
        .where("state", "in", ["LINKING", "AWAITING_CONFIRMATION"])
        .execute()
        .catch(() => [])
    ).flatMap((s) => (s.instance_id ? [[s.instance_id, s] as const] : [])),
  );
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
  const now = deps.now().toISOString();
  const plans = plansConfigOf(deps.cfg);
  const chains = new Map<string, Awaited<ReturnType<typeof liveChains>>>();
  const chainsOf = async (appId: string) => {
    let c = chains.get(appId);
    if (!c) chains.set(appId, (c = await liveChains(deps.licensingDb!, appId, now)));
    return c;
  };
  const out: HolderInstanceJson[] = [];
  for (const {
    host,
    custom_domain,
    custom_domain_status,
    custom_domain_reason,
    custom_domain_since,
    custom_domain_token,
    planKind,
    rootId,
    endedAt,
    kind,
    ...r
  } of [...own, ...shared]) {
    const d = {
      host,
      custom_domain,
      custom_domain_status,
      custom_domain_reason,
      custom_domain_since,
      custom_domain_token,
    };
    const live = await chainsOf(r.appId);
    // own: its chain's live head. shared: the holder's own live licence of the plan's kind.
    const ends =
      r.access === "own"
        ? rootId && live.has(rootId)
          ? [live.get(rootId)!.endAt]
          : []
        : [...live.values()]
            .filter((c) => c.address === address && c.kind === planKind)
            .map((c) => c.endAt);
    const endAt = ends.length === 0 || ends.includes(null)
      ? null
      : ends.reduce((a, b) => (Date.parse(a!) >= Date.parse(b!) ? a : b));
    const ownEnded = r.access === "own" ? (endedAt ?? null) : null;
    const stopped = r.status === "stopped";
    const destroy = {
      enabled: plans.destroy === true,
      afterDays: DESTROY_AFTER_DAYS,
    };
    const notices = holderNotices({
      now,
      endAt,
      endedAt: ownEnded,
      stopped,
      stopAfterDays: plans.stopAfterDays,
      destroy,
    });
    out.push({
      ...r,
      url: publicUrlOf(d),
      customDomain: customDomainJson(d),
      licenceEndsAt: endAt,
      stopsAt: notices.find((n) => n.kind === "ENDED_STOP_PENDING")?.at ?? null,
      deletesAt:
        notices.find(
          (n) =>
            n.kind === "STOPPED_DELETE_PENDING" || n.kind === "DELETE_IMMINENT",
        )?.at ?? null,
      notices,
      switchover: switchoverJson(deps, checking.get(r.instanceId)),
      update: await holderUpdateOf(deps, r.instanceId, kind),
    });
  }
  return out;
}

function switchoverJson(
  deps: AppsDeps,
  s: SwitchoverRow | undefined,
): HolderSwitchoverJson | null {
  if (!s) return null;
  const since = Date.parse(s.started_at ?? s.step_started_at ?? s.updated_at);
  return {
    id: s.id,
    state: s.state,
    confirmBy: new Date(
      since + switchoverConfigOf(deps.cfg).confirmHours * 3_600_000,
    ).toISOString(),
  };
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
    .where("instances.switchover_id", "is", null)
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
