import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  BackupReason,
  InstanceBackupsTable,
  InstanceRestoresTable,
  InstanceRestoreStatus,
  VetraAppsDB,
} from "../db/schema.js";

export type InstanceBackupRow = Selectable<InstanceBackupsTable>;
export type InstanceRestoreRow = Selectable<InstanceRestoresTable>;
export type BackupPatch = Omit<
  Updateable<InstanceBackupsTable>,
  "id" | "updated_at"
>;
export type RestorePatch = Omit<
  Updateable<InstanceRestoresTable>,
  "id" | "updated_at"
>;

/** Restores that still own their instance (instance_restores_active_uq). */
export const ACTIVE_RESTORE: InstanceRestoreStatus[] = [
  "safety_backup",
  "stopping",
  "restoring_db",
  "restoring_data",
  "starting",
];

/** size_bytes is bigint: drivers may return a string. */
const nb = (r: InstanceBackupRow): InstanceBackupRow => ({
  ...r,
  size_bytes: r.size_bytes == null ? null : Number(r.size_bytes),
});

export async function insertBackup(
  db: Kysely<VetraAppsDB>,
  row: Insertable<InstanceBackupsTable>,
): Promise<InstanceBackupRow> {
  return nb(
    await db
      .insertInto("instance_backups")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function getBackup(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<InstanceBackupRow | null> {
  const r = await db
    .selectFrom("instance_backups")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return r ? nb(r) : null;
}

export async function updateBackup(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: BackupPatch,
  nowIso: string,
): Promise<InstanceBackupRow> {
  return nb(
    await db
      .updateTable("instance_backups")
      .set({ ...patch, updated_at: nowIso })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
}

export async function listBackupsOfInstance(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  limit: number,
): Promise<InstanceBackupRow[]> {
  return (
    await db
      .selectFrom("instance_backups")
      .selectAll()
      .where("instance_id", "=", instanceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute()
  ).map(nb);
}

export async function pendingBackupsOfApp(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<InstanceBackupRow[]> {
  return (
    await db
      .selectFrom("instance_backups")
      .selectAll()
      .where("app_id", "=", appId)
      .where("status", "=", "pending")
      .orderBy("created_at")
      .execute()
  ).map(nb);
}

export async function countPendingBackups(
  db: Kysely<VetraAppsDB>,
): Promise<number> {
  const r = await db
    .selectFrom("instance_backups")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** The newest backup of a reason, whatever its status. */
export async function lastBackupOf(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  reason: BackupReason,
): Promise<InstanceBackupRow | null> {
  const r = await db
    .selectFrom("instance_backups")
    .selectAll()
    .where("instance_id", "=", instanceId)
    .where("reason", "=", reason)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return r ? nb(r) : null;
}

/**
 * Backups the sweep deletes: expired, or failed before `failedBeforeIso`;
 * never a pending one, and never one an active restore restores or keeps
 * as its safety copy.
 */
export async function sweepableBackups(
  db: Kysely<VetraAppsDB>,
  nowIso: string,
  failedBeforeIso: string,
  limit: number,
): Promise<InstanceBackupRow[]> {
  return (
    await db
      .selectFrom("instance_backups")
      .selectAll()
      .where("status", "!=", "pending")
      .where((eb) =>
        eb.or([
          eb("expires_at", "<", nowIso),
          eb.and([
            eb("status", "=", "failed"),
            eb("created_at", "<", failedBeforeIso),
          ]),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("instance_restores as r")
              .select("r.id")
              .where("r.status", "in", ACTIVE_RESTORE)
              .where((x) =>
                x.or([
                  x("r.backup_id", "=", x.ref("instance_backups.id")),
                  x("r.safety_backup_id", "=", x.ref("instance_backups.id")),
                ]),
              ),
          ),
        ),
      )
      .orderBy("created_at")
      .orderBy("id")
      .limit(limit)
      .execute()
  ).map(nb);
}

export async function deleteBackup(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<void> {
  await db.deleteFrom("instance_backups").where("id", "=", id).execute();
}

export async function insertRestore(
  db: Kysely<VetraAppsDB>,
  row: Insertable<InstanceRestoresTable>,
): Promise<InstanceRestoreRow> {
  return db
    .insertInto("instance_restores")
    .values(row)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getRestore(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<InstanceRestoreRow | null> {
  return (
    (await db
      .selectFrom("instance_restores")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

export async function updateRestore(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: RestorePatch,
  nowIso: string,
): Promise<InstanceRestoreRow> {
  return db
    .updateTable("instance_restores")
    .set({ ...patch, updated_at: nowIso })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function activeRestoresOfApp(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<InstanceRestoreRow[]> {
  return db
    .selectFrom("instance_restores")
    .selectAll()
    .where("app_id", "=", appId)
    .where("status", "in", ACTIVE_RESTORE)
    .orderBy("created_at")
    .execute();
}

export async function listRestoresOfInstance(
  db: Kysely<VetraAppsDB>,
  instanceId: string,
  limit: number,
): Promise<InstanceRestoreRow[]> {
  return db
    .selectFrom("instance_restores")
    .selectAll()
    .where("instance_id", "=", instanceId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
}
