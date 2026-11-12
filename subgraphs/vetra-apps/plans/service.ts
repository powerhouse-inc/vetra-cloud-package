import type { Caller } from "../auth.js";
import { appsError, notConfigured } from "../errors.js";
import { auditCaller } from "../audit/service.js";
import { releaseByVersion } from "../releases/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { plansConfigOf } from "../config.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import { releaseProblem } from "../rollouts/check.js";
import { parsePolicy, policyText } from "../rollouts/policy.js";
import {
  checkWindow,
  parseWindow,
  type UpdateWindow,
} from "../rollouts/window.js";
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
  parseSize,
  slugFromKind,
} from "./rules.js";

export interface PlanJson {
  id: string;
  appId: string;
  slug: string;
  name: string;
  kind: string;
  access: string;
  size: string;
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
}

/** A stored window that does not parse reads as none (never throws on a read). */
function storedWindow(json: string | null | undefined): UpdateWindow | null {
  try {
    return parseWindow(json);
  } catch {
    return null;
  }
}

export const planJson = (p: PlanRow): PlanJson => ({
  id: p.id,
  appId: p.app_id,
  slug: p.slug,
  name: p.name,
  kind: p.kind,
  access: p.access,
  size: p.size,
  targetVersion: p.target_version,
  policy: p.policy,
  noticeHours: p.notice_hours,
  updateWindow: storedWindow(p.update_window),
  policyNote: p.policy_note ?? null,
  status: p.status,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export interface CreatePlanInput {
  appId: string;
  kind: string;
  access: string;
  slug?: string | null;
  name?: string | null;
  size?: string | null;
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
  /** manual | patches | minor | follow:<branch> (a release branch of the App). */
  policy?: string | null;
  /** Hours between a rollout's start and the plan's updates (0-720). */
  noticeHours?: number | null;
  /** When the plan's instances may be updated (spec 14.8). */
  updateWindow?: UpdateWindow | null;
  /** Removes the window: updates any time after the notice. */
  clearUpdateWindow?: boolean | null;
}

/** A plan's target is a recorded, unwithdrawn release of its App (spec section 2, 14.3). */
async function checkTarget(
  deps: AppsDeps,
  appId: string,
  version: string,
): Promise<string> {
  const r = await releaseByVersion(deps.db, appId, version);
  const problem = releaseProblem(version, r);
  if (problem)
    throw appsError(
      "BAD_USER_INPUT",
      problem.charAt(0).toUpperCase() + problem.slice(1),
    );
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
  return (await listPlans(deps.db, app.id)).map(planJson);
}

export async function createPlan(
  deps: AppsDeps,
  caller: Caller,
  input: CreatePlanInput,
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
  const given = input.slug?.trim();
  const slug = given || slugFromKind(kind);
  checkPlanSlug(slug, app, given ? {} : { derivedFrom: kind });
  if (await hasLicensedEnvironments(deps.licensingDb, app.id))
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
  const issued = await grantKinds(deps.licensingDb, app.id);
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
    ? await checkTarget(deps, app.id, input.targetVersion)
    : null;
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
          targetVersion: p.target_version,
        },
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
  return planJson(row);
}

export async function updatePlanFor(
  deps: AppsDeps,
  caller: Caller,
  input: UpdatePlanInput,
): Promise<PlanJson> {
  const { plan, app } = await loadPlan(deps, caller, input.planId);
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
    ...(policy !== undefined ? { policy } : {}),
    ...(input.noticeHours != null
      ? { notice_hours: checkNoticeHours(input.noticeHours) }
      : {}),
    ...(window !== undefined ? { update_window: window } : {}),
  };
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      // Re-read under lock: a concurrent change is audited once, from what is stored.
      const cur = await lockPlan(trx, plan.id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const note = (key: string, from: unknown, to: unknown) => {
        if (to !== undefined && to !== from) changes[key] = { from, to };
      };
      note("name", cur.name, patch.name);
      note("size", cur.size, patch.size);
      note("policy", cur.policy, patch.policy);
      note("noticeHours", cur.notice_hours, patch.notice_hours);
      // The window audits its stored JSON text, from and to.
      note("updateWindow", cur.update_window ?? null, patch.update_window);
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
    }),
  );
}

/**
 * Moves the plan's instances to `version` on the next reconciler pass, without
 * notice. The stand-in for rollouts (releases phase 3 slice 3), which replace it.
 */
export async function setPlanTarget(
  deps: AppsDeps,
  caller: Caller,
  planId: string,
  version: string,
): Promise<PlanJson> {
  const { plan } = await loadPlan(deps, caller, planId);
  if (plan.status === "retired")
    throw appsError("BAD_USER_INPUT", "The plan is retired");
  const target = await checkTarget(deps, plan.app_id, version);
  const nowIso = deps.now().toISOString();
  return planJson(
    await deps.db.transaction().execute(async (trx) => {
      const cur = await lockPlan(trx, plan.id);
      if (cur.status === "retired")
        throw appsError("BAD_USER_INPUT", "The plan is retired");
      if (cur.target_version === target) return cur;
      const p = await updatePlan(
        trx,
        plan.id,
        { target_version: target },
        nowIso,
      );
      await auditCaller(trx, caller, {
        appId: plan.app_id,
        at: nowIso,
        action: "plan.target_set",
        subject: `plan:${plan.id}`,
        detail: { slug: plan.slug, from: cur.target_version, to: target },
      });
      return p;
    }),
  );
}

/** No new licences should be issued for it (retire the term too); existing holders keep their instances. */
export async function retirePlan(
  deps: AppsDeps,
  caller: Caller,
  planId: string,
): Promise<PlanJson> {
  const { plan } = await loadPlan(deps, caller, planId);
  if (plan.status === "retired") return planJson(plan);
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
  );
}
