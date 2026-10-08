import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import {
  CODE_MAX_LENGTH,
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
    expect(generateCode()).toMatch(/^vetra-[a-z]+-[a-z]+-[a-z0-9]{4}$/);
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

  const SHAPE = "code must be 4 to 64 letters, digits, '-' or '_', starting with a letter or digit";
  it.each([
    ["an empty code", { code: "  " }, "code must not be empty"],
    ["a too short code", { code: "abc" }, SHAPE],
    ["a too long code", { code: "x".repeat(65) }, SHAPE],
    ["a code with a space", { code: "two words" }, SHAPE],
    ["a code starting with a dash", { code: "-dash" }, SHAPE],
    ["a code with a slash", { code: "a/b/c/d" }, SHAPE],
    ["a bad expiry", { code: "cccc", expiresAt: "not a date" }, "expiresAt is not a date"],
    ["a non-positive cap", { code: "cccc", maxUses: 0 }, "maxUses must be a positive whole number"],
    ["a fractional cap", { code: "cccc", maxUses: 1.5 }, "maxUses must be a positive whole number"],
  ])("refuses %s", async (_n, over, message) => {
    const d = await open();
    await expect(createInviteCode(d, { ...base, ...over })).rejects.toThrow(new InvalidCodeInputError(message));
  });

  it("accepts the longest and shortest codes the pattern allows", async () => {
    const d = await open();
    await expect(createInviteCode(d, { ...base, code: "a".repeat(64) })).resolves.toMatchObject({ code: "a".repeat(64) });
    await expect(createInviteCode(d, { ...base, code: "A_b-" })).resolves.toMatchObject({ code: "A_b-" });
  });

  it("refuses a code that already exists, even for another app; codes are case-sensitive", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "dup1" });
    await expect(createInviteCode(d, { ...base, appId: "app-2", code: "dup1" })).rejects.toThrow(new InvalidCodeInputError("code already exists"));
    await expect(createInviteCode(d, { ...base, appId: "app-2", code: "DUP1" })).resolves.toMatchObject({ code: "DUP1" });
    expect((await getCode(d, "dup1"))!.app_id).toBe("app-1");
    expect((await getCode(d, "DUP1"))!.app_id).toBe("app-2");
  });

  it("stores the expiry as canonical ISO", async () => {
    const d = await open();
    const v = await createInviteCode(d, { ...base, code: "cccc", expiresAt: "2026-12-01T00:00:00Z" });
    expect(v.expiresAt).toBe("2026-12-01T00:00:00.000Z");
    expect((await createInviteCode(d, { ...base, code: "dddd", expiresAt: "" })).expiresAt).toBeNull();
  });

  it("toggles active only within the owning app", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "cccc" });
    expect(await setInviteCodeActive(d, "app-2", "cccc", false)).toBe(false);
    expect(await setInviteCodeActive(d, "app-1", "CCCC", false)).toBe(false);
    expect(await setInviteCodeActive(d, "app-1", " cccc ", false)).toBe(true);
    expect((await getCode(d, "cccc"))!.active).toBe(false);
  });

  it("is usable only while active, unexpired and under its cap", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "cccc", maxUses: 1, expiresAt: "2026-12-01T00:00:00Z" });
    const row = (await getCode(d, "cccc"))!;
    expect(await isUsable(d, row, NOW)).toBe(true);
    expect(await isUsable(d, row, "2026-12-01T00:00:00.000Z")).toBe(false);
    expect(await isUsable(d, row, "2026-12-02T00:00:00.000Z")).toBe(false);
    expect(await reserveRedemption(d, "cccc", "did:a", NOW)).toBe(true);
    expect(await isUsable(d, row, NOW)).toBe(false);
    expect(await reserveRedemption(d, "cccc", "did:b", NOW)).toBe(false);
    await setInviteCodeActive(d, "app-1", "cccc", false);
    expect(await isUsable(d, (await getCode(d, "cccc"))!, NOW)).toBe(false);
  });

  it("refuses to reserve an unknown, inactive or expired code", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "expired", expiresAt: "2026-01-01T00:00:00Z" });
    await createInviteCode(d, { ...base, code: "paused" });
    await setInviteCodeActive(d, "app-1", "paused", false);
    expect(await reserveRedemption(d, "nope", "did:a", NOW)).toBe(false);
    expect(await reserveRedemption(d, "expired", "did:a", NOW)).toBe(false);
    expect(await reserveRedemption(d, "paused", "did:a", NOW)).toBe(false);
    expect(await findRedemption(d, "paused", "did:a")).toBeNull();
  });

  it("takes the last use exactly once when reserved concurrently", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "last", maxUses: 1 });
    const results = await Promise.all(
      ["did:a", "did:b", "did:c"].map((u) => reserveRedemption(d, "last", u, NOW)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await listInviteCodes(d, "app-1"))[0]!.redemptions).toBe(1);
  });

  it("attaches a licence to a reservation and releases only unattached reservations", async () => {
    const d = await open();
    await createInviteCode(d, { ...base, code: "cccc" });
    await reserveRedemption(d, "cccc", "did:a", NOW);
    await reserveRedemption(d, "cccc", "did:b", NOW);
    await attachLicence(d, "cccc", "did:a", "lic-a", "2026-11-07T00:00:00.000Z");
    await releaseReservation(d, "cccc", "did:a");
    await releaseReservation(d, "cccc", "did:b");
    expect(await findRedemption(d, "cccc", "did:a")).toMatchObject({ license_id: "lic-a", access_expires: "2026-11-07T00:00:00.000Z" });
    expect(await findRedemption(d, "cccc", "did:b")).toBeNull();
  });
});
