import type { Kysely, Selectable } from "kysely";
import type { EnvironmentHoldsTable, VetraAppsDB } from "../db/schema.js";

export type HoldRow = Selectable<EnvironmentHoldsTable>;

/** Holds an environment; an environment already held keeps its first hold. */
export async function insertHold(
  db: Kysely<VetraAppsDB>,
  row: HoldRow,
): Promise<HoldRow> {
  await db
    .insertInto("environment_holds")
    .values({ ...row, reason: row.reason.slice(0, 500) })
    .onConflict((oc) => oc.column("environment_id").doNothing())
    .execute();
  const stored = await getHold(db, row.environment_id);
  if (!stored) throw new Error(`hold of ${row.environment_id} was not stored`);
  return stored;
}

/** True when a hold was removed. */
export async function deleteHold(
  db: Kysely<VetraAppsDB>,
  environmentId: string,
): Promise<boolean> {
  const r = await db
    .deleteFrom("environment_holds")
    .where("environment_id", "=", environmentId)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

export async function getHold(
  db: Kysely<VetraAppsDB>,
  environmentId: string,
): Promise<HoldRow | null> {
  return (
    (await db
      .selectFrom("environment_holds")
      .selectAll()
      .where("environment_id", "=", environmentId)
      .executeTakeFirst()) ?? null
  );
}
