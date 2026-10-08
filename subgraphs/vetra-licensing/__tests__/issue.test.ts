import { describe, expect, it, vi } from "vitest";
import type { Action } from "document-model";
import {
  AlreadyHoldsError,
  LicenceNotUpgradableError,
  TermNotIssuableError,
  issueLicense,
  sameHolder,
  type IssueDeps,
} from "../issue.js";
import { grantLicense, replaceGrant } from "../issuers/publisher-grant.js";
import { NotOnAllowListError, UnknownLicenseError } from "../publisher-errors.js";
import { UnsupportedDidError } from "../did.js";
import type { AppDocView } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const NOW = "2026-10-08T10:00:00.000Z";

const app: AppDocView = {
  id: "app-1", name: "KV", slug: "kv", owner: "0xowner", status: "ACTIVE", identityDid: null,
  productionEnvironmentId: null, templates: [], artifacts: [],
  terms: [
    { id: "k1", kind: "pro", label: null, templateId: "t", validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"], status: "ACTIVE" },
    { id: "k2", kind: "free", label: null, templateId: "t", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
    { id: "k3", kind: "retired", label: null, templateId: "t", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "RETIRED" },
    { id: "k4", kind: "codes-only", label: null, templateId: "t", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "k5", kind: "draft", label: null, templateId: "t", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "DRAFT" },
  ],
  tampered: false, tamperReason: null, licensingStateHash: "h", unverified: false,
};

const lic = (over: Partial<LicenceRecord>): LicenceRecord => ({
  id: "old", app: "app-1", user: DID, kind: "free", issuer: "PUBLISHER_GRANT", status: "ACTIVE",
  issued: "2026-01-01T00:00:00.000Z", start: "2026-01-01T00:00:00.000Z", end: null, stage: "env-7",
  details: null, replacedBy: null, legacyLicenseTypeId: null, ...over,
});

/** app-2 has a document but no `apps` row: untrusted. app-3 is tampered. */
const DOCS: Record<string, AppDocView> = {
  "app-1": app,
  "app-2": { ...app, id: "app-2" },
  "app-3": { ...app, id: "app-3", tampered: true, tamperReason: "licensing state changed outside Vetra" },
};
const ROWS = new Set(["app-1", "app-3"]);

/**
 * Stateful fakes: issued licences become readable, REPLACE_LICENSE marks the
 * predecessor, and the chain/provenance rows are kept, so double submits and
 * chain heads behave as against the real store.
 */
function harness(
  initial: LicenceRecord[] = [],
  opts: { allowed?: boolean; replaceFails?: boolean; linkFails?: boolean; delayMs?: number } = {},
) {
  const licences = initial.map((l) => ({ ...l }));
  const executed: { id: string; actions: Action[] }[] = [];
  const created: string[] = [];
  // "old" sits in a chain rooted at root-0 and is authorised.
  const chain = new Map<string, string>([["old", "root-0"]]);
  const authorised = new Set<string>(["old"]);
  const deps = {
    owners: {
      findAppById: async (id: string) =>
        ROWS.has(id) ? { id, name: "KV", status: "ACTIVE", owner_address: "0xowner" } : null,
    },
    apps: { app: async (id: string) => DOCS[id] ?? null },
    licence: async (id: string) => licences.find((l) => l.id === id) ?? null,
    createLicenseDocument: async () => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const id = `lic-${created.length + 1}`;
      created.push(id);
      return id;
    },
    executeLicence: vi.fn(async (id: string, actions: Action[]) => {
      if (opts.replaceFails && actions[0]?.type === "REPLACE_LICENSE") throw new Error("boom");
      executed.push({ id, actions });
      if (actions[0]?.type === "REPLACE_LICENSE") {
        const prev = licences.find((l) => l.id === id);
        if (prev) prev.status = "REPLACED";
      }
      if (actions[0]?.type === "ISSUE_LICENSE") {
        const input = actions[0].input as { app: string; user: string; kind: string };
        licences.push(lic({ id, app: input.app, user: input.user, kind: input.kind, status: "ACTIVE" }));
      }
    }),
    grants: {
      recordGrant: vi.fn(async (r: { licenseId: string }) => { authorised.add(r.licenseId); }),
      linkChain: vi.fn(async (r: { licenseId: string; rootLicenseId: string }) => {
        if (opts.linkFails) throw new Error("db down");
        chain.set(r.licenseId, r.rootLicenseId);
      }),
      chainRootOf: async (id: string) => chain.get(id) ?? id,
      chainHead: async (root: string) =>
        [...chain].filter(([id, r]) => r === root && authorised.has(id)).at(-1)?.[0] ?? root,
      isOnAllowList: async () => opts.allowed ?? true,
    },
    logger: { warn: vi.fn() },
  } satisfies IssueDeps & { grants: { isOnAllowList: unknown } };
  return { deps, executed, created, licences };
}

describe("issueLicense", () => {
  it("issues and activates in one batch, with end from validityDays, and records provenance + chain", async () => {
    const h = harness();
    const out = await issueLicense(h.deps, { appId: "app-1", user: ADDR.toUpperCase().replace("0X", "0x"), kind: "pro", issuer: "PUBLISHER_GRANT", details: { grantedBy: "0xowner" }, issuedBy: "0xOwner", label: "Project A", now: NOW });
    expect(out).toStrictEqual({ licenseId: "lic-1", user: DID, end: "2026-11-07T10:00:00.000Z", replaced: null });
    expect(h.executed).toHaveLength(1);
    const [issue, activate] = h.executed[0]!.actions;
    expect(issue!.type).toBe("ISSUE_LICENSE");
    expect(issue!.input).toMatchObject({ app: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", stage: null, issued: NOW, start: NOW, end: "2026-11-07T10:00:00.000Z" });
    expect(JSON.parse((issue!.input as { details: string }).details)).toStrictEqual({ grantedBy: "0xowner", issuedBy: "0xowner" });
    expect(activate!.type).toBe("ACTIVATE_LICENSE");
    expect(h.deps.grants.recordGrant).toHaveBeenCalledWith({ licenseId: "lic-1", appId: "app-1", kind: "pro", userDid: DID, issuedBy: "0xOwner", now: NOW });
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith({ licenseId: "lic-1", rootLicenseId: "lic-1", appId: "app-1", label: "Project A", now: NOW });
  });

  it("links the chain before recording provenance", async () => {
    const h = harness();
    await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW });
    expect(h.deps.grants.linkChain.mock.invocationCallOrder[0]!)
      .toBeLessThan(h.deps.grants.recordGrant.mock.invocationCallOrder[0]!);
  });

  it("records no provenance when linking the chain fails", async () => {
    const h = harness([], { linkFails: true });
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW })).rejects.toThrow("db down");
    expect(h.deps.grants.recordGrant).not.toHaveBeenCalled();
  });

  it("leaves end open for an open-ended term", async () => {
    const h = harness();
    const out = await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "free", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW });
    expect(out.end).toBeNull();
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ label: null }));
  });

  it.each([
    ["unknown app", { appId: "nope" }],
    ["app with a document but no apps row", { appId: "app-2" }],
    ["tampered app", { appId: "app-3" }],
    ["unknown kind", { kind: "nope" }],
    ["retired term", { kind: "retired" }],
    ["draft term", { kind: "draft" }],
    ["issuer not allowed", { kind: "codes-only" }],
  ])("refuses %s before creating anything", async (_n, over) => {
    const h = harness();
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW, ...over })).rejects.toBeInstanceOf(TermNotIssuableError);
    expect(h.created).toStrictEqual([]);
  });

  it("refuses a non-pkh DID before creating anything", async () => {
    const h = harness();
    await expect(issueLicense(h.deps, { appId: "app-1", user: "did:key:z6Mk", kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", now: NOW })).rejects.toBeInstanceOf(UnsupportedDidError);
    expect(h.created).toStrictEqual([]);
  });

  it("upgrades in place: inherits stage, joins the chain, replaces the ACTIVE predecessor", async () => {
    const h = harness([lic({})]);
    const out = await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW });
    expect(out.replaced).toBe("old");
    expect(h.executed[0]!.actions[0]!.input).toMatchObject({ stage: "env-7" });
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ licenseId: "lic-1", rootLicenseId: "root-0" }));
    expect(h.executed[1]).toStrictEqual({ id: "old", actions: [expect.objectContaining({ type: "REPLACE_LICENSE", input: { replacedBy: "lic-1" } })] });
  });

  it.each(["EXPIRED", "REVOKED"] as const)("re-licenses a %s chain without touching the terminal predecessor", async (status) => {
    const h = harness([lic({ status })]);
    const out = await issueLicense(h.deps, { appId: "app-1", user: DID, kind: "free", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW });
    expect(out.replaced).toBe("old");
    expect(h.executed).toHaveLength(1);
    expect(h.deps.grants.linkChain).toHaveBeenCalledWith(expect.objectContaining({ rootLicenseId: "root-0" }));
  });

  it("matches a legacy 0x holder on the predecessor", async () => {
    const h = harness([lic({ user: ADDR })]);
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW })).resolves.toMatchObject({ replaced: "old" });
  });

  it("keeps the new licence when replacing the predecessor fails, and says so", async () => {
    const h = harness([lic({})], { replaceFails: true });
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW })).resolves.toMatchObject({ licenseId: "lic-1" });
    expect(h.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not mark old REPLACED"));
  });

  it.each([
    ["missing predecessor", [], UnknownLicenseError],
    ["another holder's licence", [lic({ user: "did:pkh:eip155:1:0x2222222222222222222222222222222222222222" })], UnknownLicenseError],
    ["another app's licence", [lic({ app: "app-2" })], UnknownLicenseError],
    ["a REPLACED predecessor", [lic({ status: "REPLACED" })], LicenceNotUpgradableError],
    ["an ISSUED predecessor", [lic({ status: "ISSUED" })], LicenceNotUpgradableError],
    ["the same kind, still ACTIVE", [lic({ kind: "pro" })], AlreadyHoldsError],
  ])("refuses an upgrade of %s", async (_n, licences, error) => {
    const h = harness(licences as LicenceRecord[]);
    await expect(issueLicense(h.deps, { appId: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW })).rejects.toBeInstanceOf(error);
    expect(h.created).toStrictEqual([]);
  });
});

describe("upgrading a chain", () => {
  const upgrade = (h: ReturnType<typeof harness>, kind: string) =>
    issueLicense(h.deps, { appId: "app-1", user: DID, kind, issuer: "PUBLISHER_GRANT", details: {}, issuedBy: "x", upgrades: "old", now: NOW });

  it("refuses to upgrade a licence that is no longer the head of its chain", async () => {
    const h = harness([lic({ status: "EXPIRED" })]);
    await upgrade(h, "pro");
    await expect(upgrade(h, "free")).rejects.toBeInstanceOf(LicenceNotUpgradableError);
    expect(h.created).toStrictEqual(["lic-1"]);
  });

  it("ignores an inert successor (chain row, no provenance) when finding the head", async () => {
    const h = harness([lic({ status: "EXPIRED" })]);
    h.deps.grants.recordGrant.mockRejectedValueOnce(new Error("db down"));
    await expect(upgrade(h, "pro")).rejects.toThrow("db down");
    await expect(upgrade(h, "pro")).resolves.toMatchObject({ licenseId: "lic-2", replaced: "old" });
  });

  it.each(["ACTIVE", "EXPIRED"] as const)("a double-submitted upgrade of an %s licence creates one successor", async (status) => {
    const h = harness([lic({ status })], { delayMs: 5 });
    const results = await Promise.allSettled([upgrade(h, "pro"), upgrade(h, "pro")]);
    expect(results.map((r) => r.status).sort()).toStrictEqual(["fulfilled", "rejected"]);
    expect(h.created).toStrictEqual(["lic-1"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LicenceNotUpgradableError);
  });
});

describe("sameHolder", () => {
  it("compares wallets across spellings and chains, and is false for anything unparseable", () => {
    expect(sameHolder(ADDR, `did:pkh:eip155:137:${ADDR.toUpperCase().replace("0X", "0x")}`)).toBe(true);
    expect(sameHolder(DID, "did:pkh:eip155:1:0x2222222222222222222222222222222222222222")).toBe(false);
    expect(sameHolder("did:key:z6Mk", "did:key:z6Mk")).toBe(false);
  });
});

describe("publisher grant issuer", () => {
  it("refuses a holder not on the allow list", async () => {
    const h = harness([], { allowed: false });
    await expect(grantLicense(h.deps, { appId: "app-1", kind: "pro", user: ADDR, issuedBy: "0xowner", label: null, now: NOW })).rejects.toBeInstanceOf(NotOnAllowListError);
    expect(h.created).toStrictEqual([]);
  });
  it("grants with the grantor in details", async () => {
    const h = harness();
    expect(await grantLicense(h.deps, { appId: "app-1", kind: "pro", user: ADDR, issuedBy: "0xOwner", label: null, now: NOW })).toBe("lic-1");
    expect(JSON.parse((h.executed[0]!.actions[0]!.input as { details: string }).details)).toMatchObject({ grantedBy: "0xowner" });
  });
  it("replaces a holder's licence in place", async () => {
    const h = harness([lic({})]);
    expect(await replaceGrant(h.deps, { licenseId: "old", kind: "pro", issuedBy: "0xowner", now: NOW })).toBe("lic-1");
    expect(JSON.parse((h.executed[0]!.actions[0]!.input as { details: string }).details)).toMatchObject({ grantedBy: "0xowner", replaces: "old" });
    expect(h.executed[1]!.actions[0]!.type).toBe("REPLACE_LICENSE");
  });
  it("refuses to replace a missing licence", async () => {
    await expect(replaceGrant(harness().deps, { licenseId: "nope", kind: "pro", issuedBy: "x", now: NOW })).rejects.toBeInstanceOf(UnknownLicenseError);
  });
});
