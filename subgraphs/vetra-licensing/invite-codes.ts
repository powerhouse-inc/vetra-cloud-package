import { randomInt } from "node:crypto";
import type { Kysely } from "kysely";
import type { InviteCodes, InviteRedemptions, VetraLicensingDB } from "./db/schema.js";

/**
 * Invite codes (tables `invite_codes`, `invite_redemptions`; moved from
 * vetra-access-codes). A code issues one term (kind) of one app.
 *
 * Codes are case-sensitive and URL-safe: 4 to 64 of [A-Za-z0-9_-], starting
 * with a letter or digit (vetra.io validates the same pattern). Only creation
 * checks the shape; a lookup is an exact match after trimming, so a code
 * carried over from vetra-access-codes still redeems.
 */
export const CODE_MIN_LENGTH = 4;
export const CODE_MAX_LENGTH = 64;
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

/** One error for unknown, inactive, expired and exhausted: codes cannot be probed for state. */
export class InvalidCodeError extends Error {
  override name = "InvalidCodeError";
  constructor() {
    super("invalid code");
  }
}
export class InvalidCodeInputError extends Error {
  override name = "InvalidCodeInputError";
}

export interface InviteCodeView {
  code: string;
  kind: string;
  label: string | null;
  active: boolean;
  expiresAt: string | null;
  maxUses: number | null;
  redemptions: number;
  hasAnthropicKey: boolean;
  createdAt: string;
}

const ADJECTIVES = ["swift", "bright", "calm", "clever", "bold", "brave", "keen", "lively", "merry", "nimble", "quiet", "rapid", "sunny", "witty", "eager", "gentle"];
const NOUNS = ["otter", "falcon", "maple", "comet", "harbor", "willow", "ember", "lynx", "cedar", "river", "summit", "meadow", "orbit", "pebble", "quartz", "tundra"];
const SUFFIX = "abcdefghjkmnpqrstuvwxyz23456789";

/** Surrounding whitespace only: codes are case-sensitive. */
export function normalizeCode(code: string): string {
  return code.trim();
}

/** `vetra-<adjective>-<noun>-<4 chars>`; the suffix is what makes it unguessable. */
export function generateCode(): string {
  const pick = (xs: readonly string[]) => xs[randomInt(xs.length)];
  const suffix = Array.from({ length: 4 }, () => SUFFIX[randomInt(SUFFIX.length)]).join("");
  return `vetra-${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}

/** Stored as canonical ISO so the lexical comparisons below stay correct. */
function normalizeExpiresAt(v: string | null): string | null {
  if (v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new InvalidCodeInputError("expiresAt is not a date");
  return d.toISOString();
}

async function redemptionCount(db: Kysely<VetraLicensingDB>, code: string): Promise<number> {
  const { n } = await db
    .selectFrom("invite_redemptions")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
  return Number(n);
}

function view(row: InviteCodes, redemptions: number): InviteCodeView {
  return {
    code: row.code,
    kind: row.kind,
    label: row.label,
    active: Boolean(row.active),
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    redemptions,
    hasAnthropicKey: row.anthropic_key_ciphertext !== null,
    createdAt: row.created_at,
  };
}

export async function createInviteCode(
  db: Kysely<VetraLicensingDB>,
  input: {
    appId: string;
    kind: string;
    code: string | null;
    label: string | null;
    expiresAt: string | null;
    maxUses: number | null;
    anthropicKeyCiphertext: string | null;
    now: string;
  },
): Promise<InviteCodeView> {
  const code = input.code === null ? generateCode() : normalizeCode(input.code);
  if (!code) throw new InvalidCodeInputError("code must not be empty");
  if (!CODE_PATTERN.test(code)) {
    throw new InvalidCodeInputError(
      `code must be ${CODE_MIN_LENGTH} to ${CODE_MAX_LENGTH} letters, digits, '-' or '_', starting with a letter or digit`,
    );
  }
  if (input.maxUses !== null && !(Number.isInteger(input.maxUses) && input.maxUses > 0)) {
    throw new InvalidCodeInputError("maxUses must be a positive whole number");
  }
  const row: InviteCodes = {
    code,
    app_id: input.appId,
    kind: input.kind,
    label: input.label,
    active: true,
    expires_at: normalizeExpiresAt(input.expiresAt),
    max_uses: input.maxUses,
    anthropic_key_ciphertext: input.anthropicKeyCiphertext,
    created_at: input.now,
  };
  // An existing code is refused, never returned: it may be ANOTHER app's.
  const res = await db
    .insertInto("invite_codes")
    .values(row)
    .onConflict((oc) => oc.column("code").doNothing())
    .executeTakeFirst();
  if (Number(res.numInsertedOrUpdatedRows ?? 0n) === 0) {
    throw new InvalidCodeInputError("code already exists");
  }
  return view(row, 0);
}

/** False when the code does not exist or belongs to another app. */
export async function setInviteCodeActive(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  code: string,
  active: boolean,
): Promise<boolean> {
  const res = await db
    .updateTable("invite_codes")
    .set({ active })
    .where("code", "=", normalizeCode(code))
    .where("app_id", "=", appId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

/** An app's codes, newest first, with their redemption counts. Never the key. */
export async function listInviteCodes(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<InviteCodeView[]> {
  const rows = await db
    .selectFrom("invite_codes as c")
    .selectAll("c")
    .select((eb) =>
      eb
        .selectFrom("invite_redemptions as r")
        .select((e) => e.fn.countAll<string>().as("n"))
        .whereRef("r.code", "=", "c.code")
        .as("redemptions"),
    )
    .where("c.app_id", "=", appId)
    .orderBy("c.created_at", "desc")
    .orderBy("c.code", "asc")
    .execute();
  return rows.map(({ redemptions, ...r }) => view(r, Number(redemptions ?? 0)));
}

export async function getCode(
  db: Kysely<VetraLicensingDB>,
  code: string,
): Promise<InviteCodes | null> {
  return (
    (await db
      .selectFrom("invite_codes")
      .selectAll()
      .where("code", "=", normalizeCode(code))
      .executeTakeFirst()) ?? null
  );
}

/** Active, unexpired (expiry is exclusive) and under its cap. */
export async function isUsable(
  db: Kysely<VetraLicensingDB>,
  row: InviteCodes,
  now: string,
): Promise<boolean> {
  if (!row.active) return false;
  if (row.expires_at !== null && row.expires_at <= now) return false;
  return row.max_uses === null || (await redemptionCount(db, row.code)) < row.max_uses;
}

export async function findRedemption(
  db: Kysely<VetraLicensingDB>,
  code: string,
  userDid: string,
): Promise<InviteRedemptions | null> {
  return (
    (await db
      .selectFrom("invite_redemptions")
      .selectAll()
      .where("code", "=", normalizeCode(code))
      .where("user_did", "=", userDid)
      .executeTakeFirst()) ?? null
  );
}

/**
 * Takes one use of the code for `userDid`. The code row is locked (SELECT ...
 * FOR UPDATE) in the same explicit transaction as the count and the insert,
 * so two redeems cannot both take the last use. Everything happens inside
 * that one transaction: production reaches PostgreSQL through pgbouncer in
 * transaction mode, where nothing may rely on session state.
 */
export async function reserveRedemption(
  db: Kysely<VetraLicensingDB>,
  code: string,
  userDid: string,
  now: string,
): Promise<boolean> {
  const c = normalizeCode(code);
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("invite_codes")
      .selectAll()
      .where("code", "=", c)
      .forUpdate()
      .executeTakeFirst();
    if (!row || !(await isUsable(trx, row, now))) return false;
    await trx
      .insertInto("invite_redemptions")
      .values({ code: c, user_did: userDid, redeemed_at: now, access_expires: null, license_id: null })
      .onConflict((oc) => oc.columns(["code", "user_did"]).doNothing())
      .execute();
    return true;
  });
}

export async function attachLicence(
  db: Kysely<VetraLicensingDB>,
  code: string,
  userDid: string,
  licenseId: string,
  accessExpires: string | null,
): Promise<void> {
  await db
    .updateTable("invite_redemptions")
    .set({ license_id: licenseId, access_expires: accessExpires })
    .where("code", "=", normalizeCode(code))
    .where("user_did", "=", userDid)
    .execute();
}

/** Gives a reserved use back. A redemption that already has its licence is kept. */
export async function releaseReservation(
  db: Kysely<VetraLicensingDB>,
  code: string,
  userDid: string,
): Promise<void> {
  await db
    .deleteFrom("invite_redemptions")
    .where("code", "=", normalizeCode(code))
    .where("user_did", "=", userDid)
    .where("license_id", "is", null)
    .execute();
}

export async function keyCiphertextForCode(
  db: Kysely<VetraLicensingDB>,
  code: string,
): Promise<string | null> {
  return (await getCode(db, code))?.anthropic_key_ciphertext ?? null;
}
