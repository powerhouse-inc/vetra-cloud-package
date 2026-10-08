import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import {
  InvalidCodeError,
  createInviteCode,
  findRedemption,
  listInviteCodes,
  setInviteCodeActive,
} from "../invite-codes.js";
import { AlreadyHoldsError, TermNotIssuableError } from "../issue.js";
import { UnsupportedDidError } from "../did.js";
import { UnknownLicenseError } from "../publisher-errors.js";
import { redeemInviteCode, type InviteCodeIssuerDeps } from "../issuers/invite-code.js";
import type { AppDocView } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const NOW = "2026-10-08T00:00:00.000Z";
const tpl = (id: string, mode: "SHARED" | "DEDICATED") => ({
  id, name: null, mode, sharedEnvironment: null, templateHash: "h", resolutionError: null,
  template: { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null },
});
const app: AppDocView = {
  id: "app-1", name: "KV", slug: "kv", owner: "0xo", status: "ACTIVE", identityDid: null,
  productionEnvironmentId: "env-prod", artifacts: [],
  templates: [tpl("ded", "DEDICATED"), tpl("sh", "SHARED")],
  terms: [
    { id: "a", kind: "pro", label: null, templateId: "ded", validityDays: 30, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "b", kind: "free", label: null, templateId: "sh", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "c", kind: "grant-only", label: null, templateId: "ded", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
  ],
  tampered: false, tamperReason: null, licensingStateHash: "h", unverified: false,
};

const lic = (over: Partial<LicenceRecord>): LicenceRecord => ({
  id: "x", app: "app-1", user: DID, kind: "free", issuer: "INVITE_CODE", status: "ACTIVE",
  issued: null, start: null, end: null, stage: null, details: null, replacedBy: null,
  legacyLicenseTypeId: null, ...over,
});

let db: Kysely<VetraLicensingDB>;
let deps: InviteCodeIssuerDeps;
let active: LicenceRecord[];
let created: number;
let createFails: number;
let delayMs: number;

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  active = [];
  created = 0;
  createFails = 0;
  delayMs = 0;
  deps = {
    db,
    owners: {
      findAppById: async (id) =>
        id === "app-1" ? { id, name: "KV", status: "ACTIVE", owner_address: "0xo" } as never : null,
    },
    apps: { app: async (id) => (id === "app-1" ? app : null) },
    licence: async () => null,
    createLicenseDocument: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (createFails > 0) {
        createFails -= 1;
        throw new Error("reactor down");
      }
      return `lic-${++created}`;
    },
    executeLicence: vi.fn(async () => {}),
    grants: {
      recordGrant: vi.fn(async () => {}),
      linkChain: vi.fn(async () => {}),
      chainRootOf: async (id) => id,
      chainHead: async (id) => id,
      grantFor: async () => null,
    },
    lifecycle: { entry: async () => null, record: vi.fn(async () => {}) },
    activeLicencesOf: async () => active,
    logger: { warn: vi.fn() },
  };
  const c = (code: string, kind: string, maxUses: number | null = null) =>
    createInviteCode(db, { appId: "app-1", kind, code, label: null, expiresAt: null, maxUses, anthropicKeyCiphertext: null, now: NOW });
  await c("dedicated", "pro", 1);
  await c("shared-code", "free");
  await c("wrong-issuer", "grant-only");
  await c("uncapped", "pro");
});
afterEach(async () => {
  await db.destroy();
});

const redeem = (code: string, over: Partial<Parameters<typeof redeemInviteCode>[1]> = {}) =>
  redeemInviteCode(deps, { code, user: DID, label: null, upgrades: null, now: NOW, ...over });

describe("redeemInviteCode", () => {
  it("issues a licence for the code's term and records the redemption", async () => {
    const out = await redeem(" dedicated ", { label: "My vault" });
    expect(out).toStrictEqual({ licenseId: "lic-1", appId: "app-1", fresh: true });
    expect(await findRedemption(db, "dedicated", DID)).toMatchObject({ license_id: "lic-1", access_expires: "2026-11-07T00:00:00.000Z" });
    expect(deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ label: "My vault" }));
    expect(deps.grants.recordGrant).toHaveBeenCalledWith(expect.objectContaining({ kind: "pro", userDid: DID }));
  });

  it("keys the redemption on the normalised DID, whatever spelling the caller used", async () => {
    await redeem("dedicated", { user: "did:pkh:eip155:137:0x1111111111111111111111111111111111111111" });
    expect(await findRedemption(db, "dedicated", DID)).toMatchObject({ license_id: "lic-1" });
  });

  it("is idempotent for the same caller and code, even once the code is exhausted", async () => {
    await redeem("dedicated");
    const again = await redeem("dedicated", { user: "0x1111111111111111111111111111111111111111" });
    expect(again).toStrictEqual({ licenseId: "lic-1", appId: "app-1", fresh: false });
    expect(created).toBe(1);
  });

  it("is idempotent under concurrent redeems by the same caller", async () => {
    delayMs = 20;
    const [a, b] = await Promise.all([redeem("uncapped"), redeem("uncapped")]);
    expect(created).toBe(1);
    expect([a.licenseId, b.licenseId]).toStrictEqual(["lic-1", "lic-1"]);
    expect([a.fresh, b.fresh].sort((x, y) => Number(x) - Number(y))).toStrictEqual([false, true]);
  });

  it("refuses an exhausted code for another caller with INVALID_CODE", async () => {
    await redeem("dedicated");
    await expect(redeem("dedicated", { user: OTHER })).rejects.toThrow(new InvalidCodeError());
  });

  it("lets exactly one of two concurrent callers take a code's last use", async () => {
    delayMs = 20;
    const results = await Promise.allSettled([redeem("dedicated"), redeem("dedicated", { user: OTHER })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(InvalidCodeError);
    expect(created).toBe(1);
  });

  it("refuses unknown, differently cased, inactive and expired codes with the same error", async () => {
    await createInviteCode(db, { appId: "app-1", kind: "pro", code: "expired-code", label: null, expiresAt: "2026-01-01T00:00:00Z", maxUses: null, anthropicKeyCiphertext: null, now: NOW });
    await setInviteCodeActive(db, "app-1", "shared-code", false);
    for (const code of ["nope", "DEDICATED", "shared-code", "expired-code"]) {
      await expect(redeem(code)).rejects.toThrow(new InvalidCodeError());
    }
    expect(created).toBe(0);
  });

  it("refuses an unsupported DID before touching the code", async () => {
    await expect(redeem("dedicated", { user: "did:key:z6Mk" })).rejects.toBeInstanceOf(UnsupportedDidError);
    expect((await listInviteCodes(db, "app-1")).find((c) => c.code === "dedicated")!.redemptions).toBe(0);
  });

  it("refuses a SHARED kind the caller already holds", async () => {
    active = [lic({ kind: "free" })];
    await expect(redeem("shared-code")).rejects.toBeInstanceOf(AlreadyHoldsError);
    expect(await findRedemption(db, "shared-code", DID)).toBeNull();
  });

  it("refuses an unusable SHARED code with INVALID_CODE even to a holder of its kind", async () => {
    active = [lic({ kind: "free" })];
    await setInviteCodeActive(db, "app-1", "shared-code", false);
    await expect(redeem("shared-code")).rejects.toThrow(new InvalidCodeError());
  });

  it("does not issue twice when another replica reserved for the same holder first", async () => {
    // The other replica's redeem lands between this one's read and its reserve.
    deps.apps = {
      app: async (id) => {
        await db.insertInto("invite_redemptions").values({ code: "uncapped", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: "lic-other" }).execute();
        return id === "app-1" ? app : null;
      },
    };
    await expect(redeem("uncapped")).resolves.toStrictEqual({ licenseId: "lic-other", appId: "app-1", fresh: false });
    expect(created).toBe(0);
  });

  it("refuses with INVALID_CODE when another replica's reservation has no licence yet", async () => {
    deps.apps = {
      app: async (id) => {
        await db.insertInto("invite_redemptions").values({ code: "uncapped", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
        return id === "app-1" ? app : null;
      },
    };
    await expect(redeem("uncapped")).rejects.toThrow(new InvalidCodeError());
    expect(created).toBe(0);
  });

  it("attaches the licence instead of releasing when it exists despite the issue error", async () => {
    deps.executeLicence = vi.fn(async () => {
      active = [lic({ id: "lic-1", kind: "pro", details: JSON.stringify({ code: "dedicated" }) })];
      throw new Error("timeout after apply");
    });
    await expect(redeem("dedicated")).resolves.toStrictEqual({ licenseId: "lic-1", appId: "app-1", fresh: true });
    expect(await findRedemption(db, "dedicated", DID)).toMatchObject({ license_id: "lic-1" });
  });

  it("releases when the post-failure lookup fails too, and never logs the code", async () => {
    createFails = 1;
    let calls = 0;
    deps.activeLicencesOf = async () => {
      calls += 1;
      throw new Error("reads down");
    };
    const release = vi.spyOn(db, "deleteFrom").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(redeem("dedicated")).rejects.toThrow("reactor down");
    release.mockRestore();
    expect(calls).toBe(1);
    const logged = vi.mocked(deps.logger.warn).mock.calls.map((c) => String(c[0])).join("\n");
    // Nothing derived from the code either: a hash of a human-chosen code reverses.
    expect(logged).toContain("invite-code");
    expect(logged).not.toMatch(/code#|dedicated/);
  });

  it("redeems a migrated legacy code however it is cased or padded, and a new code only exactly", async () => {
    await db.insertInto("invite_codes").values({
      code: "cohort-1", app_id: "app-1", kind: "free", label: null, active: true, expires_at: null, max_uses: null,
      anthropic_key_ciphertext: null, created_at: NOW, legacy_case_insensitive: true,
    }).execute();
    const legacy = await redeemInviteCode(deps, { code: "  Cohort-1 ", user: DID, label: null, upgrades: null, now: NOW });
    expect(legacy).toMatchObject({ appId: "app-1", fresh: true });
    expect(await findRedemption(db, "cohort-1", DID)).toMatchObject({ license_id: legacy.licenseId });
    // A code created here is exactly case-sensitive.
    await createInviteCode(db, { appId: "app-1", kind: "pro", code: "NewCode-2026", label: null, expiresAt: null, maxUses: null, anthropicKeyCiphertext: null, now: NOW });
    await expect(
      redeemInviteCode(deps, { code: "newcode-2026", user: DID, label: null, upgrades: null, now: NOW }),
    ).rejects.toBeInstanceOf(InvalidCodeError);
  });

  it("lets a caller hold a DEDICATED kind more than once", async () => {
    active = [lic({ kind: "pro" })];
    await expect(redeem("uncapped")).resolves.toMatchObject({ fresh: true });
  });

  it("leaves the SHARED check to issueLicense when the caller upgrades", async () => {
    active = [lic({ kind: "free" })];
    // issueLicense looks the predecessor up; this one does not exist.
    await expect(redeem("shared-code", { upgrades: "missing" })).rejects.toBeInstanceOf(UnknownLicenseError);
    expect(await findRedemption(db, "shared-code", DID)).toBeNull();
  });

  it("releases the reservation when issuing fails, so the cap is not consumed", async () => {
    await expect(redeem("wrong-issuer")).rejects.toBeInstanceOf(TermNotIssuableError);
    expect(await findRedemption(db, "wrong-issuer", DID)).toBeNull();

    createFails = 1;
    await expect(redeem("dedicated")).rejects.toThrow("reactor down");
    expect(await findRedemption(db, "dedicated", DID)).toBeNull();
    // The single use is still there for someone else.
    await expect(redeem("dedicated", { user: OTHER })).resolves.toMatchObject({ fresh: true });
  });

  it("completes a reservation left behind by a crashed redeem", async () => {
    await db.insertInto("invite_redemptions").values({ code: "dedicated", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
    const out = await redeem("dedicated");
    expect(out.fresh).toBe(true);
    expect((await findRedemption(db, "dedicated", DID))!.license_id).toBe("lic-1");
  });

  it("completes a crashed reservation even after the code was paused", async () => {
    await db.insertInto("invite_redemptions").values({ code: "uncapped", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
    await setInviteCodeActive(db, "app-1", "uncapped", false);
    await expect(redeem("uncapped")).resolves.toMatchObject({ licenseId: "lic-1", fresh: true });
  });

  it("attaches the licence a crashed redeem already issued instead of issuing another", async () => {
    await db.insertInto("invite_redemptions").values({ code: "dedicated", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
    active = [
      lic({ id: "other-code", kind: "pro", details: JSON.stringify({ code: "uncapped" }) }),
      lic({ id: "earlier", kind: "pro", end: "2026-11-07T00:00:00.000Z", details: JSON.stringify({ code: "dedicated", issuedBy: "x" }) }),
    ];
    const out = await redeem("dedicated");
    expect(out).toStrictEqual({ licenseId: "earlier", appId: "app-1", fresh: false });
    expect(created).toBe(0);
    expect(await findRedemption(db, "dedicated", DID)).toMatchObject({ license_id: "earlier", access_expires: "2026-11-07T00:00:00.000Z" });
  });

  it("refuses to complete a crashed SHARED reservation the caller meanwhile holds, and gives the use back", async () => {
    await db.insertInto("invite_redemptions").values({ code: "shared-code", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
    active = [lic({ kind: "free", details: JSON.stringify({ code: "another-code" }) })];
    await expect(redeem("shared-code")).rejects.toBeInstanceOf(AlreadyHoldsError);
    expect(await findRedemption(db, "shared-code", DID)).toBeNull();
  });

  it("reports the issue failure even when giving the use back fails too", async () => {
    createFails = 1;
    const release = vi.spyOn(db, "deleteFrom").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(redeem("dedicated")).rejects.toThrow("reactor down");
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not release an invite-code reservation"));
    release.mockRestore();
    // The reservation left behind is completed by the retry.
    await expect(redeem("dedicated")).resolves.toMatchObject({ licenseId: "lic-1", fresh: true });
  });

  it("ignores unreadable licence details when looking for a crashed redeem's licence", async () => {
    await db.insertInto("invite_redemptions").values({ code: "dedicated", user_did: DID, redeemed_at: NOW, access_expires: null, license_id: null }).execute();
    active = [lic({ id: "junk", kind: "pro", details: "{not json" }), lic({ id: "plain", kind: "pro", details: "\"dedicated\"" })];
    await expect(redeem("dedicated")).resolves.toMatchObject({ licenseId: "lic-1", fresh: true });
  });
});
