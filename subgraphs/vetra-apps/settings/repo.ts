import type { Kysely, Selectable } from "kysely";
import type {
  AppSettingScope,
  AppSettingsTable,
  VetraAppsDB,
} from "../db/schema.js";

export type AppSettingRow = Selectable<AppSettingsTable>;

export async function listAppSettings(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<AppSettingRow[]> {
  return db
    .selectFrom("app_settings")
    .selectAll()
    .where("app_id", "=", appId)
    .orderBy("name")
    .orderBy("scope")
    .execute();
}

export async function upsertAppSetting(
  db: Kysely<VetraAppsDB>,
  row: AppSettingRow,
): Promise<void> {
  await db
    .insertInto("app_settings")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["app_id", "scope", "name"]).doUpdateSet({
        secret: row.secret,
        value: row.value,
        ciphertext: row.ciphertext,
        write_id: row.write_id,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      }),
    )
    .execute();
}

export async function deleteAppSetting(
  db: Kysely<VetraAppsDB>,
  appId: string,
  scope: AppSettingScope,
  name: string,
): Promise<boolean> {
  const r = await db
    .deleteFrom("app_settings")
    .where("app_id", "=", appId)
    .where("scope", "=", scope)
    .where("name", "=", name)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

/** Every setting of an App (the App was deleted). */
export async function deleteAppSettings(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<number> {
  const r = await db
    .deleteFrom("app_settings")
    .where("app_id", "=", appId)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
