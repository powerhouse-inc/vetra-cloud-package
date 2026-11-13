import {
  gateConfigOf,
  instanceHealth,
  plansConfigOf,
  rolloutsEnabled,
} from "../config.js";
import { frozenReasonOf } from "../../vetra-licensing/rollout-db.js";
import { liveChains } from "../plans/holders.js";
import { listPlans } from "../plans/repo.js";
import { feedsLicensedHost } from "../releases/licensed-host.js";
import { releaseByVersion } from "../releases/repo.js";
import type { AppsDeps } from "../service.js";
import { listSwitchovers, type SwitchoverMode } from "./repo.js";

export interface SwitchoverFacts {
  mode: SwitchoverMode;
  row: {
    appId: string;
    endedAt: string | null;
    switchedOverAt: string | null;
    rootLicenseId: string;
    templateId: string | null;
  } | null;
  env: {
    status: string;
    owner: string | null;
    customDomain: string | null;
    /** Names of the FUSION service's env entries. */
    fusionEnvNames: string[];
    /** The ADMINS entry's addresses, lowercased. */
    admins: string[];
    fusionHost: boolean;
  } | null;
  template: { mode: "SHARED" | "DEDICATED" } | null;
  appHasSharedTerm: boolean;
  /** Slice 5's licence gate is on and has an URL. */
  gateActive: boolean;
  chainLive: boolean;
  holder: string | null;
  kind: string | null;
  plan: {
    id: string;
    access: "own" | "shared";
    status: string;
    targetVersion: string | null;
  } | null;
  release: {
    version: string;
    digest: string | null;
    /** A stable release (not a build, not a prerelease). */
    stable: boolean;
  } | null;
  /** Another real switch-over of the App is past PREPARED. */
  openSwitchoverOnApp: boolean;
  frozen: boolean;
  switches: {
    instances: boolean;
    plans: boolean;
    rollouts: boolean;
    healthEnforce: boolean;
  };
}

/** The env entries a Sektar-shaped licensed environment carries (F6): nothing beyond them can be copied by the switch-over. */
const PARITY_ENV = new Set(["ADMINS", "PH_HOST"]);

/**
 * Why this licensed environment cannot be switched over now; empty when it
 * can. Each entry is shown in the console, so it says what to do. Pure.
 */
export function checkSwitchover(f: SwitchoverFacts): string[] {
  const why: string[] = [];
  if (!f.row) return ["this is not a licensed environment"];
  if (f.row.switchedOverAt) why.push("it was already switched over");
  if (f.row.endedAt || (!f.chainLive && !f.row.switchedOverAt))
    why.push("its licence ended");
  if (!f.env) {
    why.push("its environment document cannot be read");
  } else {
    if (f.env.status !== "READY")
      why.push(`its environment is ${f.env.status}, not READY`);
    if (!f.env.fusionHost)
      why.push("its environment is not a FUSION host (no PH_HOST)");
    const only =
      f.env.owner !== null &&
      f.env.admins.length === 1 &&
      f.env.admins[0] === f.env.owner.toLowerCase();
    if (!only)
      why.push(
        "its admins are not exactly its owner (the own instance's admin is the holder alone)",
      );
    if (f.env.customDomain)
      why.push(
        "it has a custom domain, which the switch-over does not carry (move the domain first)",
      );
    const extra = f.env.fusionEnvNames.filter((n) => !PARITY_ENV.has(n));
    if (extra.length > 0)
      why.push(
        `its FUSION service has settings beyond ADMINS and PH_HOST (${extra.join(", ")}), which the switch-over does not carry`,
      );
  }
  if (f.template === null) why.push("its template cannot be found");
  else if (f.template.mode !== "DEDICATED")
    why.push("its template is not DEDICATED");
  if (f.appHasSharedTerm && !f.gateActive)
    why.push(
      "the App has a SHARED term and the licence gate is not on (slice 5): shared holders would be left without access",
    );
  if (!f.plan) why.push("no own plan adopted this licence kind");
  else {
    if (f.plan.access !== "own") why.push("the kind's plan is not an own plan");
    if (f.plan.status !== "active") why.push("the kind's plan is retired");
  }
  if (!f.release || !f.release.stable)
    why.push("the plan's target is not a stable release");
  else if (!f.release.digest)
    why.push("the plan's target release has no image digest");
  if (f.openSwitchoverOnApp)
    why.push("another switch-over of this App is running");
  if (f.mode === "real" && !f.frozen)
    why.push("the App's gated releases are not frozen");
  const off = (name: string, on: boolean) => {
    if (!on) why.push(`${name} is off`);
  };
  off("VETRA_APPS_INSTANCES", f.switches.instances);
  off("VETRA_APPS_PLANS", f.switches.plans);
  off("rollouts", f.switches.rollouts);
  off(
    "instance health enforcement (VETRA_APPS_INSTANCE_HEALTH=enforce)",
    f.switches.healthEnforce,
  );
  return why;
}

const PAST_PREPARED = new Set([
  "HOLDING_OLD",
  "BACKING_UP",
  "RESTORING",
  "CHECKING_COPY",
  "STARTING",
  "VERIFYING",
  "LINKING",
  "AWAITING_CONFIRMATION",
  "ROLLING_BACK",
]);

const adminsOf = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

interface AppTerms {
  terms?: Array<{ kind?: unknown; templateId?: unknown }>;
  templates?: Array<{ id?: unknown; mode?: unknown }>;
}

/** Everything checkSwitchover decides from, read now. Writes nothing. */
export async function gatherSwitchoverFacts(
  deps: AppsDeps,
  environmentId: string,
  mode: SwitchoverMode = "real",
): Promise<SwitchoverFacts> {
  const licensingDb = deps.licensingDb;
  const plansOn = plansConfigOf(deps.cfg).enabled;
  const switches = {
    instances: deps.cfg.instances.enabled,
    plans: plansOn,
    rollouts: rolloutsEnabled(deps.cfg),
    healthEnforce: instanceHealth(deps.cfg).mode === "enforce",
  };
  const empty: SwitchoverFacts = {
    mode,
    row: null,
    env: null,
    template: null,
    appHasSharedTerm: false,
    gateActive: false,
    chainLive: false,
    holder: null,
    kind: null,
    plan: null,
    release: null,
    openSwitchoverOnApp: false,
    frozen: false,
    switches,
  };
  if (!licensingDb) return empty;
  const r = await licensingDb
    .selectFrom("license_environments")
    .selectAll()
    .where("environment_id", "=", environmentId)
    .executeTakeFirst();
  if (!r) return empty;
  const row = {
    appId: r.app_id,
    endedAt: r.ended_at,
    switchedOverAt: r.switched_over_at ?? null,
    rootLicenseId: r.root_license_id,
    templateId: r.template_id,
  };
  const state = await deps.envs.getState(environmentId);
  const fusionEnv = state?.fusion?.env ?? [];
  const env: SwitchoverFacts["env"] = state
    ? {
        status: state.status,
        owner: state.owner ?? null,
        customDomain:
          state.customDomain?.enabled && state.customDomain.domain
            ? state.customDomain.domain
            : null,
        fusionEnvNames: fusionEnv.map((e) => e.name),
        admins: adminsOf(fusionEnv.find((e) => e.name === "ADMINS")?.value),
        fusionHost:
          state.services.some((s) => s.type === "FUSION" && s.enabled) &&
          fusionEnv.some((e) => e.name === "PH_HOST"),
      }
    : null;

  const doc = ((await deps.docs?.getState(r.app_id)) ??
    null) as AppTerms | null;
  const modeOf = (templateId: unknown): "SHARED" | "DEDICATED" | null => {
    const m = doc?.templates?.find((t) => t.id === templateId)?.mode;
    return m === "SHARED" || m === "DEDICATED" ? m : null;
  };
  const rowMode = modeOf(r.template_id);
  const template = rowMode ? { mode: rowMode } : null;
  const appHasSharedTerm = (doc?.terms ?? []).some(
    (t) => modeOf(t.templateId) === "SHARED",
  );
  const gate = gateConfigOf(deps.cfg);

  const nowIso = deps.now().toISOString();
  const head = (await liveChains(licensingDb, r.app_id, nowIso)).get(
    r.root_license_id,
  );
  const kind = head?.kind ?? null;
  const plan = kind
    ? ((await listPlans(deps.db, r.app_id)).find((p) => p.kind === kind) ??
      null)
    : null;
  const rel = plan?.target_version
    ? await releaseByVersion(deps.db, r.app_id, plan.target_version)
    : null;
  const others = (await listSwitchovers(deps.db, r.app_id)).filter(
    (s) =>
      s.mode === "real" &&
      s.environment_id !== environmentId &&
      (PAST_PREPARED.has(s.state) ||
        (s.state === "FAILED" &&
          s.failed_state !== null &&
          PAST_PREPARED.has(s.failed_state))),
  );
  return {
    mode,
    row,
    env,
    template,
    appHasSharedTerm,
    gateActive: gate.enabled && gate.url !== null,
    chainLive: head !== undefined,
    holder: head?.address ?? null,
    kind,
    plan: plan
      ? {
          id: plan.id,
          access: plan.access as "own" | "shared",
          status: plan.status,
          targetVersion: plan.target_version,
        }
      : null,
    release: rel
      ? {
          version: rel.version,
          digest: rel.image_digest || null,
          stable: feedsLicensedHost(rel),
        }
      : null,
    openSwitchoverOnApp: others.length > 0,
    frozen: (await frozenReasonOf(licensingDb, r.app_id)) !== null,
    switches,
  };
}
