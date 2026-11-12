import type { Kysely, Selectable } from "kysely";
import type {
  RolloutPlansTable,
  RolloutStepStatus,
  RolloutStepsTable,
  RolloutsTable,
  VetraAppsDB,
} from "../db/schema.js";

export type RolloutRow = Selectable<RolloutsTable>;
export type RolloutPlanRow = Selectable<RolloutPlansTable>;
export type RolloutStepRow = Selectable<RolloutStepsTable>;
export type RolloutPatch = Partial<
  Omit<RolloutRow, "id" | "app_id" | "updated_at">
>;
export type StepPatch = Partial<
  Omit<
    RolloutStepRow,
    "id" | "rollout_id" | "app_id" | "instance_id" | "updated_at"
  >
>;

/** Rollouts that still decide something. */
export const OPEN_ROLLOUT = ["active", "paused"] as const;
/** Steps that move an instance now: at most one per App (rollout_steps_moving_uq). */
export const MOVING = ["applying", "reverting"] as const;

/**
 * The lock every writer of an App's plan-instance targets takes: the
 * reconciler's per-App lock (reconcileInstancesOnce). In-process and not
 * re-entrant: code running under it never takes it again.
 */
export const appInstancesLock = (appId: string) => `instances:${appId}`;

export async function insertRollout(
  db: Kysely<VetraAppsDB>,
  row: RolloutRow,
): Promise<RolloutRow> {
  return db
    .insertInto("rollouts")
    .values(row)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getRollout(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<RolloutRow | null> {
  return (
    (await db
      .selectFrom("rollouts")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

/** The rollout, locked until the transaction ends. */
export async function lockRollout(
  trx: Kysely<VetraAppsDB>,
  id: string,
): Promise<RolloutRow> {
  return trx
    .selectFrom("rollouts")
    .selectAll()
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function updateRollout(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: RolloutPatch,
  nowIso: string,
): Promise<RolloutRow> {
  return db
    .updateTable("rollouts")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Newest first. */
export async function listRollouts(
  db: Kysely<VetraAppsDB>,
  appId: string,
  limit: number,
): Promise<RolloutRow[]> {
  return db
    .selectFrom("rollouts")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("started_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
}

/** The App's active and paused rollouts, oldest first (the order they run in). */
export async function openRollouts(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<RolloutRow[]> {
  return db
    .selectFrom("rollouts")
    .selectAll()
    .where("app_id", "=", appId)
    .where("status", "in", [...OPEN_ROLLOUT])
    .orderBy("started_at")
    .orderBy("id")
    .execute();
}

/** The active or paused rollout the plan is in (decision R7: at most one). */
export async function openRolloutOfPlan(
  db: Kysely<VetraAppsDB>,
  planId: string,
): Promise<RolloutRow | null> {
  return (
    (await db
      .selectFrom("rollouts")
      .innerJoin("rollout_plans", "rollout_plans.rollout_id", "rollouts.id")
      .selectAll("rollouts")
      .where("rollout_plans.plan_id", "=", planId)
      .where("rollouts.status", "in", [...OPEN_ROLLOUT])
      .orderBy("rollouts.started_at", "desc")
      .executeTakeFirst()) ?? null
  );
}

export async function insertRolloutPlans(
  db: Kysely<VetraAppsDB>,
  rows: RolloutPlanRow[],
): Promise<void> {
  if (rows.length > 0)
    await db.insertInto("rollout_plans").values(rows).execute();
}

export async function rolloutPlans(
  db: Kysely<VetraAppsDB>,
  rolloutId: string,
): Promise<RolloutPlanRow[]> {
  return db
    .selectFrom("rollout_plans")
    .selectAll()
    .where("rollout_id", "=", rolloutId)
    .orderBy("plan_id")
    .execute();
}

export async function insertSteps(
  db: Kysely<VetraAppsDB>,
  rows: RolloutStepRow[],
): Promise<void> {
  if (rows.length > 0)
    await db.insertInto("rollout_steps").values(rows).execute();
}

export async function stepsOf(
  db: Kysely<VetraAppsDB>,
  rolloutId: string,
): Promise<RolloutStepRow[]> {
  return db
    .selectFrom("rollout_steps")
    .selectAll()
    .where("rollout_id", "=", rolloutId)
    .orderBy("position")
    .orderBy("id")
    .execute();
}

export async function getStep(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<RolloutStepRow | null> {
  return (
    (await db
      .selectFrom("rollout_steps")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

/** The App's step that is applying or reverting, of any rollout (a cancelled one's too). */
export async function movingStep(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<RolloutStepRow | null> {
  return (
    (await db
      .selectFrom("rollout_steps")
      .selectAll()
      .where("app_id", "=", appId)
      .where("status", "in", [...MOVING])
      .executeTakeFirst()) ?? null
  );
}

export async function updateStep(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: StepPatch,
  nowIso: string,
): Promise<RolloutStepRow> {
  return db
    .updateTable("rollout_steps")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Guarded (as licensing's transitionUpdate): null when the step is no longer in `from`. */
export async function transitionStep(
  db: Kysely<VetraAppsDB>,
  id: string,
  from: RolloutStepStatus[],
  patch: StepPatch,
  nowIso: string,
): Promise<RolloutStepRow | null> {
  // No status to move from: nothing moves (and no empty IN list).
  if (from.length === 0) return null;
  return (
    (await db
      .updateTable("rollout_steps")
      .set({ ...patch, updated_at: nowIso })
      .where("id", "=", id)
      .where("status", "in", from)
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

/** The instance's step waiting in an open forward rollout, with that rollout. */
export async function pendingStepOfInstance(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<{ step: RolloutStepRow; rollout: RolloutRow } | null> {
  const step = await db
    .selectFrom("rollout_steps")
    .innerJoin("rollouts", "rollouts.id", "rollout_steps.rollout_id")
    .selectAll("rollout_steps")
    .where("rollout_steps.instance_id", "=", instanceId)
    .where("rollout_steps.status", "=", "pending")
    .where("rollouts.status", "in", [...OPEN_ROLLOUT])
    .where("rollouts.direction", "=", "forward")
    .orderBy("rollouts.started_at", "desc")
    .executeTakeFirst();
  if (!step) return null;
  return { step, rollout: (await getRollout(db, step.rollout_id))! };
}
