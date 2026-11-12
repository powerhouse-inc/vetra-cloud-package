import type { Insertable, Kysely, Selectable, Updateable } from "kysely";
import type {
  InstanceHealth,
  InstanceKind,
  InstancesTable,
  VetraAppsDB,
} from "../db/schema.js";
import {
  AUDIT_SYSTEM_ACTOR,
  recordAudit,
  type AuditEntry,
} from "../audit/repo.js";

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

export async function getInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
): Promise<InstanceRow | null> {
  const r = await db
    .selectFrom("instances")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return r ? normalize(r) : null;
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

/** The audit row of an instance status change (spec section 10; source system). */
export function instanceStatusEntry(
  row: InstanceRow,
  from: string,
  at: string,
): AuditEntry {
  return {
    appId: row.app_id,
    at,
    actor: AUDIT_SYSTEM_ACTOR,
    source: "system",
    action: "instance.status",
    subject: `instance:${row.id}`,
    detail: {
      kind: row.kind,
      name: row.name,
      from,
      to: row.status,
      reason: row.reason,
      targetVersion: row.target_version,
      runningVersion: row.running_version,
      planId: row.plan_id ?? null,
    },
  };
}

/**
 * The only writer of instances.status. A patch that sets a status reads the
 * old one under a row lock and audits a change, atomically with the write; a
 * patch without a status is the single UPDATE it always was (the reconciler's
 * hot path; it patches only on change anyway).
 */
export async function updateInstance(
  db: Kysely<VetraAppsDB>,
  id: string,
  patch: InstancePatch,
  nowIso: string,
): Promise<InstanceRow> {
  const write = async (q: Kysely<VetraAppsDB>): Promise<InstanceRow> => {
    const before =
      patch.status === undefined
        ? undefined
        : await q
            .selectFrom("instances")
            .select("status")
            .where("id", "=", id)
            .forUpdate()
            .executeTakeFirst();
    const row = normalize(
      await q
        .updateTable("instances")
        .set({ ...patch, updated_at: nowIso })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    if (before && before.status !== row.status)
      await recordAudit(q, instanceStatusEntry(row, before.status, nowIso));
    return row;
  };
  if (patch.status === undefined || db.isTransaction) return write(db);
  return db.transaction().execute(write);
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

export interface HealthRecord {
  health: InstanceHealth;
  health_check: string | null;
  health_reason: string | null;
  health_checked_at: string;
  health_since: string;
  health_digest: string | null;
  health_restarts: number | null;
  observed_digest: string | null;
  observed_digest_source: "pod" | "document" | null;
  /** The settings revision the check judged (the environment's VETRA_SETTINGS_REVISION). */
  health_settings: string | null;
  /** The settings revision a ready host pod runs. */
  observed_settings: string | null;
}

/** Live instances with an environment and a host, not checked since dueBeforeIso, never-checked first. */
export async function listDueForHealth(
  db: Kysely<VetraAppsDB>,
  dueBeforeIso: string,
  limit: number,
): Promise<InstanceRow[]> {
  const rows = await db
    .selectFrom("instances")
    .selectAll()
    .where("environment_id", "is not", null)
    .where("host", "is not", null)
    .where("removed_at", "is", null)
    .where("status", "!=", "removed")
    .where((eb) =>
      eb.or([
        eb("health_checked_at", "is", null),
        eb("health_checked_at", "<", dueBeforeIso),
      ]),
    )
    .orderBy("health_checked_at", (ob) => ob.asc().nullsFirst())
    .orderBy("id")
    .limit(limit)
    .execute();
  return rows.map(normalize);
}

/** A check that judged nothing (skipped or errored): the verdict and when, the rest kept. */
export type HealthStamp = Pick<
  HealthRecord,
  | "health"
  | "health_check"
  | "health_reason"
  | "health_checked_at"
  | "health_since"
>;

/**
 * Health columns only: never status, reason, targets or updated_at. A row
 * removed meanwhile, or whose environment changed since it was read (the
 * reconciler recreated it), is left alone: the check was about another one.
 */
export async function recordHealth(
  db: Kysely<VetraAppsDB>,
  row: Pick<InstanceRow, "id" | "environment_id">,
  r: HealthRecord | HealthStamp,
): Promise<void> {
  await db
    .updateTable("instances")
    .set(r)
    .where("id", "=", row.id)
    .where("environment_id", "=", row.environment_id)
    .where("removed_at", "is", null)
    .execute();
}
