import type { Kysely, Selectable } from "kysely";
import type { AppRoleName, AppRolesTable, VetraAppsDB } from "../db/schema.js";

export type AppRoleRow = Selectable<AppRolesTable>;

/** The owner a grant is made under: a role from a previous owner has no effect. */
export const ownerScopeOf = (app: {
  owner_org_id?: string | null;
  owner_address: string;
}): string =>
  app.owner_org_id
    ? `org:${app.owner_org_id}`
    : `user:${app.owner_address.toLowerCase()}`;

/**
 * Drops the App's grants made under any owner but `ownerScope`: when the App
 * changes hands its roles lapse for good, even if it comes back (A to B to A).
 */
export async function deleteAppRolesOfOtherOwners(
  db: Kysely<VetraAppsDB>,
  appId: string,
  ownerScope: string,
): Promise<number> {
  const r = await db
    .deleteFrom("app_roles")
    .where("app_id", "=", appId)
    .where("owner_scope", "<>", ownerScope)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

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
