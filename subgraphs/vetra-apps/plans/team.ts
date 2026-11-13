import type { Kysely } from "kysely";
import { GraphQLError } from "graphql";
import type { VetraAppsDB } from "../db/schema.js";
import { withKeyLock } from "../../../shared/key-lock.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import { plansConfigOf, teamSoakMs } from "../config.js";
import { appsError } from "../errors.js";
import { isReleaseBranch, parseReleaseBranches } from "../releases/branches.js";
import type { AppRow } from "../repo.js";
import {
  listInstances,
  updateInstance,
  type InstanceRow,
} from "../instances/repo.js";
import { listReleases } from "../releases/repo.js";
import { appInstancesLock } from "../rollouts/repo.js";
import { beginRollout } from "../rollouts/service.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { insertPlan, updatePlan, type PlanRow } from "./repo.js";
import { planJson, type PlanJson } from "./service.js";
import { activeTeamPlan, isOrgApp, teamPlanOf } from "./team-base.js";
import { qualifiesAsRun, recordTeamRun } from "./team-runs.js";

/** The Team plan (spec section 5): slug and name; `team` is reserved for it (checkPlanSlug). */
export const TEAM_SLUG = "team";
export const TEAM_NAME = "Team";
export const TEAM_ADMINS_REFRESH_MS = 15 * 60_000;
export const TEAM_ADMINS_MAX = 50;

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
  // The Team plan's first target is the newest release on its branch.
  if (!(await newestOnBranch(deps, app.id, branch)))
    throw appsError(
      "BAD_USER_INPUT",
      `${branch} has no release yet; the Team plan follows a branch's releases, so cut one first`,
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

const SYSTEM = { actor: AUDIT_SYSTEM_ACTOR, source: "policy" as const };

/**
 * Per reconciler pass, under the App's lock (reconcileApp): the active Team
 * plan's first target, its instance's ADMINS, and its ran-healthy records.
 */
export async function syncTeamPlan(deps: AppsDeps, app: AppRow): Promise<void> {
  const plan = await activeTeamPlan(deps.db, app.id);
  if (!plan) return;
  await firstTarget(deps, app, plan);
  const row = (await listInstances(deps.db, app.id, "shared")).find(
    (r) => r.plan_id === plan.id && !r.removed_at,
  );
  if (!row) return;
  if (isOrgApp(app)) await refreshAdmins(deps, app, row);
  else await clearAdmins(deps, app, row);
  const now = deps.now();
  const soakMs = teamSoakMs(deps.cfg);
  if (qualifiesAsRun(row, soakMs, now))
    await recordTeamRun(deps.db, row, soakMs / 60_000, now.toISOString());
}

async function newestOnBranch(deps: AppsDeps, appId: string, branch: string) {
  return (
    (await listReleases(deps.db, appId, { kind: "release", limit: 200 })).find(
      (r) => r.branch === branch && !r.withdrawn_at,
    ) ?? null
  );
}

async function firstTarget(
  deps: AppsDeps,
  app: AppRow,
  plan: PlanRow,
): Promise<void> {
  if (plan.target_version) return;
  const branch = branchOf(plan);
  if (!branch) return;
  const newest = await newestOnBranch(deps, app.id, branch);
  if (!newest) return;
  try {
    await beginRollout(deps, app, newest.version, [plan], SYSTEM, 0);
  } catch (err) {
    if (!(err instanceof GraphQLError)) throw err;
    const note = `${newest.version}: ${err.message}`.slice(0, 500);
    if (plan.policy_note === note) return;
    deps.logger.warn(`[vetra-apps] Team plan of ${app.slug}: ${note}`);
    await updatePlan(
      deps.db,
      plan.id,
      { policy_note: note },
      deps.now().toISOString(),
    );
  }
}

async function refreshAdmins(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
): Promise<void> {
  const read = deps.orgs?.orgAdmins;
  if (!read || !app.owner_org_id) return;
  const checked = Date.parse(row.admins_checked_at ?? "");
  // An override read for another organisation is refreshed at once.
  if (
    row.admins_override_org === app.owner_org_id &&
    Number.isFinite(checked) &&
    deps.now().getTime() - checked < TEAM_ADMINS_REFRESH_MS
  )
    return;
  let list: string[] | null;
  try {
    list = await read.call(deps.orgs, app.owner_org_id);
  } catch {
    return; // Renown down: the last list is trusted for an hour (validTeamAdmins).
  }
  const nowIso = deps.now().toISOString();
  if (list && list.length > TEAM_ADMINS_MAX)
    deps.logger.warn(
      `[vetra-apps] Team plan of ${app.slug}: ${list.length} org admins, only the first ${TEAM_ADMINS_MAX} are set`,
    );
  const override =
    list && list.length > 0 ? list.slice(0, TEAM_ADMINS_MAX).join(",") : null;
  const org = override ? app.owner_org_id : null;
  if (
    (row.admins_override ?? null) === override &&
    (row.admins_override_org ?? null) === org
  ) {
    await updateInstance(
      deps.db,
      row.id,
      { admins_checked_at: nowIso },
      nowIso,
    );
    return;
  }
  await setOverride(deps, app, row, override, org, nowIso);
}

/** The App is no organisation's: whatever the override says is no longer true. */
async function clearAdmins(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
): Promise<void> {
  if (!row.admins_override && !row.admins_override_org) return;
  await setOverride(deps, app, row, null, null, deps.now().toISOString());
}

async function setOverride(
  deps: AppsDeps,
  app: AppRow,
  row: InstanceRow,
  override: string | null,
  org: string | null,
  nowIso: string,
): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    await updateInstance(
      trx,
      row.id,
      {
        admins_override: override,
        admins_override_org: org,
        admins_checked_at: nowIso,
      },
      nowIso,
    );
    await recordAudit(trx, {
      appId: app.id,
      at: nowIso,
      actor: AUDIT_SYSTEM_ACTOR,
      source: "system",
      action: "instance.admins_set",
      subject: `instance:${row.id}`,
      detail: {
        count: override ? override.split(",").length : 0,
        fallback: override === null,
      },
    });
  });
}
