import type { Kysely, Selectable } from "kysely";
import type { AppRoleName, AppRolesTable, VetraAppsDB } from "../db/schema.js";

export type AppRoleRow = Selectable<AppRolesTable>;

export async function getAppRole(
  db: Kysely<VetraAppsDB>,
  appId: string,
  address: string,
  role: AppRoleName,
): Promise<AppRoleRow | null> {
  return (
    (await db
      .selectFrom("app_roles")
      .selectAll()
      .where("app_id", "=", appId)
      .where("address", "=", address)
      .where("role", "=", role)
      .executeTakeFirst()) ?? null
  );
}

/** The App's grants made under its current owner (ownerScope). */
export async function listAppRoles(
  db: Kysely<VetraAppsDB>,
  appId: string,
  ownerScope: string,
): Promise<AppRoleRow[]> {
  return db
    .selectFrom("app_roles")
    .selectAll()
    .where("app_id", "=", appId)
    .where("owner_scope", "=", ownerScope)
    .orderBy("granted_at", "asc")
    .orderBy("address", "asc")
    .execute();
}

export async function hasAppRole(
  db: Kysely<VetraAppsDB>,
  appId: string,
  address: string,
  role: AppRoleName,
  ownerScope: string,
): Promise<boolean> {
  return !!(await db
    .selectFrom("app_roles")
    .select("app_id")
    .where("app_id", "=", appId)
    .where("address", "=", address)
    .where("role", "=", role)
    .where("owner_scope", "=", ownerScope)
    .executeTakeFirst());
}

/** Grants, or re-grants under a new owner scope. */
export async function upsertAppRole(
  db: Kysely<VetraAppsDB>,
  row: AppRoleRow,
): Promise<AppRoleRow> {
  return db
    .insertInto("app_roles")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["app_id", "address", "role"]).doUpdateSet({
        owner_scope: row.owner_scope,
        granted_by: row.granted_by,
        granted_at: row.granted_at,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteAppRole(
  db: Kysely<VetraAppsDB>,
  appId: string,
  address: string,
  role: AppRoleName,
): Promise<boolean> {
  const r = await db
    .deleteFrom("app_roles")
    .where("app_id", "=", appId)
    .where("address", "=", address)
    .where("role", "=", role)
    .executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}
