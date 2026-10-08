import { describe, expect, it } from "vitest";
import {
  createReactorLicenseReads,
  legacyLicenseTypeOf,
  type LicenseClientLike,
} from "../reads.js";
import { templateHash, type TemplateShape } from "../template.js";

const TEMPLATE = {
  services: [{ id: "s1", type: "CONNECT", prefix: "app" }],
  packages: [{ id: "p1", packageName: "@x/pkg", version: "1.2.3" }],
  size: null,
  baseDomain: "vetra.io",
  packageRegistry: "https://registry.example",
};

function license(
  id: string,
  g: Partial<Record<string, unknown>> = {},
): unknown {
  return {
    header: { id, documentType: "powerhouse/app-owner-license" },
    state: {
      global: {
        app: "app-1",
        licenseType: "lt-1",
        user: "0xABC",
        status: "ACTIVE",
        start: "2026-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
        ...g,
      },
    },
  };
}

function licenseType(id: string, g: Partial<Record<string, unknown>> = {}) {
  return {
    header: { id, documentType: "powerhouse/app-license-type" },
    state: {
      global: {
        app: "app-1",
        kind: "pro",
        label: "Pro",
        validityDays: 30,
        template: TEMPLATE,
        status: "ACTIVE",
        ...g,
      },
    },
  };
}

/** pages: per document type, an array of pages. Cursor is the page index. */
function fakeClient(
  pages: Record<string, unknown[][]>,
  byId: Record<string, unknown> = {},
): LicenseClientLike & { findCalls: string[] } {
  const findCalls: string[] = [];
  return {
    findCalls,
    async find(search, _view, paging) {
      const type = search.type as string;
      findCalls.push(`${type}@${paging?.cursor}`);
      const idx = Number(paging?.cursor ?? "0");
      const all = pages[type] ?? [[]];
      return {
        results: all[idx] ?? [],
        nextCursor: idx + 1 < all.length ? String(idx + 1) : undefined,
      };
    },
    async get(id) {
      if (!(id in byId)) throw new Error(`Document not found: ${id}`);
      return byId[id];
    },
  };
}

const L = "powerhouse/app-owner-license";
const T = "powerhouse/app-license-type";

describe("licenses", () => {
  it("returns only the given app's licences, lowercasing the user", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({
        [L]: [[license("a"), license("b", { app: "app-2" })]],
      }),
    );
    const out = await reads.licenses("app-1", null);
    expect(out).toEqual([
      {
        id: "a",
        user: "0xabc",
        licenseTypeId: "lt-1",
        status: "ACTIVE",
        start: "2026-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
      },
    ]);
  });

  it("filters by status when given, and returns all when null", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({
        [L]: [
          [
            license("a", { status: "ACTIVE" }),
            license("b", { status: "EXPIRED" }),
            license("c", { status: "ACTIVE" }),
          ],
        ],
      }),
    );
    expect((await reads.licenses("app-1", "ACTIVE")).map((l) => l.id)).toEqual([
      "a",
      "c",
    ]);
    expect((await reads.licenses("app-1", null)).map((l) => l.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("follows the cursor: rows from both pages are returned", async () => {
    const client = fakeClient({
      [L]: [[license("page1")], [license("page2")], [license("page3")]],
    });
    const reads = createReactorLicenseReads(client);
    const ids = (await reads.licenses("app-1", null)).map((l) => l.id);
    expect(ids).toEqual(["page1", "page2", "page3"]);
    expect(client.findCalls).toEqual([`${L}@0`, `${L}@1`, `${L}@2`]);
  });

  it("skips a malformed document and returns the others", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({
        [L]: [
          [
            license("good1"),
            { header: { id: "no-state" } },
            { header: { id: "bad-status" }, state: { global: { app: "app-1", status: "WAT" } } },
            null,
            license("good2"),
          ],
        ],
      }),
    );
    expect((await reads.licenses("app-1", null)).map((l) => l.id)).toEqual([
      "good1",
      "good2",
    ]);
  });
});

describe("listLicenses", () => {
  it("spans apps, across pages, mapped to {id,status,start,end}", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({
        [L]: [
          [license("a")],
          [license("b", { app: "app-2", status: "ISSUED", start: null, end: null })],
        ],
      }),
    );
    expect(await reads.listLicenses()).toEqual([
      {
        id: "a",
        status: "ACTIVE",
        start: "2026-01-01T00:00:00Z",
        end: "2027-01-01T00:00:00Z",
      },
      { id: "b", status: "ISSUED", start: null, end: null },
    ]);
  });
});

describe("templateFor", () => {
  it("returns the mapped template on the happy path", async () => {
    const reads = createReactorLicenseReads(
      fakeClient(
        {},
        { "lic-1": license("lic-1"), "lt-1": licenseType("lt-1") },
      ),
    );
    expect(await reads.templateFor("lic-1")).toEqual(TEMPLATE);
  });

  it("carries a CLINT service type through unchanged", async () => {
    const tpl = { ...TEMPLATE, services: [{ id: "s", type: "CLINT", prefix: null }] };
    const reads = createReactorLicenseReads(
      fakeClient(
        {},
        { "lic-1": license("lic-1"), "lt-1": licenseType("lt-1", { template: tpl }) },
      ),
    );
    expect((await reads.templateFor("lic-1"))?.services[0]?.type).toBe("CLINT");
  });

  it("returns null when the licence is missing", async () => {
    const reads = createReactorLicenseReads(fakeClient({}, {}));
    expect(await reads.templateFor("nope")).toBeNull();
  });

  it("returns null when the licence names no licence type", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lic-1": license("lic-1", { licenseType: null }) }),
    );
    expect(await reads.templateFor("lic-1")).toBeNull();
  });

  it("returns null when the licence-type document is missing", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lic-1": license("lic-1") }),
    );
    expect(await reads.templateFor("lic-1")).toBeNull();
  });

  it("still resolves the template when the licence type is RETIRED (the licence is the entitlement)", async () => {
    const reads = createReactorLicenseReads(
      fakeClient(
        {},
        {
          "lic-1": license("lic-1"),
          "lt-1": licenseType("lt-1", { status: "RETIRED" }),
        },
      ),
    );
    expect(await reads.templateFor("lic-1")).toEqual(TEMPLATE);
  });

  it("rethrows errors that are not document-not-found", async () => {
    const client: LicenseClientLike = {
      async find() {
        return { results: [] };
      },
      async get() {
        throw new Error("connection reset");
      },
    };
    await expect(
      createReactorLicenseReads(client).templateFor("x"),
    ).rejects.toThrow("connection reset");
  });
});

describe("licenseType", () => {
  it("returns app, status and validityDays for a licence type document", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lt-1": licenseType("lt-1", { validityDays: 90 }) }),
    );
    expect(await reads.licenseType("lt-1")).toEqual({
      id: "lt-1",
      app: "app-1",
      status: "ACTIVE",
      validityDays: 90,
    });
  });

  it("keeps a null validityDays as null", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lt-1": licenseType("lt-1", { validityDays: null }) }),
    );
    expect((await reads.licenseType("lt-1"))?.validityDays).toBeNull();
  });

  it("returns null for a missing document or one with no app", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lt-2": licenseType("lt-2", { app: null }) }),
    );
    expect(await reads.licenseType("nope")).toBeNull();
    expect(await reads.licenseType("lt-2")).toBeNull();
  });
});

describe("license", () => {
  it("returns one licence by id without listing every licence", async () => {
    const client = fakeClient({}, { "lic-1": license("lic-1") });
    const reads = createReactorLicenseReads(client);
    expect(await reads.license("lic-1")).toEqual({
      id: "lic-1",
      app: "app-1",
      user: "0xabc",
      licenseTypeId: "lt-1",
      status: "ACTIVE",
      start: "2026-01-01T00:00:00Z",
      end: "2027-01-01T00:00:00Z",
    });
    expect(client.findCalls).toEqual([]);
  });

  it("returns null for a missing document, one with no app, or a bad status", async () => {
    const reads = createReactorLicenseReads(
      fakeClient(
        {},
        {
          "lic-2": license("lic-2", { app: null }),
          "lic-3": license("lic-3", { status: "WAT" }),
        },
      ),
    );
    expect(await reads.license("nope")).toBeNull();
    expect(await reads.license("lic-2")).toBeNull();
    expect(await reads.license("lic-3")).toBeNull();
  });
});

describe("by-id reads check the document type", () => {
  it("license() is null for an ACTIVE licence-type document", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lt-1": licenseType("lt-1") }),
    );
    expect(await reads.license("lt-1")).toBeNull();
  });

  it("licenseType() is null for a licence document", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lic-1": license("lic-1", { kind: "pro" }) }),
    );
    expect(await reads.licenseType("lic-1")).toBeNull();
  });
});

describe("licenseTypes", () => {
  it("scopes to the app and hashes with the real templateHash", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({
        [T]: [
          [licenseType("lt-1")],
          [licenseType("lt-other", { app: "app-2" }), { header: { id: "bad" } }],
        ],
      }),
    );
    const expected: TemplateShape = TEMPLATE;
    expect(await reads.licenseTypes("app-1")).toEqual([
      {
        id: "lt-1",
        kind: "pro",
        status: "ACTIVE",
        templateHash: templateHash(expected),
      },
    ]);
  });
});

describe("findAll cursor guard", () => {
  it("terminates and returns the rows seen when the cursor never advances", async () => {
    let calls = 0;
    const client: LicenseClientLike = {
      async find() {
        calls++;
        if (calls > 10) throw new Error("cursor guard missing: looped");
        return { results: [license("a")], nextCursor: "0" };
      },
      async get() {
        throw new Error("unused");
      },
    };
    const out = await createReactorLicenseReads(client).listLicenses();
    expect(out.map((l) => l.id)).toEqual(["a"]);
    expect(calls).toBe(1);
  });
});

describe("allLicenses", () => {
  it("returns every licence across apps with app, user and type", async () => {
    const client = fakeClient({
      [L]: [
        [
          license("a", { app: "app-1", user: "0xAA", licenseType: "t-1", status: "ACTIVE" }),
          license("b", { app: "app-2", user: "0xBB", licenseType: "t-2", status: "ISSUED" }),
        ],
      ],
    });
    const rows = await createReactorLicenseReads(client).allLicenses();

    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.id === "a")!;
    expect(a.app).toBe("app-1");
    expect(a.licenseTypeId).toBe("t-1");
    expect(a.status).toBe("ACTIVE");
    // Lowercased at the boundary, as every other read does.
    expect(a.user).toBe("0xaa");
  });

  it("skips a licence with an unrecognised status rather than throwing", async () => {
    const client = fakeClient({
      [L]: [
        [
          license("a", { app: "app-1", user: "0xAA", licenseType: "t-1", status: "ACTIVE" }),
          license("bad", { app: "app-1", user: "0xCC", licenseType: "t-1", status: "WAT" }),
        ],
      ],
    });
    const rows = await createReactorLicenseReads(client).allLicenses();
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("legacyLicenseTypeOf", () => {
  it("prefers stored licenseType, then details.legacyLicenseType", () => {
    expect(
      legacyLicenseTypeOf({
        licenseType: "t1",
        details: '{"legacyLicenseType":"t2"}',
      }),
    ).toBe("t1");
    expect(
      legacyLicenseTypeOf({ details: '{"legacyLicenseType":"t2"}' }),
    ).toBe("t2");
  });
  it("is null for free-text, non-object or missing details", () => {
    expect(legacyLicenseTypeOf({ details: "not json" })).toBeNull();
    expect(legacyLicenseTypeOf({ details: "42" })).toBeNull();
    expect(
      legacyLicenseTypeOf({ details: '{"legacyLicenseType":7}' }),
    ).toBeNull();
    expect(legacyLicenseTypeOf({})).toBeNull();
  });
});
