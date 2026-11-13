import type { Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import { withKeyLock } from "../../../shared/key-lock.js";
import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import { plansConfigOf } from "../config.js";
import { appsError } from "../errors.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import type { AppRow } from "../repo.js";
import { appInstancesLock } from "../rollouts/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { insertPlan, updatePlan, type PlanRow } from "./repo.js";
import { planJson, type PlanJson } from "./service.js";

/** The Team plan (spec section 5): slug and name; `team` is reserved for it (checkPlanSlug). */
export const TEAM_SLUG = "team";
export const TEAM_NAME = "Team";
export const TEAM_NOT_ORG = "the App is not an organisation's";
export const TEAM_ADMINS_REFRESH_MS = 15 * 60_000;
export const TEAM_ADMINS_MAX = 50;

export const isTeamPlan = (p: Pick<PlanRow, "team">): boolean =>
  p.team === true;

/** Owned by an organisation whose claim Vetra trusts (not disputed). */
export const isOrgApp = (
  app: Pick<AppRow, "owner_org_id" | "org_disputed">,
): boolean => !!app.owner_org_id && app.org_disputed !== true;

export async function teamPlanOf(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow | null> {
  return (
    (await db
      .selectFrom("plans")
      .selectAll()
      .where("app_id", "=", appId)
      .where("team", "=", true)
      .executeTakeFirst()) ?? null
  );
}

export async function activeTeamPlan(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow | null> {
  const p = await teamPlanOf(db, appId);
  return p?.status === "active" ? p : null;
}

const isUniqueViolation = (err: unknown) =>
  (err as { code?: unknown } | null)?.code === "23505";
const branchOf = (p: PlanRow) =>
  p.policy.startsWith("follow:") ? p.policy.slice("follow:".length) : null;

async function lockTeamPlan(
  trx: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow | null> {
  return (
    (await trx
      .selectFrom("plans")
      .selectAll()
      .where("app_id", "=", appId)
      .where("team", "=", true)
      .forUpdate()
      .executeTakeFirst()) ?? null
  );
}

function requirePlans(deps: AppsDeps) {
  if (!plansConfigOf(deps.cfg).enabled)
    throw appsError("BAD_USER_INPUT", "Plans are not enabled on this Vetra");
}

/**
 * Turns on the App's Team plan (spec section 5; section 10: owner and org
 * admins). One per App; a disabled one is revived with its instance and data.
 * Its first target arrives with the next reconciler pass (syncTeamPlan).
 */
export async function enableTeamPlan(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  followBranch?: string | null,
): Promise<PlanJson> {
  requirePlans(deps);
  const app = await loadAppForOwner(deps, caller, appId, {
    need: "administer",
  });
  if (!isOrgApp(app))
    throw appsError("BAD_USER_INPUT", "The Team plan is for organisation Apps");
  const branch = followBranch?.trim() || app.production_branch;
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
  const policy = `follow:${branch}`;
  const run = () =>
    deps.db.transaction().execute(async (trx) => {
      const nowIso = deps.now().toISOString();
      const cur = await lockTeamPlan(trx, app.id);
      if (cur && cur.status === "active" && cur.policy === policy) return cur;
      const p = cur
        ? await updatePlan(trx, cur.id, { status: "active", policy }, nowIso)
        : await insertPlan(trx, {
            id: deps.newId(),
            app_id: app.id,
            slug: TEAM_SLUG,
            name: TEAM_NAME,
            kind: null,
            team: true,
            access: "shared",
            size: "VETRA_AGENT_S",
            target_version: null,
            policy,
            notice_hours: 0,
            status: "active",
            created_by: caller.address,
            created_at: nowIso,
            updated_at: nowIso,
          });
      const from = cur ? branchOf(cur) : null;
      await auditCaller(trx, caller, {
        appId: app.id,
        at: nowIso,
        action: "plan.team_enabled",
        subject: `plan:${p.id}`,
        detail: {
          branch,
          ...(from && from !== branch ? { from } : {}),
          ...(cur?.status === "retired" ? { revived: true } : {}),
        },
      });
      return p;
    });
  try {
    return planJson(await withKeyLock(appInstancesLock(app.id), run));
  } catch (err) {
    // A concurrent enable inserted it first (or took the slug team).
    if (!isUniqueViolation(err)) throw err;
    const p = await teamPlanOf(deps.db, app.id);
    if (!p) throw err;
    return planJson(p);
  }
}

/** Turns the Team plan off: its instance stops (data kept); customer rollouts are no longer gated on it (T8). */
export async function disableTeamPlan(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<PlanJson> {
  requirePlans(deps);
  const app = await loadAppForOwner(deps, caller, appId, {
    need: "administer",
  });
  return planJson(
    await withKeyLock(appInstancesLock(app.id), () =>
      deps.db.transaction().execute(async (trx) => {
        const cur = await lockTeamPlan(trx, app.id);
        if (!cur) throw appsError("NOT_FOUND", "The App has no Team plan");
        if (cur.status === "retired") return cur;
        const nowIso = deps.now().toISOString();
        const p = await updatePlan(trx, cur.id, { status: "retired" }, nowIso);
        await auditCaller(trx, caller, {
          appId: app.id,
          at: nowIso,
          action: "plan.team_disabled",
          subject: `plan:${p.id}`,
          detail: { branch: branchOf(cur) },
        });
        return p;
      }),
    ),
  );
}
