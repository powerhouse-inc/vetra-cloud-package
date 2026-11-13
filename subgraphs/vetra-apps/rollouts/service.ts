import type { Kysely } from "kysely";
import { withKeyLock } from "../../../shared/key-lock.js";
import type { Caller } from "../auth.js";
import { recordAudit, type AuditEntry } from "../audit/repo.js";
import { instanceHealth, rolloutsEnabled } from "../config.js";
import type { VetraAppsDB } from "../db/schema.js";
import { appsError } from "../errors.js";
import { listInstances, type InstanceRow } from "../instances/repo.js";
import { getPlan, lockPlan, updatePlan, type PlanRow } from "../plans/repo.js";
import { checkNoticeHours } from "../plans/rules.js";
import { releaseByVersion } from "../releases/repo.js";
import { compareReleases, versionKind } from "../releases/version.js";
import type { AppRow } from "../repo.js";
import type { AppNeed } from "../roles/access.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import { planFitProblem, releaseProblem, teamGateProblem } from "./check.js";
import {
  appInstancesLock,
  getRollout,
  insertRollout,
  insertRolloutPlans,
  insertSteps,
  listRollouts,
  openRolloutOfPlan,
  rolloutPlans,
  stepsOf,
  type RolloutRow,
  type RolloutStepRow,
} from "./repo.js";

const HOUR_MS = 3_600_000;

/** Who starts or changes a rollout, and from where. */
export interface RolloutActor {
  actor: string;
  source: "console" | "api" | "policy";
}
export const callerActor = (c: Caller): RolloutActor => ({
  actor: c.address,
  source: c.source ?? "api",
});

/** An audit row written as `who`. Pass the transaction of the change. */
export const auditAs = (
  db: Kysely<VetraAppsDB>,
  who: RolloutActor | { actor: string; source: "system" },
  e: Omit<AuditEntry, "actor" | "source">,
) => recordAudit(db, { ...e, actor: who.actor, source: who.source });

export interface RolloutStepJson {
  id: string;
  instanceId: string;
  instanceName: string;
  instanceKind: string;
  planId: string;
  position: number;
  fromVersion: string | null;
  toVersion: string;
  status: string;
  dueAt: string;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  error: string | null;
  note: string | null;
}

export interface RolloutJson {
  id: string;
  appId: string;
  version: string;
  status: string;
  direction: string;
  source: string;
  startedBy: string;
  startedAt: string;
  notes: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
  finishedAt: string | null;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  plans: { planId: string; fromVersion: string | null; noticeHours: number }[];
  steps: RolloutStepJson[];
}

export const stepJson = (s: RolloutStepRow): RolloutStepJson => ({
  id: s.id,
  instanceId: s.instance_id,
  instanceName: s.instance_name,
  instanceKind: s.instance_kind,
  planId: s.plan_id,
  position: s.position,
  fromVersion: s.from_version,
  toVersion: s.to_version,
  status: s.status,
  dueAt: s.due_at,
  requestedAt: s.requested_at,
  startedAt: s.started_at,
  finishedAt: s.finished_at,
  attempts: s.attempts,
  error: s.error,
  note: s.note,
});

export async function rolloutJson(
  db: Kysely<VetraAppsDB>,
  r: RolloutRow,
): Promise<RolloutJson> {
  const [plans, steps] = await Promise.all([
    rolloutPlans(db, r.id),
    stepsOf(db, r.id),
  ]);
  return {
    id: r.id,
    appId: r.app_id,
    version: r.version,
    status: r.status,
    direction: r.direction,
    source: r.source,
    startedBy: r.started_by,
    startedAt: r.started_at,
    notes: r.notes,
    pausedAt: r.paused_at,
    pausedReason: r.paused_reason,
    finishedAt: r.finished_at,
    rolledBackBy: r.rolled_back_by,
    rolledBackAt: r.rolled_back_at,
    plans: plans.map((p) => ({
      planId: p.plan_id,
      fromVersion: p.from_version,
      noticeHours: p.notice_hours,
    })),
    steps: steps.map(stepJson),
  };
}

export interface PlannedStep {
  plan: PlanRow;
  instance: InstanceRow;
  status: "pending" | "skipped";
  note: string | null;
}

/** Whether release `a` is newer than release `b`; false when either is not a release. */
export const newerRelease = (a: string | null, b: string | null): boolean =>
  !!a &&
  !!b &&
  versionKind(a) === "release" &&
  versionKind(b) === "release" &&
  compareReleases(a, b) > 0;

/**
 * The plans' live instances not already targeting `version`, in the order
 * they move: shared first, then own, each by plan order then age (spec 7
 * step 4). A pinned one is planned as skipped (spec section 7, pinning), and
 * so is one ahead of `version` (a newer release, e.g. pinned there and
 * unpinned): rollouts move forward only (decision R8).
 */
export async function plannedSteps(
  deps: AppsDeps,
  appId: string,
  plans: PlanRow[],
  version: string,
): Promise<PlannedStep[]> {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const rows = (await listInstances(deps.db, appId)).filter(
    (r) =>
      (r.kind === "shared" || r.kind === "own") &&
      !!r.plan_id &&
      byId.has(r.plan_id) &&
      !r.removed_at &&
      r.status !== "removed" &&
      r.target_version !== version,
  );
  const out: PlannedStep[] = rows.map((r) => {
    const note = r.pinned_version
      ? `pinned at ${r.pinned_version}`
      : newerRelease(r.target_version, version)
        ? `ahead at ${r.target_version}`
        : null;
    return {
      plan: byId.get(r.plan_id!)!,
      instance: r,
      status: note ? "skipped" : "pending",
      note,
    };
  });
  const rank = (s: PlannedStep) => (s.instance.kind === "shared" ? 0 : 1);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      plans.indexOf(a.plan) - plans.indexOf(b.plan) ||
      a.instance.created_at.localeCompare(b.instance.created_at) ||
      a.instance.id.localeCompare(b.instance.id),
  );
}

/** Every reason the rollout cannot start (spec 7 step 1); empty when it can. */
export async function rolloutProblems(
  deps: AppsDeps,
  app: AppRow,
  version: string,
  plans: PlanRow[],
  steps: PlannedStep[],
): Promise<string[]> {
  const release = await releaseByVersion(deps.db, app.id, version);
  const bad = releaseProblem(version, release);
  if (bad) return [bad];
  const out: string[] = [];
  for (const p of plans) {
    if (p.status === "retired") out.push(`${p.slug} is retired`);
    const fit = planFitProblem(release!, p);
    if (fit) out.push(fit);
    // Guarded: a target that is not a release (legacy data) is never compared.
    if (newerRelease(p.target_version, version))
      out.push(
        `${version} is older than ${p.slug}'s target ${p.target_version}; roll back that rollout instead`,
      );
    const open = await openRolloutOfPlan(deps.db, p.id);
    if (open)
      out.push(
        `${p.slug} is in the rollout of ${open.version} (${open.status}); finish, cancel or roll it back first`,
      );
  }
  const team = await teamGateProblem(deps, app.id, version);
  if (team) out.push(team);
  if (
    steps.some((s) => s.status === "pending") &&
    instanceHealth(deps.cfg).mode !== "enforce"
  )
    out.push(
      "rollouts need instance health in enforce mode (VETRA_APPS_INSTANCE_HEALTH=enforce)",
    );
  // Nothing would move (no step, or only pinned / ahead ones): already done.
  if (
    steps.every((s) => s.status !== "pending") &&
    plans.every((p) => p.target_version === version)
  )
    out.push(`${plans.map((p) => p.slug).join(", ")} already run ${version}`);
  return out;
}

/**
 * Starts a rollout. No access check: the caller checked it, and holds
 * appInstancesLock(app.id) (never taken again here). The plans' targets move
 * now (new instances start on the release, decision R3); instances move one
 * at a time through the runner.
 */
export async function beginRollout(
  deps: AppsDeps,
  app: AppRow,
  version: string,
  plans: PlanRow[],
  who: RolloutActor,
  noticeHours: number | null,
): Promise<RolloutRow> {
  const steps = await plannedSteps(deps, app.id, plans, version);
  const problems = await rolloutProblems(deps, app, version, plans, steps);
  if (problems.length > 0)
    throw appsError(
      "BAD_USER_INPUT",
      `Cannot roll out ${version}: ${problems.join("; ")}`,
    );
  const release = (await releaseByVersion(deps.db, app.id, version))!;
  const now = deps.now();
  const nowIso = now.toISOString();
  const id = deps.newId();
  const hours = new Map(
    plans.map((p) => [p.id, noticeHours ?? p.notice_hours]),
  );
  const moving = steps.some((s) => s.status === "pending");
  return deps.db.transaction().execute(async (trx) => {
    // Re-checked under the plans' row locks: retirePlan takes only that lock.
    const locked = new Map<string, PlanRow>();
    for (const p of plans) {
      const cur = await lockPlan(trx, p.id);
      if (cur.status === "retired")
        throw appsError(
          "BAD_USER_INPUT",
          `Cannot roll out ${version}: ${cur.slug} is retired`,
        );
      locked.set(p.id, cur);
    }
    const rollout = await insertRollout(trx, {
      id,
      app_id: app.id,
      version,
      status: moving ? "active" : "complete",
      direction: "forward",
      source: who.source,
      started_by: who.actor,
      started_at: nowIso,
      notes: release.customer_notes ?? release.notes,
      paused_at: null,
      paused_reason: null,
      finished_at: moving ? null : nowIso,
      rolled_back_by: null,
      rolled_back_at: null,
      updated_at: nowIso,
    });
    await insertRolloutPlans(
      trx,
      plans.map((p) => ({
        rollout_id: id,
        plan_id: p.id,
        from_version: p.target_version,
        notice_hours: hours.get(p.id)!,
      })),
    );
    await insertSteps(
      trx,
      steps.map((s, position) => ({
        id: deps.newId(),
        rollout_id: id,
        app_id: app.id,
        plan_id: s.plan.id,
        instance_id: s.instance.id,
        instance_kind: s.instance.kind as "shared" | "own",
        instance_name: s.instance.name,
        position,
        from_version: s.instance.target_version,
        to_version: version,
        status: s.status,
        due_at: new Date(
          now.getTime() + hours.get(s.plan.id)! * HOUR_MS,
        ).toISOString(),
        requested_at: null,
        started_at: null,
        finished_at: s.status === "skipped" ? nowIso : null,
        target_moved: false,
        attempts: 0,
        error: null,
        note: s.note,
        created_at: nowIso,
        updated_at: nowIso,
      })),
    );
    for (const p of plans) {
      const cur = locked.get(p.id)!;
      if (cur.target_version === version) continue;
      await updatePlan(trx, p.id, { target_version: version }, nowIso);
      await auditAs(trx, who, {
        appId: app.id,
        at: nowIso,
        action: "plan.target_set",
        subject: `plan:${p.id}`,
        detail: {
          slug: p.slug,
          from: cur.target_version,
          to: version,
          rolloutId: id,
        },
      });
    }
    await auditAs(trx, who, {
      appId: app.id,
      at: nowIso,
      action: "rollout.started",
      subject: `rollout:${id}`,
      detail: {
        version,
        plans: plans.map((p) => p.slug),
        steps: steps.filter((s) => s.status === "pending").length,
        skipped: steps.filter((s) => s.status === "skipped").length,
        noticeHours: plans.map((p) => hours.get(p.id)),
      },
    });
    return rollout;
  });
}

async function plansOf(
  deps: AppsDeps,
  app: AppRow,
  ids: string[],
): Promise<PlanRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0)
    throw appsError("BAD_USER_INPUT", "Name at least one plan");
  const out: PlanRow[] = [];
  for (const id of unique) {
    const p = await getPlan(deps.db, id);
    if (!p || p.app_id !== app.id)
      throw appsError("NOT_FOUND", `Plan ${id} not found`);
    out.push(p);
  }
  return out;
}

export interface StartRolloutInput {
  appId: string;
  version: string;
  planIds: string[];
  /** Hours before the plans' instances are updated; default each plan's notice. */
  noticeHours?: number | null;
}

export async function startRollout(
  deps: AppsDeps,
  caller: Caller,
  input: StartRolloutInput,
): Promise<RolloutJson> {
  if (!rolloutsEnabled(deps.cfg))
    throw appsError(
      "BAD_USER_INPUT",
      "Plans and rollouts are not enabled on this Vetra",
    );
  const app = await loadAppForOwner(deps, caller, input.appId, {
    need: "release",
  });
  const notice =
    input.noticeHours == null ? null : checkNoticeHours(input.noticeHours);
  const ids = (await plansOf(deps, app, input.planIds)).map((p) => p.id);
  return withKeyLock(appInstancesLock(app.id), async () => {
    // Read under the lock: another start may have moved them.
    const plans = await plansOf(deps, app, ids);
    const row = await beginRollout(
      deps,
      app,
      input.version.trim(),
      plans,
      callerActor(caller),
      notice,
    );
    return rolloutJson(deps.db, row);
  });
}

export interface StepPreviewJson {
  instanceId: string;
  instanceName: string;
  instanceKind: string;
  planId: string;
  fromVersion: string | null;
  status: string;
  note: string | null;
  dueAt: string;
}

export interface RolloutCheckJson {
  version: string;
  ok: boolean;
  problems: string[];
  steps: StepPreviewJson[];
}

/** What startRollout would do, without doing it (the console's "Roll out" dialog). */
export async function checkRolloutFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  version: string,
  planIds: string[],
  /** As startRollout's: hours before the steps are due; default each plan's notice. */
  noticeHours?: number | null,
): Promise<RolloutCheckJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const notice = noticeHours == null ? null : checkNoticeHours(noticeHours);
  const plans = await plansOf(deps, app, planIds);
  const v = version.trim();
  const steps = await plannedSteps(deps, app.id, plans, v);
  const problems = await rolloutProblems(deps, app, v, plans, steps);
  const now = deps.now().getTime();
  return {
    version: v,
    ok: problems.length === 0,
    problems,
    steps: steps.map((s) => ({
      instanceId: s.instance.id,
      instanceName: s.instance.name,
      instanceKind: s.instance.kind,
      planId: s.plan.id,
      fromVersion: s.instance.target_version,
      status: s.status,
      note: s.note,
      dueAt: new Date(
        now + (notice ?? s.plan.notice_hours) * HOUR_MS,
      ).toISOString(),
    })),
  };
}

/** The rollout and its App, checked for `need` (NOT_FOUND / FORBIDDEN as for the App). */
export async function loadRollout(
  deps: AppsDeps,
  caller: Caller,
  rolloutId: string,
  need: AppNeed,
): Promise<{ r: RolloutRow; app: AppRow }> {
  const r = await getRollout(deps.db, rolloutId);
  if (!r) throw appsError("NOT_FOUND", "Rollout not found");
  const app = await loadAppForOwner(deps, caller, r.app_id, { need });
  return { r, app };
}

export async function appRolloutsFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  limit: number | null | undefined,
): Promise<RolloutJson[]> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const rows = await listRollouts(
    deps.db,
    app.id,
    Math.min(Math.max(limit ?? 20, 1), 100),
  );
  return Promise.all(rows.map((r) => rolloutJson(deps.db, r)));
}

export async function rolloutFor(
  deps: AppsDeps,
  caller: Caller,
  id: string,
): Promise<RolloutJson | null> {
  if (!(await getRollout(deps.db, id))) return null;
  const { r } = await loadRollout(deps, caller, id, "view");
  return rolloutJson(deps.db, r);
}
