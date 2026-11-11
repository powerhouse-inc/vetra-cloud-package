import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  InstanceKind,
  InstancesTable,
  VetraAppsDB,
} from "../db/schema.js";

export type InstanceRow = Selectable<InstancesTable>;
export type NewInstance = Insertable<InstancesTable>;
export type InstancePatch = Omit<
  Updateable<InstancesTable>,
  "id" | "updated_at"
>;

/** target_run is bigint (GitHub run ids exceed 32 bits): drivers may return a string. */
function normalize(r: InstanceRow): InstanceRow {
  return {
    ...r,
    target_run: r.target_run == null ? null : Number(r.target_run),
  };
}

export async function listInstances(
  db: Kysely<VetraAppsDB>,
  appId: string,
  kind?: InstanceKind,
): Promise<InstanceRow[]> {
  let q = db.selectFrom("instances").selectAll().where("app_id", "=", appId);
  if (kind) q = q.where("kind", "=", kind);
  const rows = await q
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map(normalize);
}

export async function insertInstance(
  db: Kysely<VetraAppsDB>,
  row: NewInstance,
): Promise<InstanceRow> {
  return normalize(
    await db
      .insertInto("instances")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function updateInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: InstancePatch,
  nowIso: string,
): Promise<InstanceRow> {
  return normalize(
    await db
      .updateTable("instances")
      .set({ ...patch, updated_at: nowIso })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function deleteInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<void> {
  await db.deleteFrom("instances").where("id", "=", id).execute();
}

/** Whether any instance (tombstones included) holds this host label. */
export async function isHostUsed(
  db: Kysely<VetraAppsDB>,
  host: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("instances")
    .select("id")
    .where("host", "=", host)
    .executeTakeFirst());
}
