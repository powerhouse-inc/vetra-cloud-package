import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import { auditCaller } from "../audit/service.js";
import { gateConfigOf, type VetraAppsConfig } from "../config.js";
import { powerhouseAtLeast } from "../releases/version.js";
import type { Caller } from "../auth.js";
import { appsError, notConfigured } from "../errors.js";
import { getInstance, type InstanceRow } from "../instances/repo.js";
import { loadAppForOwner, type AppsDeps } from "../service.js";
import {
  settingsRevision,
  type InstanceSettings,
  type ResolvedSecret,
} from "../settings/resolve.js";
import { GATE_LOOSENING_NAMES } from "../settings/names.js";
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

/** One rotation per instance per minute (issuing the first token is none). */
export const GATE_ROTATE_COOLDOWN_MS = 60_000;

function coolDown(
  t: Pick<GateTokenRow, "created_at" | "rotated_at">,
  nowMs: number,
): void {
  if (t.rotated_at === t.created_at) return;
  const wait = Date.parse(t.rotated_at) + GATE_ROTATE_COOLDOWN_MS - nowMs;
  if (wait > 0)
    throw appsError(
      "RATE_LIMITED",
      `The gate token was rotated less than a minute ago; try again in ${Math.ceil(wait / 1000)} s`,
    );
}

/**
 * A new gate token for a shared instance (operators and release managers,
 * audited gate.token_rotated). Delivered on the reconciler's next pass as a
 * settings change; the delivered token stays accepted until
 * GATE_PREVIOUS_GRACE_MS after the environment is observed running it.
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
  const nowMs = deps.now().getTime();
  const have = await getGateToken(deps.db, row.id);
  if (!have)
    throw appsError("BAD_USER_INPUT", "The instance has no gate token yet");
  coolDown(have, nowMs);
  const token = newGateToken();
  const next = {
    token_hash: hashGateToken(token),
    token_ciphertext: await vault.encrypt(token),
    token_id: deps.newId(),
  };
  const nowIso = new Date(nowMs).toISOString();
  return deps.db.transaction().execute(async (trx) => {
    const cur = await lockGateToken(trx, row.id);
    if (!cur)
      throw appsError("BAD_USER_INPUT", "The instance has no gate token yet");
    // Again under the lock: two concurrent rotations make one.
    coolDown(cur, nowMs);
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

const GATE_NAMES: ReadonlySet<string> = new Set([
  GATE_ACCESS_ENV,
  GATE_APP_ID_ENV,
  GATE_URL_ENV,
  GATE_TOKEN_ENV,
  ...GATE_LOOSENING_NAMES,
]);
/** A name no base setting may carry onto a gated instance. */
const isGateName = (name: string) =>
  GATE_NAMES.has(name) || name.startsWith("VETRA_GATE_");
const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * A shared instance's settings with the gate's: ACCESS=licensed, VETRA_APP_ID
 * and VETRA_GATE_URL plain, and the token as a secret whose writeId is the
 * token's id, so issuing or rotating a token moves the revision and is
 * delivered like any settings change. Base entries with a gate name, one
 * that loosens the gate (GATE_LOOSENING_NAMES) or VETRA_GATE_* are dropped
 * first (publishers cannot set them, rows from before they were reserved
 * included; defence only).
 */
export function withGate(
  base: InstanceSettings,
  gate: {
    appId: string;
    url: string;
    token: Pick<GateTokenRow, "token_ciphertext" | "token_id">;
  },
): InstanceSettings {
  const plain = [
    ...base.plain.filter((p) => !isGateName(p.name)),
    { name: GATE_ACCESS_ENV, value: "licensed" },
    { name: GATE_APP_ID_ENV, value: gate.appId },
    { name: GATE_URL_ENV, value: gate.url },
  ].sort(byName);
  const secrets: ResolvedSecret[] = [
    ...base.secrets.filter((s) => !isGateName(s.name)),
    {
      name: GATE_TOKEN_ENV,
      ciphertext: gate.token.token_ciphertext,
      writeId: gate.token.token_id,
    },
  ].sort(byName);
  return { revision: settingsRevision(plain, secrets), plain, secrets };
}

/**
 * D9: with the gate on, a shared plan's release must be built on a Powerhouse
 * that enforces ACCESS=licensed (VETRA_APPS_GATE_MIN_POWERHOUSE). The reason
 * it is not, or null (gate off, or the floor is met). An unparseable or
 * missing Powerhouse version is below the floor.
 */
export function gateFloorError(
  cfg: VetraAppsConfig,
  r: { version: string; powerhouse_version: string | null },
): string | null {
  const gate = gateConfigOf(cfg);
  if (!gate.enabled || !gate.minPowerhouse) return null;
  if (powerhouseAtLeast(r.powerhouse_version ?? "", gate.minPowerhouse))
    return null;
  return `${r.version} was built on Powerhouse ${r.powerhouse_version || "(unknown)"}; shared plans need ${gate.minPowerhouse} or newer for the licence gate. Rebuild the App on it and release again.`;
}

/** A shared instance's licence gate as the console shows it (never a token, hash or token id). */
export interface InstanceGateJson {
  /** VETRA_APPS_GATE is on: the instance is given ACCESS=licensed. */
  enabled: boolean;
  /** Its running (else target) release was built on a Powerhouse that enforces ACCESS=licensed. */
  active: boolean;
  /** Why not active, in words. */
  reason: string | null;
  tokenRotatedAt: string | null;
  /** False until the current token reached the instance's secrets. */
  tokenDelivered: boolean;
}

export function instanceGateJson(
  deps: Pick<AppsDeps, "cfg">,
  token: Pick<GateTokenRow, "rotated_at" | "delivered_at"> | null,
  release: { version: string; powerhouse_version: string | null } | null,
): InstanceGateJson {
  const enabled = gateConfigOf(deps.cfg).enabled;
  const reason = !enabled
    ? "The licence gate is off on this Vetra (VETRA_APPS_GATE)"
    : !release
      ? "The instance has no release yet"
      : gateFloorError(deps.cfg, release);
  return {
    enabled,
    active: enabled && reason === null,
    reason,
    tokenRotatedAt: token?.rotated_at ?? null,
    tokenDelivered: !!token?.delivered_at,
  };
}
