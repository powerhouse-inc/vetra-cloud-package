import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import {
  ACCESS_DAYS,
  createCode,
  getAccessStatus,
  getRedeemedKeyCiphertext,
  hasAttachedKeyForDid,
  isCodeUsable,
  listCodes,
  listRedemptions,
  redeemCode,
  revokeAccess,
  setActiveCode,
  setCodeAnthropicKey,
} from "../db/codes.js";
import type { VetraAccessCodesDB } from "../db/schema.js";

let db: Kysely<VetraAccessCodesDB>;

const ADDR = "0x" + "a".repeat(40);
const ADDR2 = "0x" + "b".repeat(40);
const ADDR3 = "0x" + "c".repeat(40);
const DID = `did:pkh:eip155:1:${ADDR}`;
const DID2 = `did:pkh:eip155:1:${ADDR2}`;

beforeEach(async () => {
  const pglite = new PGlite();
  db = new Kysely<VetraAccessCodesDB>({ dialect: new PGliteDialect(pglite) });
  await up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("migrations", () => {
  it("creates both tables empty", async () => {
    expect(await db.selectFrom("invite_codes").selectAll().execute()).toEqual([]);
    expect(
      await db.selectFrom("invite_redemptions").selectAll().execute(),
    ).toEqual([]);
  });
});

describe("createCode", () => {
  it("normalizes the code to trimmed lowercase", async () => {
    const view = await createCode(db, { code: "  Local-First  ", label: "LF" });
    expect(view.code).toBe("local-first");
    expect(view.label).toBe("LF");
    expect(view.active).toBe(true);
    expect(view.redemptions).toBe(0);
  });

  it("is idempotent on the code string (keeps the first row)", async () => {
    await createCode(db, { code: "dup", label: "first" });
    const second = await createCode(db, { code: "DUP", label: "second" });
    expect(second.label).toBe("first");
    const rows = await db.selectFrom("invite_codes").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it("normalizes expiresAt to ISO", async () => {
    const view = await createCode(db, { code: "x", expiresAt: "2999-01-02" });
    expect(view.expiresAt).toBe(new Date("2999-01-02").toISOString());
  });

  it("rejects empty and over-long codes", async () => {
    await expect(createCode(db, { code: "   " })).rejects.toThrow("INVALID_CODE");
    await expect(createCode(db, { code: "a".repeat(101) })).rejects.toThrow(
      "CODE_TOO_LONG",
    );
  });

  it("rejects an unparseable expiresAt", async () => {
    await expect(
      createCode(db, { code: "y", expiresAt: "not-a-date" }),
    ).rejects.toThrow("INVALID_EXPIRES_AT");
  });
});

describe("isCodeUsable", () => {
  it("true for an active, non-expired code; false for unknown", async () => {
    await createCode(db, { code: "ok" });
    expect(await isCodeUsable(db, "OK")).toBe(true);
    expect(await isCodeUsable(db, "missing")).toBe(false);
  });

  it("respects the expiry window", async () => {
    await createCode(db, { code: "past", expiresAt: "2000-01-01" });
    await createCode(db, { code: "future", expiresAt: "2999-01-01" });
    expect(await isCodeUsable(db, "past")).toBe(false);
    expect(await isCodeUsable(db, "future")).toBe(true);
  });

  it("false when inactive; toggled by setActiveCode", async () => {
    await createCode(db, { code: "toggle" });
    await setActiveCode(db, "toggle", false);
    expect(await isCodeUsable(db, "toggle")).toBe(false);
    await setActiveCode(db, "toggle", true);
    expect(await isCodeUsable(db, "toggle")).toBe(true);
  });

  it("false once max_uses is reached (consistent with redeemCode)", async () => {
    await createCode(db, { code: "limited", maxUses: 1 });
    expect(await isCodeUsable(db, "limited")).toBe(true);
    await redeemCode(db, "limited", DID);
    // cap reached -> validate now agrees with what redeem would do
    expect(await isCodeUsable(db, "limited")).toBe(false);
  });
});

describe("redeemCode + getAccessStatus", () => {
  it("redeems and reports access with cohort label", async () => {
    await createCode(db, { code: "c1", label: "Cohort 1" });
    expect(await redeemCode(db, "C1", DID)).toEqual({ ok: true });
    const status = await getAccessStatus(db, DID);
    expect(status.allowed).toBe(true);
    expect(status.code).toBe("c1");
    expect(status.label).toBe("Cohort 1");
    expect(status.accessExpires).toBeTruthy();
  });

  it("grants roughly ACCESS_DAYS of access", async () => {
    await createCode(db, { code: "c" });
    await redeemCode(db, "c", DID);
    const status = await getAccessStatus(db, DID);
    const days = (new Date(status.accessExpires!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(ACCESS_DAYS - 1);
    expect(days).toBeLessThanOrEqual(ACCESS_DAYS + 0.01);
  });

  it("is idempotent for the same did", async () => {
    await createCode(db, { code: "c" });
    expect(await redeemCode(db, "c", DID)).toEqual({ ok: true });
    expect(await redeemCode(db, "c", DID)).toEqual({ ok: true });
    const rows = await db.selectFrom("invite_redemptions").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it("rejects an invalid or expired code", async () => {
    expect(await redeemCode(db, "missing", DID)).toEqual({ ok: false });
    await createCode(db, { code: "past", expiresAt: "2000-01-01" });
    expect(await redeemCode(db, "past", DID)).toEqual({ ok: false });
  });

  it("enforces max_uses across distinct dids but allows re-redeem", async () => {
    await createCode(db, { code: "limited", maxUses: 1 });
    expect(await redeemCode(db, "limited", DID)).toEqual({ ok: true });
    // same did again: idempotent success, doesn't consume a slot
    expect(await redeemCode(db, "limited", DID)).toEqual({ ok: true });
    // a different did: cap reached
    expect(await redeemCode(db, "limited", DID2)).toEqual({ ok: false });
  });

  it("returns not-allowed when there is no redemption", async () => {
    expect(await getAccessStatus(db, DID)).toEqual({
      allowed: false,
      hasAttachedKey: false,
    });
  });

  it("ignores expired access windows", async () => {
    await createCode(db, { code: "c" });
    await db
      .insertInto("invite_redemptions")
      .values({
        code: "c",
        user_did: DID,
        redeemed_at: "2000-01-01T00:00:00.000Z",
        access_expires: "2000-02-01T00:00:00.000Z",
      })
      .execute();
    expect((await getAccessStatus(db, DID)).allowed).toBe(false);
  });
});

describe("admin listings", () => {
  it("listCodes returns codes with redemption counts", async () => {
    await createCode(db, { code: "a" });
    await createCode(db, { code: "b" });
    await redeemCode(db, "a", DID);
    await redeemCode(db, "a", DID2);
    const codes = await listCodes(db);
    expect(codes.find((c) => c.code === "a")?.redemptions).toBe(2);
    expect(codes.find((c) => c.code === "b")?.redemptions).toBe(0);
  });

  it("listRedemptions returns rows, filterable by code and address", async () => {
    await createCode(db, { code: "a" });
    await createCode(db, { code: "b" });
    await redeemCode(db, "a", DID);
    await redeemCode(db, "b", DID2);
    expect(await listRedemptions(db)).toHaveLength(2);

    const forA = await listRedemptions(db, { code: "a" });
    expect(forA).toHaveLength(1);
    expect(forA[0].userDid).toBe(DID);
    expect(forA[0].code).toBe("a");

    // by wallet address (DID suffix), case-insensitive, any chain
    const forAddr = await listRedemptions(db, { address: ADDR.toUpperCase() });
    expect(forAddr).toHaveLength(1);
    expect(forAddr[0].code).toBe("a");
    expect(await listRedemptions(db, { address: ADDR3 })).toEqual([]);
  });

  it("rejects malformed addresses (no LIKE-wildcard over-matching)", async () => {
    await createCode(db, { code: "a" });
    await redeemCode(db, "a", DID);
    await redeemCode(db, "a", DID2);
    // a wildcard would match every DID if interpolated raw — must be rejected
    await expect(listRedemptions(db, { address: "%" })).rejects.toThrow(
      "INVALID_ADDRESS",
    );
    await expect(listRedemptions(db, { address: "0xabc" })).rejects.toThrow(
      "INVALID_ADDRESS",
    );
  });
});

describe("revokeAccess", () => {
  it("expires a wallet's grants so access is no longer allowed", async () => {
    await createCode(db, { code: "a" });
    await createCode(db, { code: "b" });
    await redeemCode(db, "a", DID);
    await redeemCode(db, "b", DID);
    await redeemCode(db, "a", DID2);

    const revoked = await revokeAccess(db, ADDR);
    expect(revoked).toBe(2); // both of DID's grants
    expect((await getAccessStatus(db, DID)).allowed).toBe(false);
    // the other address is untouched
    expect((await getAccessStatus(db, DID2)).allowed).toBe(true);
    // audit rows are kept
    expect(await listRedemptions(db, { address: ADDR })).toHaveLength(2);
  });

  it("re-redeeming the same code does not restore revoked access", async () => {
    await createCode(db, { code: "a" });
    await redeemCode(db, "a", DID);
    await revokeAccess(db, ADDR);
    expect(await redeemCode(db, "a", DID)).toEqual({ ok: true }); // idempotent no-op
    expect((await getAccessStatus(db, DID)).allowed).toBe(false);
  });

  it("returns 0 when the address has no active grants", async () => {
    expect(await revokeAccess(db, ADDR)).toBe(0);
  });

  it("rejects a malformed address rather than mass-revoking", async () => {
    await createCode(db, { code: "a" });
    await redeemCode(db, "a", DID);
    await redeemCode(db, "a", DID2);
    await expect(revokeAccess(db, "%")).rejects.toThrow("INVALID_ADDRESS");
    // nothing was revoked
    expect((await getAccessStatus(db, DID)).allowed).toBe(true);
    expect((await getAccessStatus(db, DID2)).allowed).toBe(true);
  });
});

describe("attached Claude key", () => {
  // The ciphertext stored here is opaque to codes.ts — encryption happens in the
  // resolver layer. These tests use a sentinel string as the stored ciphertext.
  const CIPHER = "vault:v1:access-codes:sk-ant-xxx";

  it("createCode stores the ciphertext and reports hasAnthropicKey", async () => {
    const withKey = await createCode(db, {
      code: "keyed",
      anthropicKeyCiphertext: CIPHER,
    });
    expect(withKey.hasAnthropicKey).toBe(true);

    const without = await createCode(db, { code: "plain" });
    expect(without.hasAnthropicKey).toBe(false);
  });

  it("never exposes the raw ciphertext through a view", async () => {
    await createCode(db, { code: "keyed", anthropicKeyCiphertext: CIPHER });
    const listed = await listCodes(db);
    const view = listed.find((c) => c.code === "keyed")!;
    expect(view.hasAnthropicKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain(CIPHER);
  });

  it("setCodeAnthropicKey attaches, rotates, and detaches", async () => {
    await createCode(db, { code: "c" });
    expect((await setCodeAnthropicKey(db, "C", CIPHER))?.hasAnthropicKey).toBe(true);
    expect(
      (await setCodeAnthropicKey(db, "c", "vault:v1:access-codes:rotated"))
        ?.hasAnthropicKey,
    ).toBe(true);
    expect((await setCodeAnthropicKey(db, "c", null))?.hasAnthropicKey).toBe(false);
  });

  it("setCodeAnthropicKey returns null for a missing code", async () => {
    expect(await setCodeAnthropicKey(db, "nope", CIPHER)).toBeNull();
  });

  it("getRedeemedKeyCiphertext returns the key only for an active keyed redemption", async () => {
    await createCode(db, { code: "keyed", anthropicKeyCiphertext: CIPHER });
    await createCode(db, { code: "plain" });

    // No redemption yet -> none.
    expect(await getRedeemedKeyCiphertext(db, DID)).toBeNull();
    expect(await hasAttachedKeyForDid(db, DID)).toBe(false);

    // Redeeming a keyless code -> still none.
    await redeemCode(db, "plain", DID);
    expect(await getRedeemedKeyCiphertext(db, DID)).toBeNull();

    // Redeeming the keyed code -> returns its ciphertext.
    await redeemCode(db, "keyed", DID);
    expect(await getRedeemedKeyCiphertext(db, DID)).toBe(CIPHER);
    expect(await hasAttachedKeyForDid(db, DID)).toBe(true);
    expect((await getAccessStatus(db, DID)).hasAttachedKey).toBe(true);
  });

  it("ignores an expired redemption when resolving the key", async () => {
    await createCode(db, { code: "keyed", anthropicKeyCiphertext: CIPHER });
    await db
      .insertInto("invite_redemptions")
      .values({
        code: "keyed",
        user_did: DID,
        redeemed_at: "2000-01-01T00:00:00.000Z",
        access_expires: "2000-02-01T00:00:00.000Z",
      })
      .execute();
    expect(await getRedeemedKeyCiphertext(db, DID)).toBeNull();
    expect((await getAccessStatus(db, DID)).hasAttachedKey).toBe(false);
  });
});
