import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { appsError, notConfigured } from "../errors.js";
import { auditCaller } from "../audit/service.js";
import { feedsLicensedHost } from "../releases/licensed-host.js";
import { releaseByVersion } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  planPoolSize,
  plansConfigOf,
  rolloutsEnabled,
  type VetraAppsConfig,
} from "../config.js";
import { estimateEnvironmentEurPerMonth } from "../../vetra-licensing/warm-cost.js";
import { MAX_WARM_POOL_SIZE } from "./pool.js";
import { warmReadyCounts } from "./pool-repo.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import { releaseProblem, teamGateProblem } from "../rollouts/check.js";
import { appInstancesLock } from "../rollouts/repo.js";
import {
  beginRollout,
  callerActor,
  plannedSteps,
} from "../rollouts/service.js";
import { parsePolicy, policyText } from "../rollouts/policy.js";
import {
  checkWindow,
  parseWindow,
  type UpdateWindow,
} from "../rollouts/window.js";
import type { PlanAccess } from "../db/schema.js";
import { gateFloorError } from "../gate/service.js";
import { grantKinds, hasLicensedEnvironments } from "./holders.js";
import {
  getPlan,
  insertPlan,
  lockPlan,
  listPlans,
  updatePlan,
  type PlanRow,
} from "./repo.js";
import {
  checkNoticeHours,
  checkPlanSlug,
  parseAccess,
  parseAiBudget,
  parseSize,
  slugFromKind,
} from "./rules.js";
import { isTeamPlan } from "./team-base.js";

export interface PlanJson {
  id: string;
  appId: string;
  slug: string;
  name: string;
  /** The licensing term adopted; null for the Team plan. */
  kind: string | null;
  /** The App's Team plan (organisation members; follows a branch). */
  team: boolean;
  access: string;
  size: string;
  aiBudgetUsd: number | null;
  targetVersion: string | null;
  policy: string;
  noticeHours: number;
  /** When the plan's instances may be updated; null: any time after the notice. */
  updateWindow: UpdateWindow | null;
  /** "<version>: <reason>" of the policy's last refused rollout. */
  policyNote: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Warm instances kept ready for new holders (own plans); capped by Vetra. */
  warmPoolSize: number;
  /** What is kept: warmPoolSize capped by the environment's VETRA_APPS_PLAN_POOL_MAX. */
  warmPoolEffective: number;
  /** Monthly cost of the warm instances, in euros (estimate). */
  warmPoolEurPerMonth: number;
  /** Warm instances ready to be claimed now. */
  warmReady: number;
}

export const planJson = (
  p: PlanRow,
  cfg?: VetraAppsConfig,
  warmReady = 0,
): PlanJson => {
  const effective = cfg ? planPoolSize(cfg, p) : 0;
  return {
    id: p.id,
    appId: p.app_id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    team: p.team === true,
    access: p.access,
    size: p.size,
    aiBudgetUsd: p.ai_budget_usd ?? null,
    targetVersion: p.target_version,
    policy: p.policy,
    noticeHours: p.notice_hours,
    // A stored window that does not parse reads as one that is never open.
    updateWindow: parseWindow(p.update_window),
    policyNote: p.policy_note ?? null,
    status: p.status,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    warmPoolSize: p.warm_pool_size ?? 0,
    warmPoolEffective: effective,
    warmPoolEurPerMonth: estimateEnvironmentEurPerMonth(p.size) * effective,
    warmReady,
  };
};

export interface CreatePlanInput {
  appId: string;
  kind: string;
  access: string;
  slug?: string | null;
  name?: string | null;
  size?: string | null;
  aiBudgetUsd?: number | null;
  targetVersion?: string | null;
}

/** The longest kind and name a plan takes. */
export const PLAN_TEXT_MAX = 64;

function checkText(what: string, v: string): string {
  if (v.length > PLAN_TEXT_MAX)
    throw appsError(
      "BAD_USER_INPUT",
      `A plan's ${what} is at most ${PLAN_TEXT_MAX} characters`,
    );
  return v;
}

const isUniqueViolation = (err: unknown) =>
  (err as { code?: unknown } | null)?.code === "23505";

export interface UpdatePlanInput {
  planId: string;
  name?: string | null;
  size?: string | null;
  /** null clears; absent leaves it */
  aiBudgetUsd?: number | null;
  /** manual | patches | minor | follow:<branch> (a release branch of the App). */
  policy?: string | null;
  /** Hours between a rollout's start and the plan's updates (0-720). */
  noticeHours?: number | null;
  /** When the plan's instances may be updated (spec 14.8). */
  updateWindow?: UpdateWindow | null;
  /** Removes the window: updates any time after the notice. */
  clearUpdateWindow?: boolean | null;
  /** Warm instances kept for new holders (own plans only; 0 to MAX_WARM_POOL_SIZE). */
  warmPoolSize?: number | null;
}

function checkPoolSize(plan: { access: string }, n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > MAX_WARM_POOL_SIZE)
    throw appsError(
      "BAD_USER_INPUT",
      `The warm pool is 0 to ${MAX_WARM_POOL_SIZE} instances`,
    );
  if (plan.access !== "own")
    throw appsError("BAD_USER_INPUT", "Only own plans keep warm instances");
  return n;
}

/**
 * A plan's target is a recorded, unwithdrawn release of its App (spec section 2,
 * 14.3); a shared plan's is built on a Powerhouse with the licence gate while
 * the gate is on (D9).
 */
async function checkTarget(
  deps: AppsDeps,
  appId: string,
  version: string,
  access: PlanAccess,
): Promise<string> {
  const r = await releaseByVersion(deps.db, appId, version);
  const problem = releaseProblem(version, r);
  if (problem)
    throw appsError(
      "BAD_USER_INPUT",
      problem.charAt(0).toUpperCase() + problem.slice(1),
    );
  if (access === "shared") {
    const floor = gateFloorError(deps.cfg, r!);
    if (floor) throw appsError("BAD_USER_INPUT", floor);
  }
  return r!.version;
}

async function loadPlan(deps: AppsDeps, caller: Caller, planId: string) {
  const plan = await getPlan(deps.db, planId);
  if (!plan) throw appsError("NOT_FOUND", "Plan not found");
  // Throws NOT_FOUND / FORBIDDEN as for the App itself; operators and
  // release managers (spec section 10).
  const app = await loadAppForOwner(deps, caller, plan.app_id, {
    need: "release",
  });
  return { plan, app };
}

export async function appPlansFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<PlanJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const ready = await warmReadyCounts(deps.db, app.id);
  return (await listPlans(deps.db, app.id)).map((p) =>
    planJson(p, deps.cfg, ready.get(p.id) ?? 0),
  );
}

export async function createPlan(
  deps: AppsDeps,
  caller: Caller,
  input: CreatePlanInput,
): Promise<PlanJson> {
  return createPlanRow(deps, caller, input, null);
}

export interface AdoptLicensedKindInput {
  appId: string;
  kind: string;
  slug?: string | null;
  name?: string | null;
  size?: string | null;
  /** A stable release of the App (the switch-over's target). */
  targetVersion: string;
}

/** The mode of the template the App document's term of `kind` points at; null when it does not resolve. */
async function termModeOf(
  deps: AppsDeps,
  appId: string,
  kind: string,
): Promise<"DEDICATED" | "SHARED" | null> {
  const state = (await deps.docs?.getState(appId)) as {
    terms?: Array<{ kind?: unknown; templateId?: unknown }>;
    templates?: Array<{ id?: unknown; mode?: unknown }>;
  } | null;
  const term = state?.terms?.find((t) => t.kind === kind);
  const mode = state?.templates?.find((t) => t.id === term?.templateId)?.mode;
  return mode === "DEDICATED" || mode === "SHARED" ? mode : null;
}

/**
 * Adopts a licensing term that already has licences and licensed
 * environments as an own plan (plan 9, the switch-over's first step). Unlike
 * createPlan it accepts an App with licensed environments and a kind with
 * holders: licensing leaves such a chain's licensed environment alone until
 * its switch-over moves it (overview rule 1), and gives every chain without
 * one an own instance at once. Platform admins only; DEDICATED terms only;
 * the target is a stable release of the App.
 */
export async function adoptLicensedKind(
  deps: AppsDeps,
  caller: Caller,
  input: AdoptLicensedKindInput,
): Promise<PlanJson> {
  if (!caller.isAdmin)
    throw appsError("FORBIDDEN", "Only platform admins adopt a licensed kind");
  const kind = input.kind.trim();
  if ((await termModeOf(deps, input.appId, kind)) !== "DEDICATED")
    throw appsError(
      "BAD_USER_INPUT",
      `The term ${kind} is not a DEDICATED term of the App: only dedicated licensed environments switch over to own instances`,
    );
  const release = await releaseByVersion(
    deps.db,
    input.appId,
    input.targetVersion,
  );
  if (!release || !feedsLicensedHost(release))
    throw appsError(
      "BAD_USER_INPUT",
      `${input.targetVersion} is not a stable release of the App`,
    );
  return createPlanRow(
    deps,
    caller,
    {
      appId: input.appId,
      kind,
      access: "own",
      slug: input.slug,
      name: input.name,
      size: input.size,
      targetVersion: input.targetVersion,
    },
    { adopt: true },
  );
}

async function createPlanRow(
  deps: AppsDeps,
  caller: Caller,
  input: CreatePlanInput,
  adopt: { adopt: true } | null,
): Promise<PlanJson> {
  if (!plansConfigOf(deps.cfg).enabled)
    throw appsError("BAD_USER_INPUT", "Plans are not enabled on this Vetra");
  const app = await loadAppForOwner(deps, caller, input.appId, {
    need: "release",
  });
  if (!deps.licensingDb) throw notConfigured("The licensing tables");
  const kind = checkText("kind", input.kind.trim());
  if (!kind)
    throw appsError(
      "BAD_USER_INPUT",
      "A plan adopts a licensing term: give its kind",
    );
  const name = checkText("name", input.name?.trim() || kind);
  const access = parseAccess(input.access);
  const size = parseSize(input.size);
  const aiBudget =
    input.aiBudgetUsd == null ? null : parseAiBudget(input.aiBudgetUsd);
  const given = input.slug?.trim();
  const slug = given || slugFromKind(kind);
  checkPlanSlug(slug, app, given ? {} : { derivedFrom: kind });
  if (!adopt && (await hasLicensedEnvironments(deps.licensingDb, app.id)))
    throw appsError(
      "BAD_USER_INPUT",
      "This App's licensed environments move to plans with the switch-over (releases phase 3, slice 9); it cannot have plans before that",
    );
  const existing = await listPlans(deps.db, app.id);
  const sameKind = existing.find((p) => p.kind === kind);
  // (app_id, kind) is unique for good: a retired plan keeps its kind.
  if (sameKind)
    throw appsError(
      "BAD_USER_INPUT",
      sameKind.status === "retired"
        ? `The term ${kind} was the retired plan ${sameKind.slug}; a term becomes a plan once, so use a new term`
        : `The term ${kind} is already a plan`,
    );
  if (existing.some((p) => p.slug === slug))
    throw appsError(
      "BAD_USER_INPUT",
      `The App already has a plan called ${slug}`,
    );
  // A plan's term must never have been issued: a kind with licences (live or
  // not) is a migration, not a new plan (slice 9). Licences of unknown kind
  // could be of any term.
  const issued = adopt ? [] : await grantKinds(deps.licensingDb, app.id);
  if (issued.includes(null) || issued.includes(kind))
    throw appsError(
      "BAD_USER_INPUT",
      `The term ${kind} already has holders (or the App has licences of unknown kind); it becomes a plan with the switch-over`,
    );
  const lower = kind.toLowerCase();
  const alike = issued.find((k) => k?.toLowerCase() === lower);
  if (alike)
    throw appsError(
      "BAD_USER_INPUT",
      `The term ${kind} differs only in case from ${alike}, which the App's licences use; kinds are case-sensitive, so pick a distinct term`,
    );
  const nowIso = deps.now().toISOString();
  const target = input.targetVersion
    ? await checkTarget(deps, app.id, input.targetVersion, access)
    : null;
  // A customer plan's first target is a rollout too: Team goes first (spec 7).
  if (target) {
    const team = await teamGateProblem(deps, app, target, [
      { slug, team: false, target_version: null },
    ]);
    if (team) throw appsError("BAD_USER_INPUT", team);
  }
  const row = await deps.db
    .transaction()
    .execute(async (trx) => {
      const p = await insertPlan(trx, {
        id: deps.newId(),
        app_id: app.id,
        slug,
        name,
        kind,
        access,
        size,
        ai_budget_usd: aiBudget,
        target_version: target,
        policy: "manual",
        notice_hours: 72,
        status: "active",
        created_by: caller.address,
        created_at: nowIso,
        updated_at: nowIso,
      });
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "plan.created",
        subject: `plan:${p.id}`,
        detail: {
          slug: p.slug,
          name: p.name,
          kind: p.kind,
          access: p.access,
          size: p.size,
          ...(p.ai_budget_usd ? { aiBudgetUsd: p.ai_budget_usd } : {}),
          targetVersion: p.target_version,
        },
      });
      if (adopt)
        await auditCaller(trx, caller, {
          appId: app.id,
          at: nowIso,
          action: "switchover.kind_adopted",
          subject: `plan:${p.id}`,
          detail: { kind: p.kind, slug: p.slug, targetVersion: p.target_version },
        });
      return p;
    })
    .catch((err: unknown) => {
      // A concurrent createPlan took the slug or kind after the checks above.
      if (isUniqueViolation(err))
        throw appsError(
          "BAD_USER_INPUT",
          `The App already has a plan called ${slug} or for the term ${kind}`,
        );
      throw err;
    });
  return planJson(row, deps.cfg);
}

export async function updatePlanFor(
  deps: AppsDeps,
  caller: Caller,
  input: UpdatePlanInput,
): Promise<PlanJson> {
  const { plan, app } = await loadPlan(deps, caller, input.planId);
  if (isTeamPlan(plan) && input.policy != null)
    throw appsError(
      "BAD_USER_INPUT",
      "The Team plan follows its branch; change it with enableTeamPlan",
    );
  const name = input.name == null ? undefined : input.name.trim();
  if (name === "")
    throw appsError("BAD_USER_INPUT", "A plan's name cannot be blank");
  if (name !== undefined) checkText("name", name);
  const policy =
    input.policy == null ? undefined : policyText(parsePolicy(input.policy));
  if (policy?.startsWith("follow:")) {
    const branch = policy.slice("follow:".length);
    if (
      !isReleaseBranch(
        branch,
        app.production_branch,
        parseReleaseBranches(app.release_branches),
      )
    )
      throw appsError(
        "BAD_USER_INPUT",
        `${branch} is not a release branch of the App`,
      );
  }
  if (input.updateWindow && input.clearUpdateWindow)
    throw appsError(
      "BAD_USER_INPUT",
      "Give an update window or clear it, not both",
    );
  const window = input.clearUpdateWindow
    ? null
    : input.updateWindow
      ? JSON.stringify(checkWindow(input.updateWindow))
      : undefined;
  const patch = {
    ...(name ? { name } : {}),
    ...(input.size ? { size: parseSize(input.size) } : {}),
    ...(input.aiBudgetUsd === undefined
      ? {}
      : {
          ai_budget_usd:
            input.aiBudgetUsd === null ? null : parseAiBudget(input.aiBudgetUsd),
        }),
    ...(policy !== undefined ? { policy } : {}),
    ...(input.noticeHours != null
      ? { notice_hours: checkNoticeHours(input.noticeHours) }
      : {}),
    ...(window !== undefined ? { update_window: window } : {}),
    ...(input.warmPoolSize != null
      ? { warm_pool_size: checkPoolSize(plan, input.warmPoolSize) }
      : {}),
  };
  const nowIso = deps.now().toISOString();
  const updated = await deps.db.transaction().execute(async (trx) => {
    // Re-read under lock: a concurrent change is audited once, from what is stored.
    const cur = await lockPlan(trx, plan.id);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const note = (key: string, from: unknown, to: unknown) => {
      if (to !== undefined && to !== from) changes[key] = { from, to };
    };
    note("name", cur.name, patch.name);
    note("size", cur.size, patch.size);
    note("aiBudgetUsd", cur.ai_budget_usd ?? null, patch.ai_budget_usd);
    note("policy", cur.policy, patch.policy);
    note("noticeHours", cur.notice_hours, patch.notice_hours);
    // The window audits its stored JSON text, from and to.
    note("updateWindow", cur.update_window ?? null, patch.update_window);
    note("warmPoolSize", cur.warm_pool_size ?? 0, patch.warm_pool_size);
    const p = await updatePlan(
      trx,
      plan.id,
      // A new policy starts over: its last refusal no longer applies.
      changes.policy ? { ...patch, policy_note: null } : patch,
      nowIso,
    );
    if (Object.keys(changes).length > 0)
      await auditCaller(trx, caller, {
        appId: plan.app_id,
        at: nowIso,
        action: "plan.updated",
        subject: `plan:${plan.id}`,
        detail: { slug: plan.slug, changes },
      });
    return p;
  });
  const ready = await warmReadyCounts(deps.db, plan.app_id);
  return planJson(updated, deps.cfg, ready.get(plan.id) ?? 0);
}

/**
 * Starts a rollout of this one plan to `version` (spec section 7), with the
 * plan's notice. A no-op when the plan already targets it and no instance is
 * behind. Its instances move one at a time through the rollout runner.
 */
export async function setPlanTarget(
  deps: AppsDeps,
  caller: Caller,
  planId: string,
  version: string,
): Promise<PlanJson> {
  const { plan, app } = await loadPlan(deps, caller, planId);
  // It starts a rollout: refused whenever startRollout is.
  if (!rolloutsEnabled(deps.cfg))
    throw appsError(
      "BAD_USER_INPUT",
      "Plans and rollouts are not enabled on this Vetra",
    );
  if (plan.status === "retired")
    throw appsError("BAD_USER_INPUT", "The plan is retired");
  const target = await checkTarget(deps, plan.app_id, version, plan.access);
  await withKeyLock(appInstancesLock(app.id), async () => {
    const cur = (await getPlan(deps.db, plan.id))!;
    if (cur.status === "retired")
      throw appsError("BAD_USER_INPUT", "The plan is retired");
    if (
      cur.target_version === target &&
      (await plannedSteps(deps, app.id, [cur], target)).every(
        (s) => s.status !== "pending",
      )
    )
      return;
    await beginRollout(deps, app, target, [cur], callerActor(caller), null);
  });
  return planJson((await getPlan(deps.db, plan.id))!, deps.cfg);
}

/** No new licences should be issued for it (retire the term too); existing holders keep their instances. */
export async function retirePlan(
  deps: AppsDeps,
  caller: Caller,
  planId: string,
): Promise<PlanJson> {
  const { plan } = await loadPlan(deps, caller, planId);
  if (isTeamPlan(plan))
    throw appsError(
      "BAD_USER_INPUT",
      "Disable the Team plan instead (owner and organisation admins)",
    );
  if (plan.status === "retired") return planJson(plan, deps.cfg);
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      const cur = await lockPlan(trx, plan.id);
      if (cur.status === "retired") return cur;
      const p = await updatePlan(trx, plan.id, { status: "retired" }, nowIso);
      await auditCaller(trx, caller, {
        appId: plan.app_id,
        at: nowIso,
        action: "plan.retired",
        subject: `plan:${plan.id}`,
        detail: { slug: plan.slug },
      });
      return p;
    }),
    deps.cfg,
  );
}
