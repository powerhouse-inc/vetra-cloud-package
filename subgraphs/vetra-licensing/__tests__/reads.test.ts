import { describe, expect, it } from "vitest";
import {
  createReactorLicenseReads,
  legacyLicenseTypeOf,
  type LicenseClientLike,
} from "../reads.js";

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

describe("licence records", () => {
  const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
  const reshaped = (id: string, g: Partial<Record<string, unknown>> = {}) =>
    license(id, {
      licenseType: undefined, user: DID, kind: "pro", issuer: "PUBLISHER_GRANT",
      issued: "2026-01-01T00:00:00Z", stage: "env-7", details: '{"grantedBy":"0xowner"}',
      replacedBy: null, ...g,
    });

  it("parses kind, issuer, stage and the rest of a licence document", async () => {
    const reads = createReactorLicenseReads(fakeClient({}, { "lic-1": reshaped("lic-1") }));
    expect(await reads.licenceRecord("lic-1")).toStrictEqual({
      id: "lic-1", app: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT",
      status: "ACTIVE", issued: "2026-01-01T00:00:00Z", start: "2026-01-01T00:00:00Z",
      end: "2027-01-01T00:00:00Z", stage: "env-7", details: '{"grantedBy":"0xowner"}',
      replacedBy: null, legacyLicenseTypeId: null,
    });
  });

  it("keeps a legacy licence's type id and leaves its kind null", async () => {
    const reads = createReactorLicenseReads(fakeClient({}, { "lic-0": license("lic-0") }));
    expect(await reads.licenceRecord("lic-0")).toMatchObject({
      kind: null, issuer: null, user: "0xabc", legacyLicenseTypeId: "lt-1",
    });
  });

  it("is null for a missing id, a licence-type document, or a licence with no app", async () => {
    const reads = createReactorLicenseReads(
      fakeClient({}, { "lt-1": licenseType("lt-1"), "lic-2": reshaped("lic-2", { app: null }) }),
    );
    expect(await reads.licenceRecord("nope")).toBeNull();
    expect(await reads.licenceRecord("lt-1")).toBeNull();
    expect(await reads.licenceRecord("lic-2")).toBeNull();
  });

  it("lists every licence record across pages, and by ids skipping missing ones", async () => {
    const a = reshaped("a");
    const b = reshaped("b", { app: "app-2", status: "REPLACED", replacedBy: "c" });
    const reads = createReactorLicenseReads(
      fakeClient({ [L]: [[a], [b, reshaped("x", { app: null })]] }, { a, b }),
    );
    expect((await reads.allLicenceRecords()).map((r) => [r.id, r.app, r.status, r.replacedBy]))
      .toStrictEqual([["a", "app-1", "ACTIVE", null], ["b", "app-2", "REPLACED", "c"]]);
    expect((await reads.licenceRecords(["b", "nope", "a"])).map((r) => r.id)).toStrictEqual(["b", "a"]);
  });
});
