import { describe, expect, it, vi } from "vitest";
import { createAppReads, parseAppDocument, resolveKind, APP_DOC_TYPE } from "../app-reads.js";

const appDoc = (id: string, global: Record<string, unknown>) => ({
  header: { id, documentType: APP_DOC_TYPE },
  state: { global },
});

const KV = appDoc("app-kv", {
  name: "Knowledge Vault", slug: "knowledge-vault", owner: "0xowner", status: "ACTIVE",
  identity: { did: "did:key:zApp", expiresAt: null },
  productionEnvironmentId: "env-prod",
  artifacts: [{
    id: "FUSION_IMAGE:kv", kind: "FUSION_IMAGE", name: "kv",
    versions: [{ version: "1.2.0", reference: "cr.vetra.io/p/kv:1.2.0" }],
    channels: [{ channel: "LATEST", version: "1.2.0" }],
  }],
  templates: [
    { id: "t-pro", name: "Pro", mode: "DEDICATED", sharedEnvironment: null,
      services: [{ id: "s1", type: "FUSION", prefix: "kv", artifactName: "kv", artifactChannel: "LATEST" }],
      packages: [{ id: "p1", packageName: "@kv/pkg", version: null }],
      size: null, baseDomain: null, packageRegistry: null },
    { id: "t-free", name: null, mode: "SHARED", sharedEnvironment: null, services: [], packages: [],
      size: null, baseDomain: null, packageRegistry: null },
    { id: "t-broken", name: null, mode: "DEDICATED", sharedEnvironment: null,
      services: [{ id: "s", type: "FUSION", prefix: null, artifactName: "gone", artifactChannel: "LATEST" }],
      packages: [], size: null, baseDomain: null, packageRegistry: null },
  ],
  terms: [
    { id: "k1", kind: "2026-pro", label: "Pro", templateId: "t-pro", validityDays: 30, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
    { id: "k2", kind: "2026-free", label: null, templateId: "t-free", validityDays: null, issuers: ["INVITE_CODE"], status: "RETIRED" },
    { id: "k3", kind: "draft", label: null, templateId: "t-pro", validityDays: null, issuers: [], status: "DRAFT" },
    { id: "k4", kind: "orphan", label: null, templateId: "t-deleted", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
    { id: "k5", kind: "broken", label: null, templateId: "t-broken", validityDays: null, issuers: ["INVITE_CODE"], status: "ACTIVE" },
  ],
});

describe("parseAppDocument", () => {
  it("keeps artifact references on template services and resolves them", () => {
    const app = parseAppDocument(KV)!;
    const pro = app.templates.find((t) => t.id === "t-pro")!;
    expect(pro.template.services[0]).toMatchObject({
      artifactName: "kv", artifactChannel: "LATEST",
      resolvedVersion: "1.2.0", resolvedRepository: "cr.vetra.io/p/kv",
    });
    expect(pro.resolutionError).toBeNull();
    expect(pro.templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports an unresolvable artifact instead of throwing", () => {
    const broken = parseAppDocument(KV)!.templates.find((t) => t.id === "t-broken")!;
    expect(broken.resolutionError).toMatch(/has not published/);
  });

  it("treats a pre-licensing app document as having no templates or terms", () => {
    const app = parseAppDocument(appDoc("old", { status: "ACTIVE", artifacts: [] }))!;
    expect(app.templates).toStrictEqual([]);
    expect(app.terms).toStrictEqual([]);
  });

  it("refuses something that is not an app document", () => {
    expect(parseAppDocument({ header: { id: "x", documentType: "powerhouse/app-owner-license" }, state: { global: {} } })).toBeNull();
    expect(parseAppDocument(null)).toBeNull();
  });
});

describe("resolveKind", () => {
  const app = parseAppDocument(KV)!;
  it("resolves a DEDICATED term with its label", () => {
    const r = resolveKind(app, "2026-pro");
    expect(r).toMatchObject({ ok: true, stage: null, label: "Pro" });
  });
  it("resolves a RETIRED SHARED term to the App Environment", () => {
    expect(resolveKind(app, "2026-free")).toMatchObject({ ok: true, stage: "env-prod", label: "2026-free" });
  });
  it.each([
    [null, "licence has no kind"],
    ["nope", "kind nope is not a term of app app-kv"],
    ["draft", "term draft is DRAFT"],
    ["orphan", "term orphan points at missing template t-deleted"],
  ])("refuses %s", (kind, reason) => {
    expect(resolveKind(app, kind)).toStrictEqual({ ok: false, reason });
  });
  it("refuses a DEDICATED template whose artifacts do not resolve", () => {
    const r = resolveKind(app, "broken");
    expect(r.ok).toBe(false);
  });
});

describe("createAppReads", () => {
  const docs = [KV, appDoc("app-other", { slug: "other", owner: "0xOWNER", status: "ACTIVE" })];
  const parents: Record<string, string[]> = {};
  const client = {
    async find() { return { results: docs }; },
    async getIncomingRelationships(id: string) {
      return { results: (parents[id] ?? []).map((p) => ({ header: { id: p } })) };
    },
    async get(id: string) {
      const d = docs.find((x) => x.header.id === id);
      if (!d) { const e = new Error(`Document not found: ${id}`); throw e; }
      return d;
    },
  };
  const reads = createAppReads(client, {
    trustedIds: async () => new Set(["app-kv", "app-other"]),
  });
  it("gets by id, null when missing", async () => {
    expect((await reads.app("app-kv"))?.name).toBe("Knowledge Vault");
    expect(await reads.app("missing")).toBeNull();
  });
  it("rethrows a read error that is not not-found", async () => {
    const failing = createAppReads({ ...client, get: async () => { throw new Error("connection reset"); } });
    await expect(failing.app("app-kv")).rejects.toThrow("connection reset");
  });
  it("finds by slug among trusted ids", async () => {
    expect((await reads.appBySlug("other"))?.id).toBe("app-other");
    expect(await reads.appBySlug("nope")).toBeNull();
  });
  it("ignores an untrusted document claiming a trusted app's slug", async () => {
    const forged = appDoc("forged", { slug: "knowledge-vault", owner: "0xattacker", status: "ACTIVE" });
    const r = createAppReads(
      { ...client, find: async () => ({ results: [forged, ...docs] }) },
      { trustedIds: async () => new Set(["app-kv"]) },
    );
    expect((await r.appBySlug("knowledge-vault"))?.id).toBe("app-kv");
  });
  it("refuses an ambiguous slug shared by two trusted apps, and logs", async () => {
    const twin = appDoc("app-twin", { slug: "knowledge-vault", status: "ACTIVE" });
    const warn = vi.fn();
    const r = createAppReads(
      { ...client, find: async () => ({ results: [twin, ...docs] }) },
      { trustedIds: async () => new Set(["app-kv", "app-twin"]), logger: { warn, error: vi.fn() } },
    );
    expect(await r.appBySlug("knowledge-vault")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
  it("refuses to look up by slug without trusted ids", async () => {
    await expect(createAppReads(client).appBySlug("other")).rejects.toThrow(/trustedIds/);
  });
  it("lists every app document id, following the cursor", async () => {
    let calls = 0;
    const paged = createAppReads({
      ...client,
      find: async (_s: unknown, _v: unknown, p?: { cursor: string }) => {
        calls++;
        return p?.cursor === "0"
          ? { results: [docs[0], { header: { id: "lic", documentType: "powerhouse/app-owner-license" } }], nextCursor: "1" }
          : { results: [docs[1]] };
      },
    });
    expect(await paged.allIds()).toStrictEqual(["app-kv", "app-other"]);
    expect(calls).toBe(2);
  });
  it("flags an app document with a parent as tampered, and logs an error", async () => {
    parents["app-kv"] = ["attacker-drive"];
    try {
      const error = vi.fn();
      const r = createAppReads(client, { trustedIds: async () => new Set(["app-kv"]), logger: { warn: vi.fn(), error } });
      const app = (await r.app("app-kv"))!;
      expect(app).toMatchObject({ tampered: true, tamperReason: expect.stringContaining("attacker-drive") });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("TAMPERED"));
      expect((await r.appBySlug("knowledge-vault"))?.tampered).toBe(true);
      // Anything that provisions from it is held.
      expect(resolveKind(app, "2026-pro")).toStrictEqual({
        ok: false,
        reason: expect.stringContaining("app app-kv is tampered: has parent document(s) attacker-drive"),
      });
      expect((await r.app("app-other"))?.tampered).toBe(false);
    } finally {
      delete parents["app-kv"];
    }
  });
  it("propagates a failed relationship read: unknown integrity is not clean", async () => {
    const r = createAppReads({ ...client, getIncomingRelationships: async () => { throw new Error("relationship store down"); } });
    await expect(r.app("app-kv")).rejects.toThrow("relationship store down");
  });
});
