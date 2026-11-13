import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { AppAuditTable, AuditSource, VetraAppsDB } from "../db/schema.js";

export type AppAuditRow = Selectable<AppAuditTable>;

/** Every action the audit log records (spec section 10). Later slices add theirs here. */
export const AUDIT_ACTIONS = [
  "plan.created",
  "plan.updated",
  "plan.target_set",
  "plan.retired",
  "setting.set",
  "setting.deleted",
  "role.granted",
  "role.removed",
  "instance.status",
  "instance.setting.changed",
  "instance.domain",
  "release.recorded",
  "build.recorded",
  "rollout.started",
  "rollout.step",
  "rollout.paused",
  "rollout.resumed",
  "rollout.cancelled",
  "rollout.completed",
  "rollout.rolling_back",
  "rollout.rolled_back",
  "rollout.policy_refused",
  "instance.pinned",
  "instance.unpinned",
  "instance.update_requested",
  "release.withdrawn",
  "gate.token_issued",
  "gate.token_rotated",
  "plan.team_enabled",
  "plan.team_disabled",
  "team.ran_healthy",
  "instance.admins_set",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The actor of rows Vetra writes itself (source system or policy). */
export const AUDIT_SYSTEM_ACTOR = "vetra";
/** Longer string values in a detail are cut (error messages, reasons). */
export const AUDIT_DETAIL_STRING_MAX = 500;

export interface AuditEntry {
  appId: string;
  /** When the change was written (ISO). */
  at: string;
  actor: string;
  source: AuditSource;
  action: AuditAction;
  subject: string;
  /** Never a setting value, secret, ciphertext or token. */
  detail?: Record<string, unknown>;
}

/** A serialised detail longer than this is replaced by {"truncated":true}. */
export const AUDIT_DETAIL_MAX_BYTES = 4096;

const cutStrings = (v: unknown): unknown => {
  if (typeof v === "string")
    return v.length > AUDIT_DETAIL_STRING_MAX
      ? `${v.slice(0, AUDIT_DETAIL_STRING_MAX)}…`
      : v;
  if (Array.isArray(v)) return v.map(cutStrings);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, cutStrings(x)]),
    );
  return v;
};

/** Cuts long strings at every depth and caps the whole at AUDIT_DETAIL_MAX_BYTES. */
export function boundDetail(d: Record<string, unknown> = {}): string {
  const json = JSON.stringify(cutStrings(d));
  return Buffer.byteLength(json) > AUDIT_DETAIL_MAX_BYTES
    ? JSON.stringify({ truncated: true })
    : json;
}

/**
 * `at` is compared as text (paging, retention), so it must be the one form
 * Date#toISOString writes: YYYY-MM-DDTHH:mm:ss.sssZ.
 */
export const isIsoAt = (s: string): boolean => {
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s;
};

/** Appends one row. Pass the transaction of the change it describes. */
export async function recordAudit(
  db: Kysely<VetraAppsDB>,
  e: AuditEntry,
): Promise<AppAuditRow> {
  if (!isIsoAt(e.at))
    throw new Error(`audit at must be an ISO time (toISOString): ${e.at}`);
  return db
    .insertInto("app_audit")
    .values({
      id: randomUUID(),
      app_id: e.appId,
      at: e.at,
      actor: e.actor,
      source: e.source,
      action: e.action,
      subject: e.subject.slice(0, 512),
      detail: boundDetail(e.detail),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A position in an App's log: rows strictly older than it come next. */
export interface AuditCursor {
  at: string;
  id: string;
}

export async function listAudit(
  db: Kysely<VetraAppsDB>,
  appId: string,
  o: { limit: number; before?: AuditCursor | null },
): Promise<AppAuditRow[]> {
  let q = db.selectFrom("app_audit").selectAll().where("app_id", "=", appId);
  const b = o.before;
  // A row comparison: one range scan of app_audit_app_at_idx (app_id, at, id).
  if (b)
    q = q.where((eb) => eb(eb.refTuple("at", "id"), "<", eb.tuple(b.at, b.id)));
  return q.orderBy("at", "desc").orderBy("id", "desc").limit(o.limit).execute();
}

/** Deletes up to `batch` rows older than cutoffIso; returns how many. */
export async function sweepAudit(
  db: Kysely<VetraAppsDB>,
  cutoffIso: string,
  batch: number,
): Promise<number> {
  const r = await db
    .deleteFrom("app_audit")
    .where(
      "id",
      "in",
      db
        .selectFrom("app_audit")
        .select("id")
        .where("at", "<", cutoffIso)
        .limit(batch),
    )
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
