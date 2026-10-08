import { describe, expect, it, vi } from "vitest";
import {
  createAppDocOwnerResolver,
  detachAppDocumentParents,
  createAppDocProtector,
  protectAppDocument,
  sweepAppDocumentProtection,
  type DocProtectionService,
} from "../app-doc-protection.js";

/** In-memory DocumentPermissionService with reactor-api's semantics. */
function fakePerm(seed: Record<string, { protected: boolean; owner: string | null; grants: string[] }> = {}) {
  const rows = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v, grants: [...v.grants] }]));
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) { r = { protected: false, owner: null, grants: [] }; rows.set(id, r); }
    return r;
  };
  const perm: DocProtectionService & { failOn?: string } = {
    async getDocumentProtection(id) {
      if (id === perm.failOn) throw new Error(`db error on ${id}`);
      const r = rows.get(id);
      return { protected: r?.protected ?? false, ownerAddress: r?.owner ?? null };
    },
    async initializeDocumentProtection(id, owner) {
      const r = row(id);
      r.owner = owner.toLowerCase();
      if (!r.grants.includes(r.owner)) r.grants.push(r.owner);
    },
    async setDocumentProtection(id, p) { row(id).protected = p; },
    async getDocumentPermissions(id) {
      return (rows.get(id)?.grants ?? []).map((userAddress) => ({ userAddress }));
    },
    async revokePermission(id, user) {
      const r = row(id);
      r.grants = r.grants.filter((g) => g !== user);
    },
  };
  return { perm, rows };
}

/** In-memory relationship store: parent -> children. */
function fakeRel(seed: Record<string, string[]> = {}) {
  const parentsOf = new Map(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  return {
    parentsOf,
    async getIncomingRelationships(id: string, type: string) {
      expect(type).toBe("child");
      return { results: (parentsOf.get(id) ?? []).map((p) => ({ header: { id: p } })) };
    },
    async removeRelationship(source: string, target: string, type: string) {
      expect(type).toBe("child");
      parentsOf.set(target, (parentsOf.get(target) ?? []).filter((p) => p !== source));
    },
  };
}

describe("detachAppDocumentParents", () => {
  it("removes every incoming child relationship and warns with each source id", async () => {
    const rel = fakeRel({ app: ["drive-a", "drive-b"] });
    const warn = vi.fn();
    expect(await detachAppDocumentParents(rel, "app", { warn })).toBe(2);
    expect(rel.parentsOf.get("app")).toStrictEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("drive-a"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("drive-b"));
  });
});

describe("protectAppDocument", () => {
  it("protects, sets the owner, and revokes the creator's grant on a forged document", async () => {
    const { perm, rows } = fakePerm({ d: { protected: false, owner: "0xattacker", grants: ["0xattacker"] } });
    await protectAppDocument(perm, "d", "0xPlatform");
    expect(rows.get("d")).toStrictEqual({ protected: true, owner: "0xplatform", grants: ["0xplatform"] });
  });

  it("writes nothing to an already protected document with the right owner", async () => {
    const { perm } = fakePerm({ d: { protected: true, owner: "0xa", grants: ["0xa"] } });
    const init = vi.spyOn(perm, "initializeDocumentProtection");
    const revoke = vi.spyOn(perm, "revokePermission");
    await protectAppDocument(perm, "d", "0xA");
    expect(init).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("sweepAppDocumentProtection", () => {
  it("protects every app document and survives a failure on one", async () => {
    const { perm, rows } = fakePerm();
    perm.failOn = "broken";
    const warn = vi.fn();
    const rel = fakeRel({ a1: ["attacker-drive"] });
    const result = await sweepAppDocumentProtection({
      perm,
      relationships: rel,
      listAppDocumentIds: async () => ["a1", "broken", "studio", "orphan"],
      ownerFor: createAppDocOwnerResolver(async (id) => (id === "a1" ? "0xOwner" : null), "0xstudio"),
      logger: { warn, info: vi.fn() },
    });
    expect(result).toStrictEqual({ protected: 3, failed: 1, skipped: 0 });
    expect(rows.get("a1")).toMatchObject({ protected: true, owner: "0xowner" });
    expect(rows.get("studio")).toMatchObject({ protected: true, owner: "0xstudio" });
    expect(rows.get("orphan")).toMatchObject({ protected: true, owner: "0xstudio" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
    expect(rel.parentsOf.get("a1")).toStrictEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("attacker-drive"));
  });

  it("skips a document with no owner to protect with, and never throws on a listing failure", async () => {
    const { perm } = fakePerm();
    const log = { warn: vi.fn(), info: vi.fn() };
    expect(
      await sweepAppDocumentProtection({
        perm, relationships: fakeRel(), listAppDocumentIds: async () => ["x"], ownerFor: async () => null, logger: log,
      }),
    ).toStrictEqual({ protected: 0, failed: 0, skipped: 1 });
    await expect(
      sweepAppDocumentProtection({
        perm, relationships: fakeRel(), listAppDocumentIds: async () => { throw new Error("reactor down"); },
        ownerFor: async () => "0xa", logger: log,
      }),
    ).resolves.toStrictEqual({ protected: 0, failed: 0, skipped: 0 });
  });
});

describe("licence documents reuse the same protection", () => {
  it("sweeps licence documents under the platform owner, naming them in logs", async () => {
    const { perm, rows } = fakePerm({ "lic-1": { protected: false, owner: null, grants: ["0xforger"] } });
    const rel = fakeRel({ "lic-1": ["drive-x"] });
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = await sweepAppDocumentProtection({
      perm, relationships: rel, listAppDocumentIds: async () => ["lic-1"],
      ownerFor: async () => "0xplatform", logger, noun: "licence document",
    });
    expect(result).toStrictEqual({ protected: 1, failed: 0, skipped: 0 });
    expect(rows.get("lic-1")).toMatchObject({ protected: true, owner: "0xplatform", grants: ["0xplatform"] });
    expect(rel.parentsOf.get("lic-1")).toStrictEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("licence document lic-1 had parent drive-x"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("swept 1 licence documents"));
  });

  it("refuses to create a licence document it cannot protect", async () => {
    const { perm } = fakePerm();
    const protect = createAppDocProtector(perm, async () => null, fakeRel(), { warn: vi.fn() }, "licence document");
    await expect(protect("lic-2")).rejects.toThrow("no owner to protect licence document lic-2 with");
  });
});

describe("createAppDocProtector", () => {
  it("protects with the row owner, detaches parents, and refuses when there is no owner", async () => {
    const { perm, rows } = fakePerm();
    const rel = fakeRel({ d: ["racer"] });
    const log = { warn: vi.fn() };
    await createAppDocProtector(perm, async () => "0xowner", rel, log)("d");
    expect(rows.get("d")).toMatchObject({ protected: true, owner: "0xowner" });
    expect(rel.parentsOf.get("d")).toStrictEqual([]);
    await expect(createAppDocProtector(perm, async () => null, rel, log)("e")).rejects.toThrow(/no owner/);
  });
});

describe("createReactorAppDocStore", () => {
  it("exposes protect separately from create, so callers populate first", async () => {
    const { createReactorAppDocStore } = await import("../app-doc-store.js");
    const order: string[] = [];
    const store = createReactorAppDocStore(
      {
        create: async () => { order.push("create"); },
        execute: async () => undefined,
        get: async () => null,
        getOperations: async () => ({ results: [] }),
      },
      async (id) => { order.push(`protect ${id}`); },
    );
    await store.create("app-1");
    expect(order).toStrictEqual(["create"]);
    await store.protect?.("app-1");
    expect(order).toStrictEqual(["create", "protect app-1"]);
  });
});
