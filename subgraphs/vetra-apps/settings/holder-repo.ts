import type { Kysely, Selectable } from "kysely";
import type { InstanceSettingsTable, VetraAppsDB } from "../db/schema.js";

export type InstanceSettingRow = Selectable<InstanceSettingsTable>;

/** Holder settings of several instances in one query (one reconciler pass), by instance id. */
export async function listInstanceSettings(
  db: Kysely<VetraAppsDB>,
  instanceIds: string[],
): Promise<Map<string, InstanceSettingRow[]>> {
  const out = new Map<string, InstanceSettingRow[]>();
  if (instanceIds.length === 0) return out;
  const rows = await db
    .selectFrom("instance_settings")
    .selectAll()
    .where("instance_id", "in", instanceIds)
    .orderBy("instance_id")
    .orderBy("name")
    .execute();
  for (const r of rows) {
    const list = out.get(r.instance_id);
    if (list) list.push(r);
    else out.set(r.instance_id, [r]);
  }
  return out;
}

export async function upsertInstanceSetting(
  db: Kysely<VetraAppsDB>,
  row: InstanceSettingRow,
): Promise<void> {
  await db
    .insertInto("instance_settings")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["instance_id", "name"]).doUpdateSet({
        kind: row.kind,
        mount_path: row.mount_path,
        value: row.value,
        ciphertext: row.ciphertext,
        write_id: row.write_id,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      }),
    )
    .execute();
}

export async function deleteInstanceSetting(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  name: string,
): Promise<boolean> {
  const r = await db
    .deleteFrom("instance_settings")
    .where("instance_id", "=", instanceId)
    .where("name", "=", name)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/** Every holder setting of an instance (it was destroyed). */
export async function deleteInstanceSettings(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<number> {
  const r = await db
    .deleteFrom("instance_settings")
    .where("instance_id", "=", instanceId)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

export async function countInstanceSettings(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
): Promise<number> {
  const r = await db
    .selectFrom("instance_settings")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("instance_id", "=", instanceId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
