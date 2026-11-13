import type { Insertable, Kysely, Selectable } from "kysely";
import type { PlansTable, VetraAppsDB } from "../db/schema.js";

export type PlanRow = Selectable<PlansTable>;
export type PlanPatch = Partial<
  Omit<PlanRow, "id" | "app_id" | "kind" | "created_at" | "created_by">
>;

export async function listPlans(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<PlanRow[]> {
  return db
    .selectFrom("plans")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
}

export async function getPlan(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<PlanRow | null> {
  return (
    (await db
      .selectFrom("plans")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

/** The plan, locked until the transaction `trx` ends. */
export async function lockPlan(
  trx: Kysely<VetraAppsDB>,
  id: string,
): Promise<PlanRow> {
  return trx
    .selectFrom("plans")
    .selectAll()
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function insertPlan(
  db: Kysely<VetraAppsDB>,
  row: Insertable<PlansTable>,
): Promise<PlanRow> {
  return db
    .insertInto("plans")
    .values(row)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updatePlan(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: PlanPatch,
  nowIso: string,
): Promise<PlanRow> {
  return db
    .updateTable("plans")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}
