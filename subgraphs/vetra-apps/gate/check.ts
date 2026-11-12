import { notConfigured } from "../errors.js";
import { adminsOf } from "../instances/reconciler.js";
import { getInstance } from "../instances/repo.js";
import { liveLicenceOf } from "../plans/holders.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import type { AppsDeps } from "../service.js";
import { findByTokenHash } from "./repo.js";
import { hashGateToken, isGateTokenShape, sameGateHash } from "./token.js";

/** member is reserved for the Team instance (slice 6). */
export type GateReason = "admin" | "licence" | "member" | "none";
export interface GateAnswer {
  allowed: boolean;
  reason: GateReason;
  /** The latest end of the caller's live licences; null = open-ended, admin, or denied. */
  until: string | null;
  /** How long the host may keep this answer (G4). */
  ttlSeconds: number;
}
export const GATE_TTL_SECONDS = 60;
export const GATE_DENIED_TTL_SECONDS = 15;
/** The only callers the gate answers about (G10): compared in lowercase. */
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The licence gate's decision for one caller of a shared instance (D8, G4):
 * the instance's ADMINS, else a live licence of the plan's kind for the App
 * (whatever the plan's status), else none. Nothing is cached here: the host's
 * cache is the only one, so a lapse is seen within its ttl.
 *
 * null: the token is unknown, retired, or not a live shared instance's (401).
 * Throws when the licensing tables are missing (503).
 */
export async function checkGate(
  deps: AppsDeps,
  token: string,
  address: string,
): Promise<{ instanceId: string; answer: GateAnswer } | null> {
  if (!isGateTokenShape(token)) return null;
  const nowIso = deps.now().toISOString();
  const hash = hashGateToken(token);
  const gate = await findByTokenHash(deps.db, hash, nowIso);
  // The lookup is by equality on an indexed hash; this is defence in depth.
  if (
    !gate ||
    !(
      sameGateHash(hash, gate.token_hash) ||
      sameGateHash(hash, gate.previous_hash)
    )
  )
    return null;
  const row = await getInstance(deps.db, gate.instance_id);
  if (!row || row.kind !== "shared" || row.removed_at || !row.plan_id)
    return null;
  const [plan, app] = await Promise.all([
    getPlan(deps.db, row.plan_id),
    getApp(deps.db, row.app_id),
  ]);
  if (!plan || !app || plan.app_id !== app.id) return null;
  const who = address.toLowerCase();
  const admins = adminsOf(app, row)
    .split(",")
    .map((a) => a.trim().toLowerCase());
  if (admins.includes(who))
    return {
      instanceId: row.id,
      answer: {
        allowed: true,
        reason: "admin",
        until: null,
        ttlSeconds: GATE_TTL_SECONDS,
      },
    };
  if (!deps.licensingDb) throw notConfigured("The licensing tables");
  const live = await liveLicenceOf(
    deps.licensingDb,
    app.id,
    plan.kind,
    who,
    nowIso,
  );
  if (!live)
    return {
      instanceId: row.id,
      answer: {
        allowed: false,
        reason: "none",
        until: null,
        ttlSeconds: GATE_DENIED_TTL_SECONDS,
      },
    };
  const left = live.until
    ? Math.floor((Date.parse(live.until) - Date.parse(nowIso)) / 1000)
    : GATE_TTL_SECONDS;
  return {
    instanceId: row.id,
    answer: {
      allowed: true,
      reason: "licence",
      until: live.until,
      ttlSeconds: Math.max(1, Math.min(GATE_TTL_SECONDS, left)),
    },
  };
}
