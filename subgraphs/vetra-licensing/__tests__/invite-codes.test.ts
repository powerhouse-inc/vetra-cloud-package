import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import {
  CODE_MAX_LENGTH,
  CODE_MIN_LENGTH,
  CODE_PATTERN,
  InvalidCodeError,
  InvalidCodeInputError,
  attachLicence,
  createInviteCode,
  findRedemption,
  generateCode,
  getCode,
  isUsable,
  keyCiphertextForCode,
  listInviteCodes,
  normalizeCode,
  redeemedCodeOf,
  releaseReservation,
  reserveRedemption,
  setInviteCodeActive,
} from "../invite-codes.js";

let db: Kysely<VetraLicensingDB> | undefined;
const open = async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  return db;
};
afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

const NOW = "2026-10-08T00:00:00.000Z";
const base = {
  appId: "app-1", kind: "pro", label: null, expiresAt: null, maxUses: null,
  anthropicKeyCiphertext: null, now: NOW,
};

describe("invite codes", () => {
  it("trims but keeps case, and generates unguessable codes that are valid codes", () => {
    expect(normalizeCode("  Cohort-2 ")).toBe("Cohort-2");
    expect(CODE_MAX_LENGTH).toBe(64);
    expect(CODE_MIN_LENGTH).toBe(8);
    expect(generateCode()).toMatch(/^vetra-[a-z]+-[a-z]+-[a-z0-9]{10}$/);
    expect(generateCode()).toMatch(CODE_PATTERN);
    expect(generateCode()).not.toBe(generateCode());
  });

  it("has one generic error for every unusable code", () => {
    expect(new InvalidCodeError().message).toBe("invalid code");
  });

  it("creates, lists with counts, and never returns the key", async () => {
    const d = await open();
    const v = await createInviteCode(d, { ...base, code: " Cohort-2 ", maxUses: 2, anthropicKeyCiphertext: "vault:v1:x" });
    expect(v).toMatchObject({ code: "Cohort-2", kind: "pro", active: true, maxUses: 2, redemptions: 0, hasAnthropicKey: true, createdAt: NOW });
    expect(Object.keys(v)).not.toContain("anthropicKeyCiphertext");
    await reserveRedemption(d, "Cohort-2", "did:a", NOW);
    expect((await listInviteCodes(d, "app-1"))[0]!.redemptions).toBe(1);
    expect(await listInviteCodes(d, "app-2")).toStrictEqual([]);
    expect(await keyCiphertextForCode(d, "Cohort-2")).toBe("vault:v1:x");
    expect(await keyCiphertextForCode(d, "cohort-2")).toBeNull();
  });

  it("lists newest first with each code's own count", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "old-code", now: "2026-10-01T00:00:00.000Z" });
    await createInviteCode(d, { ...base, code: "new-code", now: "2026-10-02T00:00:00.000Z", label: "Cohort" });
    await reserveRedemption(d, "old-code", "did:a", NOW);
    await reserveRedemption(d, "old-code", "did:b", NOW);
    const list = await listInviteCodes(d, "app-1");
    expect(list.map((c) => [c.code, c.redemptions, c.label, c.hasAnthropicKey])).toStrictEqual([
      ["new-code", 0, "Cohort", false],
      ["old-code", 2, null, false],
    ]);
  });

  it("generates a code when none is given", async () => {
    const d = await open();
    expect((await createInviteCode(d, { ...base, code: null })).code).toMatch(/^vetra-/);
  });

  it("retries a generated code that collides, and gives up after a few attempts", async () => {
    const d = await open();
    const taken = new Set<string>();
    const real = d.insertInto.bind(d);
    // Every generated code collides on the first two attempts.
    let attempts = 0;
    const spy = vi.spyOn(d, "insertInto").mockImplementation(((table: "invite_codes") => {
      attempts += 1;
      if (attempts <= 2) {
        return { values: (r: { code: string }) => { taken.add(r.code); return { onConflict: () => ({ executeTakeFirst: async () => ({ numInsertedOrUpdatedRows: 0n }) }) }; } };
      }
      return real(table);
    }) as never);
    const v = await createInviteCode(d, { ...base, code: null });
    expect(attempts).toBe(3);
    expect(taken.has(v.code)).toBe(false);
    attempts = -100;
    await expect(createInviteCode(d, { ...base, code: null })).rejects.toThrow(new InvalidCodeInputError("code already exists"));
    expect(attempts).toBe(-95);
    spy.mockRestore();
  });

  const SHAPE = "code must be 8 to 64 letters, digits, '-' or '_', starting with a letter or digit";
  it.each([
    ["an empty code", { code: "  " }, "code must not be empty"],
    ["a too short code", { code: "abc" }, SHAPE],
    ["a seven character code", { code: "abcdefg" }, SHAPE],
    ["a too long code", { code: "x".repeat(65) }, SHAPE],
    ["a code with a space", { code: "two words" }, SHAPE],
    ["a code starting with a dash", { code: "-dash" }, SHAPE],
    ["a code with a slash", { code: "a/b/c/d" }, SHAPE],
    ["a bad expiry", { code: "code-ccc", expiresAt: "not a date" }, "expiresAt is not a date"],
    ["a non-positive cap", { code: "code-ccc", maxUses: 0 }, "maxUses must be a positive whole number"],
    ["a fractional cap", { code: "code-ccc", maxUses: 1.5 }, "maxUses must be a positive whole number"],
  ])("refuses %s", async (_n, over, message) => {
    const d = await open();
    await expect(createInviteCode(d, { ...base, ...over })).rejects.toThrow(new InvalidCodeInputError(message));
  });

  it("accepts the longest and shortest codes the pattern allows", async () => {
    const d = await open();
    await expect(createInviteCode(d, { ...base, code: "a".repeat(64) })).resolves.toMatchObject({ code: "a".repeat(64) });
    await expect(createInviteCode(d, { ...base, code: "A_b-cdef" })).resolves.toMatchObject({ code: "A_b-cdef" });
  });

  it("refuses a code that already exists, even for another app; codes are case-sensitive", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "dup-code" });
    await expect(createInviteCode(d, { ...base, appId: "app-2", code: "dup-code" })).rejects.toThrow(new InvalidCodeInputError("code already exists"));
    await expect(createInviteCode(d, { ...base, appId: "app-2", code: "DUP-CODE" })).resolves.toMatchObject({ code: "DUP-CODE" });
    expect((await getCode(d, "dup-code"))!.app_id).toBe("app-1");
    expect((await getCode(d, "DUP-CODE"))!.app_id).toBe("app-2");
  });

  it("stores the expiry as canonical ISO", async () => {
    const d = await open();
    const v = await createInviteCode(d, { ...base, code: "code-ccc", expiresAt: "2026-12-01T00:00:00Z" });
    expect(v.expiresAt).toBe("2026-12-01T00:00:00.000Z");
    expect((await createInviteCode(d, { ...base, code: "code-ddd", expiresAt: "" })).expiresAt).toBeNull();
  });

  it("toggles active only within the owning app", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "code-ccc" });
    expect(await setInviteCodeActive(d, "app-2", "code-ccc", false)).toBe(false);
    expect(await setInviteCodeActive(d, "app-1", "CODE-CCC", false)).toBe(false);
    expect(await setInviteCodeActive(d, "app-1", " code-ccc ", false)).toBe(true);
    expect((await getCode(d, "code-ccc"))!.active).toBe(false);
  });

  it("is usable only while active, unexpired and under its cap", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "code-ccc", maxUses: 1, expiresAt: "2026-12-01T00:00:00Z" });
    const row = (await getCode(d, "code-ccc"))!;
    expect(await isUsable(d, row, NOW)).toBe(true);
    expect(await isUsable(d, row, "2026-12-01T00:00:00.000Z")).toBe(false);
    expect(await isUsable(d, row, "2026-12-02T00:00:00.000Z")).toBe(false);
    expect(await reserveRedemption(d, "code-ccc", "did:a", NOW)).toBe(true);
    expect(await isUsable(d, row, NOW)).toBe(false);
    expect(await reserveRedemption(d, "code-ccc", "did:b", NOW)).toBe(false);
    await setInviteCodeActive(d, "app-1", "code-ccc", false);
    expect(await isUsable(d, (await getCode(d, "code-ccc"))!, NOW)).toBe(false);
  });

  it("refuses to reserve an unknown, inactive or expired code", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "expired-code", expiresAt: "2026-01-01T00:00:00Z" });
    await createInviteCode(d, { ...base, code: "paused-code" });
    await setInviteCodeActive(d, "app-1", "paused-code", false);
    expect(await reserveRedemption(d, "nope", "did:a", NOW)).toBe(false);
    expect(await reserveRedemption(d, "expired-code", "did:a", NOW)).toBe(false);
    expect(await reserveRedemption(d, "paused-code", "did:a", NOW)).toBe(false);
    expect(await findRedemption(d, "paused-code", "did:a")).toBeNull();
  });

  it("takes the last use exactly once when reserved concurrently", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "last-use", maxUses: 1 });
    const results = await Promise.all(
      ["did:a", "did:b", "did:c"].map((u) => reserveRedemption(d, "last-use", u, NOW)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await listInviteCodes(d, "app-1"))[0]!.redemptions).toBe(1);
  });

  it("attaches a licence to a reservation and releases only unattached reservations", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "code-ccc" });
    await reserveRedemption(d, "code-ccc", "did:a", NOW);
    await reserveRedemption(d, "code-ccc", "did:b", NOW);
    await attachLicence(d, "code-ccc", "did:a", "lic-a", "2026-11-07T00:00:00.000Z");
    await releaseReservation(d, "code-ccc", "did:a");
    await releaseReservation(d, "code-ccc", "did:b");
    expect(await findRedemption(d, "code-ccc", "did:a")).toMatchObject({ license_id: "lic-a", access_expires: "2026-11-07T00:00:00.000Z" });
    expect(await findRedemption(d, "code-ccc", "did:b")).toBeNull();
  });

  it("reserves only once per holder: a second reservation by the same holder is not granted", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "code-ccc" });
    expect(await reserveRedemption(d, "code-ccc", "did:a", NOW)).toBe(true);
    expect(await reserveRedemption(d, "code-ccc", "did:a", NOW)).toBe(false);
    expect((await listInviteCodes(d, "app-1"))[0]!.redemptions).toBe(1);
  });

  it("names the code a holder redeemed for a licence, from the redemption row only", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "code-ddd" });
    await reserveRedemption(d, "code-ddd", "did:a", NOW);
    expect(await redeemedCodeOf(d, "lic-a", "did:a")).toBeNull();
    await attachLicence(d, "code-ddd", "did:a", "lic-a", null);
    expect(await redeemedCodeOf(d, "lic-a", "did:a")).toBe("code-ddd");
    // Another holder naming the licence gets nothing.
    expect(await redeemedCodeOf(d, "lic-a", "did:b")).toBeNull();
  });

  it("matches migrated legacy codes on lower(trim(input)) only, after an exact miss", async () => {
    const d = await open();
    await d.insertInto("invite_codes").values({
      code: "cohort-1", app_id: "studio", kind: "k", label: null, active: true, expires_at: null, max_uses: null,
      anthropic_key_ciphertext: null, created_at: NOW, legacy_case_insensitive: true,
    }).execute();
    await createInviteCode(d, { ...base, code: "Mixed-Case-1" });
    expect((await getCode(d, " COHORT-1\t"))?.code).toBe("cohort-1");
    expect((await getCode(d, "Mixed-Case-1"))?.code).toBe("Mixed-Case-1");
    expect(await getCode(d, "mixed-case-1")).toBeNull();
    expect(await getCode(d, "MIXED-CASE-1")).toBeNull();
    expect(await getCode(d, "cohort-2")).toBeNull();
    // Rows created here get the flag off.
    expect((await d.selectFrom("invite_codes").select(["code", "legacy_case_insensitive"]).orderBy("code").execute()))
      .toStrictEqual([{ code: "Mixed-Case-1", legacy_case_insensitive: false }, { code: "cohort-1", legacy_case_insensitive: true }]);
  });

  it("picks, among several redemptions behind one licence, the newest live one whose code has a key", async () => {
    // A studio licence the migration built from several legacy redemptions:
    // as vetra-access-codes did, the key comes from the newest unexpired
    // redemption whose code carries one; an expired one never lends its key.
    const d = await open();
    for (const [code, key] of [["code-old-key", "ct-old"], ["code-mid-key", "ct-mid"], ["code-new-none", null]] as const) {
      await createInviteCode(d, { ...base, code, anthropicKeyCiphertext: key });
    }
    const row = (code: string, redeemed: string, expires: string | null) =>
      d.insertInto("invite_redemptions")
        .values({ code, user_did: "did:a", redeemed_at: redeemed, access_expires: expires, license_id: "lic-m" })
        .execute();
    await row("code-old-key", "2026-07-01T00:00:00.000Z", "2026-07-31T00:00:00.000Z");
    await row("code-mid-key", "2026-09-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z");
    await row("code-new-none", "2026-10-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z");
    expect(await redeemedCodeOf(d, "lic-m", "did:a", NOW)).toBe("code-mid-key");
    // Once the keyed one has lapsed too, the newest redemption answers (no key).
    expect(await redeemedCodeOf(d, "lic-m", "did:a", "2026-10-25T00:00:00.000Z")).toBe("code-new-none");
  });
});
