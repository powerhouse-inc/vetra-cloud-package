import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Action } from "document-model";
import { reducer, utils } from "document-models/app-owner-license";
import {
  createPublisherResolvers,
  UnknownLicenseError,
  type PublisherDeps,
} from "../publisher-resolvers.js";
import { createReactorLicenseReads } from "../reads.js";
import { LicensingDisabledError } from "../resolvers.js";
import { UnauthenticatedError } from "../auth.js";
import { NotAppOwnerError } from "../publisher-auth.js";
import { InvalidHolderAddressError } from "../issuers/publisher-grant.js";
import type { VetraLicensingDB } from "../db/schema.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOLDER = "0xcccccccccccccccccccccccccccccccccccccccc";

const ctx = (address?: string) =>
  address ? { user: { address, networkId: "eip155", chainId: 1 } } : {};

const throwingDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`database touched: ${String(prop)}`);
    },
  },
) as unknown as Kysely<VetraLicensingDB>;

const APPS: Record<string, { owner: string }> = {
  "app-1": { owner: OWNER },
  "app-2": { owner: STRANGER },
};
// licence document id -> owning app
const LICENSES: Record<string, string> = { L1: "app-1", LX: "app-2" };

function makeDeps(over: { enabled?: boolean } = {}) {
  const dispatched: Array<{ id: string; actions: Action[] }> = [];
  const created: string[] = [];
  const docs = new Map<string, ReturnType<typeof utils.createDocument>>();

  // A real reducer behind the gateway: rejections surface by throwing.
  const run = async (id: string, actions: Action[]) => {
    dispatched.push({ id, actions });
    let doc = docs.get(id) ?? utils.createDocument();
    for (const a of actions) {
      doc = reducer(doc, a as never);
      const err = doc.operations.global.find((o) => o.error)?.error;
      if (err) throw new Error(`${a.type} rejected: ${err}`);
    }
    docs.set(id, doc);
  };

  const grant = {
    isOnAllowList: vi.fn(async () => true),
    getLicenseType: vi.fn(async (id: string) =>
      id === "T1"
        ? { id, app: "app-1", status: "ACTIVE", validityDays: 30 }
        : null,
    ),
    createLicenseDocument: vi.fn(async () => {
      const id = `LIC-${created.length + 1}`;
      created.push(id);
      docs.set(id, utils.createDocument());
      return id;
    }),
    execute: vi.fn(run),
  };
  const licenseGateway = { execute: vi.fn(run) };
  // L1 starts ACTIVE so a revoke is a legal transition.
  docs.set(
    "L1",
    reducer(
      utils.createDocument(),
      {
        type: "ISSUE_LICENSE",
        input: {
          app: "app-1",
          licenseType: "T1",
          user: HOLDER,
          issuer: "PUBLISHER_GRANT",
          issuedBy: OWNER,
          stage: null,
          details: null,
          issued: "2026-10-01T00:00:00.000Z",
          start: "2026-10-01T00:00:00.000Z",
          end: null,
        },
        scope: "global",
      } as never,
    ),
  );

  const reads = {
    license: vi.fn(async (id: string) =>
      LICENSES[id]
        ? {
            id,
            app: LICENSES[id],
            user: HOLDER,
            licenseTypeId: "T1",
            status: "ISSUED",
            start: null,
            end: null,
          }
        : null,
    ),
    allLicenses: vi.fn(async () => {
      throw new Error("revoke must not scan every licence");
    }),
  };
  const auth = {
    findAppById: vi.fn(async (id: string) =>
      APPS[id.toLowerCase()]
        ? {
            id: id.toLowerCase(),
            name: id,
            status: "ACTIVE",
            owner_address: APPS[id.toLowerCase()].owner,
          }
        : null,
    ),
    listAppsForOwner: vi.fn(),
  };
  const deps = {
    auth,
    reads,
    cfg: { enabled: over.enabled ?? true },
    grant,
    licenseGateway,
  } as unknown as PublisherDeps;
  const m = createPublisherResolvers(throwingDb, deps)
    .VetraPublisherMutations as Record<
    string,
    (p: unknown, a: unknown, c: unknown) => Promise<unknown>
  >;
  return { m, dispatched, created, grant, licenseGateway, docs, reads };
}

const GRANT = { input: { appId: "app-1", licenseTypeId: "T1", user: HOLDER } };
const REVOKE = { input: { licenseId: "L1", reason: "chargeback" } };
const CALLS: Array<[string, unknown]> = [
  ["issueGrant", GRANT],
  ["revokeLicense", REVOKE],
];

describe("publisher issueGrant", () => {
  it("returns the licence id and records the caller's wallet as issuedBy", async () => {
    const { m, dispatched, docs } = makeDeps();
    const id = await m.issueGrant({}, GRANT, ctx(OWNER));
    expect(id).toBe("LIC-1");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actions[0].input).toMatchObject({
      app: "app-1",
      licenseType: "T1",
      user: HOLDER,
      issuer: "PUBLISHER_GRANT",
      issuedBy: OWNER,
    });
    expect(docs.get("LIC-1")?.state.global.status).toBe("ISSUED");
  });

  it("refuses a malformed holder and never creates a document", async () => {
    const { m, grant, dispatched, created } = makeDeps();
    await expect(
      m.issueGrant(
        {},
        { input: { ...GRANT.input, user: "not-an-address" } },
        ctx(OWNER),
      ),
    ).rejects.toBeInstanceOf(InvalidHolderAddressError);
    expect(grant.createLicenseDocument).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("refuses an app the caller does not own and creates nothing", async () => {
    const { m, grant, dispatched } = makeDeps();
    await expect(
      m.issueGrant(
        {},
        { input: { ...GRANT.input, appId: "app-2" } },
        ctx(OWNER),
      ),
    ).rejects.toBeInstanceOf(NotAppOwnerError);
    expect(grant.createLicenseDocument).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });
});

describe("publisher revokeLicense", () => {
  it("revokes the caller's own licence with the reason", async () => {
    const { m, dispatched, docs } = makeDeps();
    await expect(m.revokeLicense({}, REVOKE, ctx(OWNER))).resolves.toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].id).toBe("L1");
    expect(dispatched[0].actions[0].type).toBe("REVOKE_LICENSE");
    expect(dispatched[0].actions[0].input).toEqual({ reason: "chargeback" });
    expect(docs.get("L1")?.state.global.status).toBe("REVOKED");
  });

  it("another publisher's licence is UnknownLicenseError and nothing is dispatched", async () => {
    const { m, dispatched } = makeDeps();
    // RevokeLicenseInput has no appId, so GraphQL rejects this at the boundary;
    // the test deliberately pins the resolver-level contract as defence in depth.
    // The caller forges an app id they DO own; it must be ignored.
    const err = await m
      .revokeLicense(
        {},
        { input: { licenseId: "LX", appId: "app-1" } },
        ctx(OWNER),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownLicenseError);
    expect(dispatched).toEqual([]);
  });

  it("a missing licence is indistinguishable from a foreign one", async () => {
    const { m, dispatched } = makeDeps();
    const missing = await m
      .revokeLicense({}, { input: { licenseId: "nope" } }, ctx(OWNER))
      .catch((e: unknown) => e as Error);
    const foreign = await m
      .revokeLicense({}, { input: { licenseId: "LX" } }, ctx(OWNER))
      .catch((e: unknown) => e as Error);
    expect(missing).toBeInstanceOf(UnknownLicenseError);
    expect((missing as Error).message).toBe((foreign as Error).message);
    expect(dispatched).toEqual([]);
  });

  it("a licence-TYPE id is UnknownLicenseError, not a false success", async () => {
    const { m, dispatched, licenseGateway } = makeDeps();
    // Real reads over an ACTIVE licence-type document of the caller's own app:
    // without a document-type check it parses as a licence and "revokes".
    const typeDoc = {
      header: { id: "T1", documentType: "powerhouse/app-license-type" },
      state: { global: { app: "app-1", kind: "pro", status: "ACTIVE" } },
    };
    const realReads = createReactorLicenseReads({
      find: async () => ({ results: [] }),
      get: async (id: string) => {
        if (id !== "T1") throw new Error(`Document not found: ${id}`);
        return typeDoc;
      },
    });
    const m2 = createPublisherResolvers(throwingDb, {
      auth: {
        findAppById: async () => ({
          id: "app-1",
          name: "a",
          status: "ACTIVE",
          owner_address: OWNER,
        }),
        listAppsForOwner: vi.fn(),
      },
      reads: realReads,
      cfg: { enabled: true },
      licenseGateway,
    } as unknown as PublisherDeps).VetraPublisherMutations as typeof m;
    const err = await m2
      .revokeLicense({}, { input: { licenseId: "T1" } }, ctx(OWNER))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownLicenseError);
    expect(dispatched).toEqual([]);
    expect(licenseGateway.execute).not.toHaveBeenCalled();
  });

  it("reads one licence rather than scanning them all", async () => {
    const { m, reads } = makeDeps();
    await m.revokeLicense({}, REVOKE, ctx(OWNER));
    expect(reads.license).toHaveBeenCalledWith("L1");
    expect(reads.allLicenses).not.toHaveBeenCalled();
  });
});

describe("publisher grant gates", () => {
  it("refuses anonymous callers and dispatches nothing", async () => {
    for (const [name, args] of CALLS) {
      const { m, dispatched, created } = makeDeps();
      await expect(m[name]({}, args, ctx())).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
      expect(dispatched, name).toEqual([]);
      expect(created, name).toEqual([]);
    }
  });

  it("refuses with LicensingDisabledError when disabled and does nothing", async () => {
    for (const [name, args] of CALLS) {
      const { m, dispatched, created } = makeDeps({ enabled: false });
      await expect(m[name]({}, args, ctx(OWNER))).rejects.toBeInstanceOf(
        LicensingDisabledError,
      );
      expect(dispatched, name).toEqual([]);
      expect(created, name).toEqual([]);
    }
  });

  it("gate order: disabled, a stranger still gets the authorisation error", async () => {
    for (const [name, args] of CALLS) {
      const { m, dispatched, created } = makeDeps({ enabled: false });
      const err = await m[name]({}, args, ctx(STRANGER)).catch(
        (e: unknown) => e,
      );
      expect(err, name).not.toBeInstanceOf(LicensingDisabledError);
      // issueGrant surfaces the raw ownership error; revokeLicense remaps it.
      expect(err, name).toBeInstanceOf(
        name === "issueGrant" ? NotAppOwnerError : UnknownLicenseError,
      );
      expect(dispatched, name).toEqual([]);
      expect(created, name).toEqual([]);
    }
  });
});
