import { describe, expect, it, vi } from "vitest";
import { studioAccess, studioKeyForDid, type StudioAccessDeps } from "../studio-access.js";
import type { AuthorisedLicence } from "../licence-view.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const NOW = "2026-10-08T00:00:00.000Z";
const STUDIO = "studio-app";

const L = (id: string, over: Partial<AuthorisedLicence> = {}): AuthorisedLicence => ({
  id, app: STUDIO, appId: STUDIO, user: DID, userDid: DID, kind: "studio-early-access-30d", issuer: "INVITE_CODE",
  status: "ACTIVE", issued: "2026-10-01T00:00:00.000Z", start: "2026-10-01T00:00:00.000Z",
  end: "2026-10-31T00:00:00.000Z", stage: null, details: null, replacedBy: null, legacyLicenseTypeId: null,
  endedAt: null, ...over,
});

/** `codes` maps licence id -> the code its holder redeemed; "with-key" carries a key. */
const deps = (
  licences: AuthorisedLicence[],
  codes: Record<string, string> = {},
  over: Partial<StudioAccessDeps> = {},
): StudioAccessDeps => ({
  studioAppId: async () => STUDIO,
  licencesOf: vi.fn(async (appId: string) => (appId === STUDIO ? licences : [])),
  redeemedCode: async (id, did) => (did === DID ? (codes[id] ?? null) : null),
  keyCiphertextForCode: async (c) => (c === "with-key" ? "enc:sk-ant" : null),
  keyVault: { encrypt: async (p) => `enc:${p}`, decrypt: async (c) => c.slice(4) },
  now: () => NOW,
  ...over,
});

const DENIED = { allowed: false, licenseId: null, expires: null, hasAttachedKey: false };

describe("studio access", () => {
  it("allows an ACTIVE studio licence and resolves the key its holder redeemed", async () => {
    const d = deps([L("a")], { a: "with-key" });
    expect(await studioAccess(d, DID)).toStrictEqual({
      allowed: true, licenseId: "a", expires: "2026-10-31T00:00:00.000Z", hasAttachedKey: true,
    });
    expect(await studioKeyForDid(d, DID)).toBe("sk-ant");
  });

  it("reports the licence that lasts longest, and finds a key on any live one", async () => {
    const d = deps([L("a"), L("b", { end: "2026-12-01T00:00:00.000Z" }), L("c", { end: null })], { a: "with-key", b: "no-key" });
    expect(await studioAccess(d, DID)).toMatchObject({ allowed: true, licenseId: "c", expires: null, hasAttachedKey: true });
    expect(await studioKeyForDid(d, DID)).toBe("sk-ant");
  });

  it("carries a key along the chain: a renewal through a code without a key keeps the predecessor's", async () => {
    const d = deps([L("a", { status: "REPLACED", replacedBy: "b", endedAt: NOW }), L("b")], { a: "with-key", b: "no-key" });
    expect(await studioAccess(d, DID)).toMatchObject({ allowed: true, licenseId: "b", hasAttachedKey: true });
    expect(await studioKeyForDid(d, DID)).toBe("sk-ant");
  });

  it("never offers the key of a licence that is no longer live and not in a live chain", async () => {
    const d = deps([L("old", { status: "EXPIRED", endedAt: NOW }), L("b")], { old: "with-key" });
    expect(await studioAccess(d, DID)).toMatchObject({ allowed: true, licenseId: "b", hasAttachedKey: false });
    expect(await studioKeyForDid(d, DID)).toBeNull();
  });

  it("denies an ACTIVE licence past its end (the keeper has not expired it yet)", async () => {
    const d = deps([L("a", { end: "2026-10-07T00:00:00.000Z" })], { a: "with-key" });
    expect(await studioAccess(d, DID)).toStrictEqual({ allowed: false, licenseId: "a", expires: "2026-10-07T00:00:00.000Z", hasAttachedKey: false });
    expect(await studioKeyForDid(d, DID)).toBeNull();
  });

  it.each(["EXPIRED", "REVOKED"])("denies a %s licence but still names the newest one, for its warnings", async (status) => {
    const d = deps([
      L("older", { status: "EXPIRED", end: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T00:00:00.000Z" }),
      L("newest", { status: status as "EXPIRED" | "REVOKED", end: "2026-10-05T00:00:00.000Z", endedAt: "2026-10-05T00:00:00.000Z" }),
    ], { newest: "with-key" });
    expect(await studioAccess(d, DID)).toStrictEqual({ allowed: false, licenseId: "newest", expires: "2026-10-05T00:00:00.000Z", hasAttachedKey: false });
  });

  it("is all null for someone who never held a studio licence, or without the studio app", async () => {
    expect(await studioAccess(deps([]), DID)).toStrictEqual(DENIED);
    expect(await studioAccess(deps([L("a")], {}, { studioAppId: async () => null }), DID)).toStrictEqual(DENIED);
    expect(await studioKeyForDid(deps([L("a")], { a: "with-key" }, { studioAppId: async () => null }), DID)).toBeNull();
  });

  it("has no key without a vault", async () => {
    const d = deps([L("a")], { a: "with-key" }, { keyVault: null });
    expect(await studioKeyForDid(d, DID)).toBeNull();
    // Not reported as attached: applyStudioKey could not deliver it, so the
    // client must offer manual entry instead.
    expect(await studioAccess(d, DID)).toMatchObject({ allowed: true, hasAttachedKey: false });
  });
});
