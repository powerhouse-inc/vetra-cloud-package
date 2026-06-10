import { type Kysely } from "kysely";
import type { VetraAccessCodesDB } from "./schema.js";

/** Per-user access window granted on redemption. */
export const ACCESS_DAYS = 30;

/** Max length accepted for an invite code. */
export const CODE_MAX_LENGTH = 100;

export type AccessStatus = {
  allowed: boolean;
  code?: string;
  label?: string;
  accessExpires?: string;
};

export type InviteCodeView = {
  code: string;
  label: string | null;
  active: boolean;
  expiresAt: string | null;
  maxUses: number | null;
  createdAt: string;
  redemptions: number;
};

export type CreateCodeInput = {
  code: string;
  label?: string | null;
  expiresAt?: string | null;
  maxUses?: number | null;
};

export type RedemptionView = {
  code: string;
  userDid: string;
  redeemedAt: string;
  accessExpires: string | null;
};

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * True when the code exists, is active, not past its expiry, and not at its
 * max_uses cap. Mirrors the checks redeemCode enforces, so a code that passes
 * here will actually be redeemable (no "validated then redeem fails" gap).
 */
export async function isCodeUsable(
  db: Kysely<VetraAccessCodesDB>,
  code: string,
): Promise<boolean> {
  const now = nowIso();
  const normalized = normalizeCode(code);
  const row = await db
    .selectFrom("invite_codes")
    .select(["code", "max_uses"])
    .where("code", "=", normalized)
    .where("active", "=", true)
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]),
    )
    .executeTakeFirst();
  if (!row) return false;
  if (row.max_uses != null) {
    const { count } = await db
      .selectFrom("invite_redemptions")
      .select((eb) => eb.fn.count<string>("user_did").as("count"))
      .where("code", "=", normalized)
      .executeTakeFirstOrThrow();
    if (Number(count) >= row.max_uses) return false;
  }
  return true;
}

/**
 * Redeem a code for a DID. Idempotent: a DID re-redeeming the same code is a
 * no-op success. Enforces `max_uses` (distinct redeeming DIDs) when set.
 */
export async function redeemCode(
  db: Kysely<VetraAccessCodesDB>,
  code: string,
  did: string,
): Promise<{ ok: boolean }> {
  const normalized = normalizeCode(code);
  return db.transaction().execute(async (trx) => {
    const now = nowIso();
    const codeRow = await trx
      .selectFrom("invite_codes")
      .select(["code", "max_uses"])
      .where("code", "=", normalized)
      .where("active", "=", true)
      .where((eb) =>
        eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]),
      )
      .forUpdate()
      .executeTakeFirst();
    if (!codeRow) return { ok: false };

    // Already redeemed by this DID -> idempotent success.
    const existing = await trx
      .selectFrom("invite_redemptions")
      .select("user_did")
      .where("code", "=", normalized)
      .where("user_did", "=", did)
      .executeTakeFirst();
    if (existing) return { ok: true };

    if (codeRow.max_uses != null) {
      const { count } = await trx
        .selectFrom("invite_redemptions")
        .select((eb) => eb.fn.count<string>("user_did").as("count"))
        .where("code", "=", normalized)
        .executeTakeFirstOrThrow();
      if (Number(count) >= codeRow.max_uses) return { ok: false };
    }

    const accessExpires = new Date(
      Date.now() + ACCESS_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    await trx
      .insertInto("invite_redemptions")
      .values({
        code: normalized,
        user_did: did,
        redeemed_at: now,
        access_expires: accessExpires,
      })
      .onConflict((oc) => oc.columns(["code", "user_did"]).doNothing())
      .execute();
    return { ok: true };
  });
}

/** Most recent non-expired redemption for a DID, with its cohort label. */
export async function getAccessStatus(
  db: Kysely<VetraAccessCodesDB>,
  did: string,
): Promise<AccessStatus> {
  const now = nowIso();
  const row = await db
    .selectFrom("invite_redemptions as r")
    .innerJoin("invite_codes as c", "c.code", "r.code")
    .select(["r.code as code", "c.label as label", "r.access_expires as access_expires"])
    .where("r.user_did", "=", did)
    .where((eb) =>
      eb.or([
        eb("r.access_expires", "is", null),
        eb("r.access_expires", ">", now),
      ]),
    )
    .orderBy("r.redeemed_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return { allowed: false };
  return {
    allowed: true,
    code: row.code,
    label: row.label ?? undefined,
    accessExpires: row.access_expires ?? undefined,
  };
}

async function codeView(
  db: Kysely<VetraAccessCodesDB>,
  code: string,
): Promise<InviteCodeView | null> {
  const row = await db
    .selectFrom("invite_codes as c")
    .leftJoin("invite_redemptions as r", "r.code", "c.code")
    .select((eb) => [
      "c.code as code",
      "c.label as label",
      "c.active as active",
      "c.expires_at as expires_at",
      "c.max_uses as max_uses",
      "c.created_at as created_at",
      eb.fn.count<string>("r.user_did").as("redemptions"),
    ])
    .where("c.code", "=", code)
    .groupBy([
      "c.code",
      "c.label",
      "c.active",
      "c.expires_at",
      "c.max_uses",
      "c.created_at",
    ])
    .executeTakeFirst();
  if (!row) return null;
  return {
    code: row.code,
    label: row.label,
    active: row.active,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    createdAt: row.created_at,
    redemptions: Number(row.redemptions),
  };
}

/** All codes with their redemption counts, newest first (admin listing). */
export async function listCodes(
  db: Kysely<VetraAccessCodesDB>,
): Promise<InviteCodeView[]> {
  const rows = await db
    .selectFrom("invite_codes as c")
    .leftJoin("invite_redemptions as r", "r.code", "c.code")
    .select((eb) => [
      "c.code as code",
      "c.label as label",
      "c.active as active",
      "c.expires_at as expires_at",
      "c.max_uses as max_uses",
      "c.created_at as created_at",
      eb.fn.count<string>("r.user_did").as("redemptions"),
    ])
    .groupBy([
      "c.code",
      "c.label",
      "c.active",
      "c.expires_at",
      "c.max_uses",
      "c.created_at",
    ])
    .orderBy("c.created_at", "desc")
    .execute();
  return rows.map((row) => ({
    code: row.code,
    label: row.label,
    active: row.active,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    createdAt: row.created_at,
    redemptions: Number(row.redemptions),
  }));
}

/**
 * LIKE pattern matching any redemption DID for a wallet address, on any
 * chain. The DID is `did:pkh:<networkId>:<chainId>:<address>`, so we anchor
 * on the `:<address>` suffix. Addresses are stored lowercased.
 *
 * The address is validated to a canonical `0x`+40-hex form first: this
 * rejects empty/partial inputs and, critically, any LIKE metacharacters
 * (`%`, `_`) — otherwise `revokeAccess("%")` would expire every wallet's
 * grants and `redemptions("%")` would dump every redemption.
 */
function addressDidPattern(address: string): string {
  const addr = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error("INVALID_ADDRESS");
  return `%:${addr}`;
}

export type RedemptionFilter = {
  code?: string | null;
  /** Wallet address (0x…), matched against the DID suffix on any chain. */
  address?: string | null;
};

/**
 * Redemptions, newest first. Optionally filtered by code and/or by the
 * redeeming wallet address. With no filter, every redemption (audit). Admin use.
 */
export async function listRedemptions(
  db: Kysely<VetraAccessCodesDB>,
  filter: RedemptionFilter = {},
): Promise<RedemptionView[]> {
  let query = db
    .selectFrom("invite_redemptions")
    .select(["code", "user_did", "redeemed_at", "access_expires"])
    .orderBy("redeemed_at", "desc");
  if (filter.code) {
    query = query.where("code", "=", normalizeCode(filter.code));
  }
  if (filter.address) {
    query = query.where("user_did", "like", addressDidPattern(filter.address));
  }
  const rows = await query.execute();
  return rows.map((row) => ({
    code: row.code,
    userDid: row.user_did,
    redeemedAt: row.redeemed_at,
    accessExpires: row.access_expires,
  }));
}

/**
 * Revoke a wallet's currently-valid access by expiring its redemptions
 * (access_expires set to now). Keeps the audit rows. Returns how many
 * still-valid grants were revoked.
 *
 * Note: this does not bar re-acquiring access. Re-redeeming the *same* code
 * is a no-op (the redemption already exists, so the expired window stays),
 * but redeeming a *different* still-active code grants fresh access — disable
 * the relevant codes too for a hard lockout.
 */
export async function revokeAccess(
  db: Kysely<VetraAccessCodesDB>,
  address: string,
): Promise<number> {
  const now = nowIso();
  const result = await db
    .updateTable("invite_redemptions")
    .set({ access_expires: now })
    .where("user_did", "like", addressDidPattern(address))
    .where((eb) =>
      eb.or([eb("access_expires", "is", null), eb("access_expires", ">", now)]),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/**
 * Normalize an optional expiry to a canonical ISO-8601 string, so the
 * string-based expiry comparisons in isCodeUsable stay correct. Throws on a
 * non-parseable value rather than storing garbage.
 */
function normalizeExpiresAt(expiresAt: string | null | undefined): string | null {
  if (expiresAt == null || expiresAt === "") return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_EXPIRES_AT");
  return date.toISOString();
}

/** Create a code (idempotent on the code string). Returns the resulting row. */
export async function createCode(
  db: Kysely<VetraAccessCodesDB>,
  input: CreateCodeInput,
): Promise<InviteCodeView> {
  const normalized = normalizeCode(input.code);
  if (!normalized) throw new Error("INVALID_CODE");
  if (normalized.length > CODE_MAX_LENGTH) throw new Error("CODE_TOO_LONG");
  const expiresAt = normalizeExpiresAt(input.expiresAt);

  await db
    .insertInto("invite_codes")
    .values({
      code: normalized,
      label: input.label ?? null,
      active: true,
      expires_at: expiresAt,
      max_uses: input.maxUses ?? null,
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.column("code").doNothing())
    .execute();
  const view = await codeView(db, normalized);
  if (!view) throw new Error("CODE_NOT_FOUND");
  return view;
}

/** Toggle a code's active flag. Returns the updated row, or null if missing. */
export async function setActiveCode(
  db: Kysely<VetraAccessCodesDB>,
  code: string,
  active: boolean,
): Promise<InviteCodeView | null> {
  const normalized = normalizeCode(code);
  await db
    .updateTable("invite_codes")
    .set({ active })
    .where("code", "=", normalized)
    .execute();
  return codeView(db, normalized);
}
