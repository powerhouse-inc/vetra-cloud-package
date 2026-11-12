import type { Kysely } from "kysely";
import type { AppsContext, Caller, CallerSource } from "../auth.js";
import type { VetraAppsDB } from "../db/schema.js";
import { appsError } from "../errors.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  listAudit,
  recordAudit,
  sweepAudit,
  type AppAuditRow,
  type AuditCursor,
  type AuditEntry,
} from "./repo.js";

export const AUDIT_RETENTION_DAYS = 365;
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
export const AUDIT_SWEEP_BATCH = 5000;
export const AUDIT_SWEEP_MAX_BATCHES = 20;

/** console when the request's Origin is the console's (cfg.vetraAppUrl); else api. */
export function callerSource(
  ctx: Pick<AppsContext, "headers">,
  consoleUrl: string,
): CallerSource {
  const raw = ctx.headers?.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin) return "api";
  try {
    return new URL(origin).origin === new URL(consoleUrl).origin
      ? "console"
      : "api";
  } catch {
    return "api";
  }
}

/** A row for something a person did. Pass the transaction of the change. */
export function auditCaller(
  db: Kysely<VetraAppsDB>,
  caller: Caller,
  e: Omit<AuditEntry, "actor" | "source">,
): Promise<AppAuditRow> {
  return recordAudit(db, {
    ...e,
    actor: caller.address,
    source: caller.source ?? "api",
  });
}

export interface AuditEntryJson {
  id: string;
  appId: string;
  at: string;
  actor: string;
  source: string;
  action: string;
  subject: string;
  /** A JSON object. */
  detail: string;
}

export interface AuditPageJson {
  entries: AuditEntryJson[];
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: string | null;
}

const auditJson = (r: AppAuditRow): AuditEntryJson => ({
  id: r.id,
  appId: r.app_id,
  at: r.at,
  actor: r.actor,
  source: r.source,
  action: r.action,
  subject: r.subject,
  detail: r.detail,
});

export const encodeAuditCursor = (r: Pick<AppAuditRow, "at" | "id">): string =>
  Buffer.from(`${r.at}|${r.id}`).toString("base64url");

export function decodeAuditCursor(s: string): AuditCursor {
  const raw = Buffer.from(s, "base64url").toString("utf8");
  const i = raw.indexOf("|");
  if (i <= 0 || i === raw.length - 1)
    throw appsError("BAD_USER_INPUT", "Invalid audit cursor");
  return { at: raw.slice(0, i), id: raw.slice(i + 1) };
}

/** The App's audit log, newest first (spec section 10). Anyone who may view the App. */
export async function appAuditFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  limit?: number | null,
  before?: string | null,
): Promise<AuditPageJson> {
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
  const n = Math.min(Math.max(limit ?? AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX);
  const rows = await listAudit(deps.db, app.id, {
    limit: n + 1,
    before: before ? decodeAuditCursor(before) : null,
  });
  const page = rows.slice(0, n);
  return {
    entries: page.map(auditJson),
    nextBefore:
      rows.length > n ? encodeAuditCursor(page[page.length - 1]) : null,
  };
}

/**
 * Deletes rows older than AUDIT_RETENTION_DAYS: batch after batch while they
 * come back full, at most maxBatches per pass (the next pass goes on).
 */
export async function sweepAuditOnce(
  deps: AppsDeps,
  o: { batch?: number; maxBatches?: number } = {},
): Promise<number> {
  const batch = o.batch ?? AUDIT_SWEEP_BATCH;
  const maxBatches = o.maxBatches ?? AUDIT_SWEEP_MAX_BATCHES;
  const cutoff = new Date(
    deps.now().getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await sweepAudit(deps.db, cutoff, batch);
    total += n;
    if (n < batch) break;
  }
  return total;
}
