import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { auditCaller } from "../audit/service.js";
import type { Caller } from "../auth.js";
import { appsError, notConfigured } from "../errors.js";
import { getInstance, type InstanceRow } from "../instances/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  getGateToken,
  insertGateToken,
  lockGateToken,
  replaceGateToken,
  type GateTokenRow,
} from "./repo.js";
import { hashGateToken, newGateToken } from "./token.js";

/** What a shared instance gets while the gate is on (releases phase 3 slice 5). */
export const GATE_ACCESS_ENV = "ACCESS";
export const GATE_APP_ID_ENV = "VETRA_APP_ID";
export const GATE_URL_ENV = "VETRA_GATE_URL";
export const GATE_TOKEN_ENV = "VETRA_GATE_TOKEN";
/** The token before a rotation is accepted this long after the new one reached the tenant (G3). */
export const GATE_PREVIOUS_GRACE_MS = 15 * 60_000;

const GATE_VAULT = "The licence gate (OPENBAO_ADDR)";

/**
 * The shared instance's gate token, issued on first need (audited
 * gate.token_issued, source system). The plaintext exists only here, long
 * enough to hash and encrypt it.
 */
export async function ensureGateToken(
  deps: AppsDeps,
  row: InstanceRow,
): Promise<GateTokenRow> {
  if (row.kind !== "shared")
    throw new Error(`Only shared instances have a gate token (${row.kind})`);
  const have = await getGateToken(deps.db, row.id);
  if (have) return have;
  const vault = deps.settingsVault;
  if (!vault) throw notConfigured(GATE_VAULT);
  const token = newGateToken();
  const nowIso = deps.now().toISOString();
  const fresh: GateTokenRow = {
    instance_id: row.id,
    app_id: row.app_id,
    token_hash: hashGateToken(token),
    token_ciphertext: await vault.encrypt(token),
    token_id: deps.newId(),
    previous_hash: null,
    previous_until: null,
    delivered_at: null,
    created_at: nowIso,
    rotated_at: nowIso,
  };
  const made = await deps.db.transaction().execute(async (trx) => {
    const inserted = await insertGateToken(trx, fresh);
    if (inserted)
      await recordAudit(trx, {
        appId: row.app_id,
        at: nowIso,
        actor: AUDIT_SYSTEM_ACTOR,
        source: "system",
        action: "gate.token_issued",
        subject: `instance:${row.id}`,
        detail: {
          name: row.name,
          planId: row.plan_id ?? null,
          tokenId: fresh.token_id,
        },
      });
    return inserted;
  });
  // A concurrent pass inserted first: use its token.
  const out = made ?? (await getGateToken(deps.db, row.id));
  if (!out) throw new Error(`The gate token of ${row.id} vanished`);
  return out;
}

/**
 * A new gate token for a shared instance (operators and release managers,
 * audited gate.token_rotated). Delivered on the reconciler's next pass as a
 * settings change; the delivered token stays accepted until
 * GATE_PREVIOUS_GRACE_MS after that.
 */
export async function rotateInstanceGateToken(
  deps: AppsDeps,
  caller: Caller,
  instanceId: string,
): Promise<GateTokenRow> {
  const row = await getInstance(deps.db, instanceId);
  if (!row) throw appsError("NOT_FOUND", "Instance not found");
  await loadAppForOwner(deps, caller, row.app_id, { need: "release" });
  if (row.kind !== "shared")
    throw appsError(
      "BAD_USER_INPUT",
      "Only shared instances have a gate token",
    );
  const vault = deps.settingsVault;
  if (!vault) throw notConfigured(GATE_VAULT);
  if (!(await getGateToken(deps.db, row.id)))
    throw appsError("BAD_USER_INPUT", "The instance has no gate token yet");
  const token = newGateToken();
  const next = {
    token_hash: hashGateToken(token),
    token_ciphertext: await vault.encrypt(token),
    token_id: deps.newId(),
  };
  const nowIso = deps.now().toISOString();
  return deps.db.transaction().execute(async (trx) => {
    if (!(await lockGateToken(trx, row.id)))
      throw appsError("BAD_USER_INPUT", "The instance has no gate token yet");
    const after = await replaceGateToken(trx, row.id, next, nowIso);
    await auditCaller(trx, caller, {
      appId: row.app_id,
      at: nowIso,
      action: "gate.token_rotated",
      subject: `instance:${row.id}`,
      detail: {
        name: row.name,
        planId: row.plan_id ?? null,
        tokenId: next.token_id,
      },
    });
    return after;
  });
}
