import { describe, expect, it, vi } from "vitest";
import {
  createAppDocOwnerResolver,
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
    const result = await sweepAppDocumentProtection({
      perm,
      listAppDocumentIds: async () => ["a1", "broken", "studio", "orphan"],
      ownerFor: createAppDocOwnerResolver(async (id) => (id === "a1" ? "0xOwner" : null), "0xstudio"),
      logger: { warn, info: vi.fn() },
    });
    expect(result).toStrictEqual({ protected: 3, failed: 1, skipped: 0 });
    expect(rows.get("a1")).toMatchObject({ protected: true, owner: "0xowner" });
    expect(rows.get("studio")).toMatchObject({ protected: true, owner: "0xstudio" });
    expect(rows.get("orphan")).toMatchObject({ protected: true, owner: "0xstudio" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
  });

  it("skips a document with no owner to protect with, and never throws on a listing failure", async () => {
    const { perm } = fakePerm();
    const log = { warn: vi.fn(), info: vi.fn() };
    expect(
      await sweepAppDocumentProtection({
        perm, listAppDocumentIds: async () => ["x"], ownerFor: async () => null, logger: log,
      }),
    ).toStrictEqual({ protected: 0, failed: 0, skipped: 1 });
    await expect(
      sweepAppDocumentProtection({
        perm, listAppDocumentIds: async () => { throw new Error("reactor down"); },
        ownerFor: async () => "0xa", logger: log,
      }),
    ).resolves.toStrictEqual({ protected: 0, failed: 0, skipped: 0 });
  });
});

describe("createAppDocProtector", () => {
  it("protects with the row owner, and refuses when there is no owner", async () => {
    const { perm, rows } = fakePerm();
    await createAppDocProtector(perm, async () => "0xowner")("d");
    expect(rows.get("d")).toMatchObject({ protected: true, owner: "0xowner" });
    await expect(createAppDocProtector(perm, async () => null)("e")).rejects.toThrow(/no owner/);
  });
});

describe("createReactorAppDocStore", () => {
  it("protects the document right after creating it", async () => {
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
    expect(order).toStrictEqual(["create", "protect app-1"]);
  });
});
