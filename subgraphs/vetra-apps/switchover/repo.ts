import type { Kysely, Selectable } from "kysely";
import type {
  SwitchoverState,
  SwitchoversTable,
  VetraAppsDB,
} from "../db/schema.js";

export type SwitchoverRow = Selectable<SwitchoversTable>;
export type { SwitchoverMode, SwitchoverState } from "../db/schema.js";

/** States in which a switch-over no longer acts on anything (it can be left alone for good). */
export const CLOSED_STATES: readonly SwitchoverState[] = [
  "DONE",
  "CLEANED",
  "ROLLED_BACK",
];

/** The compare-and-set of updateSwitchover lost: another runner moved the row first. */
export class SwitchoverRaceError extends Error {
  override name = "SwitchoverRaceError";
  constructor(id: string, expected: SwitchoverState) {
    super(`switch-over ${id} is no longer ${expected}`);
  }
}

/**
 * Stores a switch-over. The partial unique index allows one `real`
 * switch-over per environment unless the earlier one is ROLLED_BACK; a second
 * one fails with the database's unique violation.
 */
export async function insertSwitchover(
  db: Kysely<VetraAppsDB>,
  row: SwitchoverRow,
): Promise<SwitchoverRow> {
  await db
    .insertInto("switchovers")
    .values({ ...row, error: row.error?.slice(0, 500) ?? null })
    .execute();
  const stored = await getSwitchover(db, row.id);
  if (!stored) throw new Error(`switch-over ${row.id} was not stored`);
  return stored;
}

export async function getSwitchover(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<SwitchoverRow | null> {
  return (
    (await db
      .selectFrom("switchovers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

/** The App's switch-overs, newest first. */
export async function listSwitchovers(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<SwitchoverRow[]> {
  return db
    .selectFrom("switchovers")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
}

/** The environment's `real` switch-over that was not rolled back, if any. */
export async function openSwitchoverOfEnvironment(
  db: Kysely<VetraAppsDB>,
  environmentId: string,
): Promise<SwitchoverRow | null> {
  return (
    (await db
      .selectFrom("switchovers")
      .selectAll()
      .where("environment_id", "=", environmentId)
      .where("mode", "=", "real")
      .where("state", "<>", "ROLLED_BACK")
      .executeTakeFirst()) ?? null
  );
}

/**
 * Whether a switch-over of the plan is still in flight (any state not closed:
 * a FAILED one counts, its instance is in flux). Slice 3 refuses new targets
 * and rollouts of such a plan.
 */
export async function hasOpenSwitchover(
  db: Kysely<VetraAppsDB>,
  planId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("switchovers")
    .select("id")
    .where("plan_id", "=", planId)
    .where("state", "not in", [...CLOSED_STATES])
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Patches a switch-over only while it is still in `expectState`, so two
 * runners never both advance one row; `patch.state` is the way forward.
 * Throws SwitchoverRaceError when no row matched.
 */
export async function updateSwitchover(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: Partial<Omit<SwitchoverRow, "id">>,
  nowIso: string,
  expectState: SwitchoverState,
): Promise<SwitchoverRow> {
  const set = { ...patch, updated_at: nowIso };
  if (typeof set.error === "string") set.error = set.error.slice(0, 500);
  const r = await db
    .updateTable("switchovers")
    .set(set)
    .where("id", "=", id)
    .where("state", "=", expectState)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 0)
    throw new SwitchoverRaceError(id, expectState);
  const row = await getSwitchover(db, id);
  if (!row) throw new Error(`switch-over ${id} vanished`);
  return row;
}
