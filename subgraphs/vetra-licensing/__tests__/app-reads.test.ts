import { describe, expect, it } from "vitest";
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
  const client = {
    async find() { return { results: docs }; },
    async get(id: string) {
      const d = docs.find((x) => x.header.id === id);
      if (!d) { const e = new Error(`Document not found: ${id}`); throw e; }
      return d;
    },
  };
  const reads = createAppReads(client);
  it("gets by id, null when missing", async () => {
    expect((await reads.app("app-kv"))?.name).toBe("Knowledge Vault");
    expect(await reads.app("missing")).toBeNull();
  });
  it("finds by slug and by owner (case-insensitive)", async () => {
    expect((await reads.appBySlug("other"))?.id).toBe("app-other");
    expect((await reads.appsOwnedBy("0xowner")).map((a) => a.id).sort()).toStrictEqual(["app-kv", "app-other"]);
  });
});
