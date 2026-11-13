import { teamSoakMs } from "../config.js";
import { listInstances } from "../instances/repo.js";
import type { PlanRow } from "../plans/repo.js";
import { activeTeamPlan, isOrgApp } from "../plans/team-base.js";
import { teamRunOf } from "../plans/team-runs.js";
import { PLAN_SIZES } from "../plans/rules.js";
import type { ReleaseRow } from "../releases/repo.js";
import { parseVersion, versionKind } from "../releases/version.js";
import type { AppRow } from "../repo.js";
import type { AppsDeps } from "../service.js";

/**
 * Slice 5 (D9): the first Powerhouse release with the licence gate. Shared
 * plans refuse releases built on an older one. Null until that release exists.
 */
export const LICENCE_GATE_MIN_POWERHOUSE: string | null = null;

export interface ReleaseRequires {
  powerhouse?: string;
  services?: string[];
  size?: string;
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** The release's requires; null when it is not JSON of that shape (never read as none). */
export function requiresOf(
  r: Pick<ReleaseRow, "requires">,
): ReleaseRequires | null {
  let v: unknown;
  try {
    v = JSON.parse(r.requires);
  } catch {
    return null;
  }
  if (v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.services !== undefined && !strings(o.services)) return null;
  if (o.size !== undefined && typeof o.size !== "string") return null;
  if (o.powerhouse !== undefined && typeof o.powerhouse !== "string")
    return null;
  return o as ReleaseRequires;
}

/** Why `version` cannot be a plan's target (spec section 2, 14.3), or null. */
export function releaseProblem(
  version: string,
  r: ReleaseRow | null,
): string | null {
  if (!r) return `the App has no release ${version}`;
  if (r.kind !== "release")
    return `${version} is a build; plans run releases only`;
  if (r.withdrawn_at) return `${version} was withdrawn`;
  return null;
}

const sizeRank = (s: string): number =>
  PLAN_SIZES.findIndex(
    (p) =>
      p ===
      `VETRA_AGENT_${s
        .trim()
        .toUpperCase()
        .replace(/^VETRA_AGENT_/, "")}`,
  );

const core = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** major.minor.patch order only: Powerhouse dev builds (6.3.0-dev.152) count as their core. */
export function powerhouseAtLeast(v: string, min: string): boolean {
  const a = core(v);
  const b = core(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Why the release cannot run on the plan's instances (decision R14), or null. */
export function planFitProblem(
  r: ReleaseRow,
  plan: Pick<PlanRow, "slug" | "size" | "access">,
  gateMin: string | null = LICENCE_GATE_MIN_POWERHOUSE,
): string | null {
  const req = requiresOf(r);
  // Fail closed: what a release needs is never guessed.
  if (!req) return `${r.version}'s requires cannot be read`;
  const services = req.services ?? [];
  if (services.length > 0)
    return `${r.version} needs ${services.join(", ")}; plan instances run the App's host only`;
  if (req.size) {
    const need = sizeRank(req.size);
    if (need === -1)
      return `${r.version} needs size ${req.size}, which Vetra does not know`;
    if (need > sizeRank(plan.size))
      return `${r.version} needs size ${req.size}; ${plan.slug} runs ${plan.size}`;
  }
  if (
    plan.access === "shared" &&
    gateMin &&
    !powerhouseAtLeast(r.powerhouse_version, gateMin)
  )
    return `${r.version} is built on Powerhouse ${r.powerhouse_version}; shared plans need ${gateMin} or newer (the licence gate)`;
  return null;
}

/** A stable patch on the same major.minor, above `from` (decision T5 of slice 6). */
export function isPatchOf(version: string, from: string | null): boolean {
  if (
    !from ||
    versionKind(version) !== "release" ||
    versionKind(from) !== "release"
  )
    return false;
  const v = parseVersion(version)!;
  const f = parseVersion(from)!;
  return (
    v.prerelease.length === 0 &&
    v.major === f.major &&
    v.minor === f.minor &&
    v.patch > f.patch
  );
}

/**
 * Spec 7 step 1: when the App has a Team plan, a customer rollout needs the
 * release to have run healthy on the Team instance (the Team plan itself is
 * exempt; stable patches of a plan's line too, decision T5).
 */
export async function teamGateProblem(
  deps: AppsDeps,
  app: Pick<AppRow, "id" | "owner_org_id" | "org_disputed">,
  version: string,
  plans: Pick<PlanRow, "slug" | "team" | "target_version">[],
): Promise<string | null> {
  const customers = plans.filter((p) => p.team !== true);
  if (customers.length === 0) return null;
  // Team is for organisation Apps; a personal (or disputed) App has no gate.
  if (!isOrgApp(app)) return null;
  const appId = app.id;
  const team = await activeTeamPlan(deps.db, appId);
  if (!team) return null;
  if (customers.length < plans.length)
    return `roll ${version} out to Team on its own first; customer plans follow once it ran healthy there`;
  const gated = customers.filter((p) => !isPatchOf(version, p.target_version));
  if (gated.length === 0) return null;
  if (await teamRunOf(deps.db, appId, version)) return null;
  const row = (await listInstances(deps.db, appId, "shared")).find(
    (r) => r.plan_id === team.id,
  );
  const soak = teamSoakMs(deps.cfg) / 60_000;
  const stopped = row?.stop_reason
    ? `; Team's instance is stopped (${row.stop_reason}), so it cannot run ${version}`
    : "";
  return `${version} has not run healthy on Team yet (${gated.map((p) => p.slug).join(", ")}); Team runs ${row?.running_version ?? "nothing"} and needs ${soak} minutes healthy on ${version}${stopped}`;
}
