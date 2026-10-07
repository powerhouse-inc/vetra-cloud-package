import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Action } from "document-model";
import { reducer, utils } from "document-models/app-license-type";
import {
  createPublisherResolvers,
  UnknownLicenseTypeError,
  type PublisherDeps,
} from "../publisher-resolvers.js";
import { LicensingDisabledError } from "../resolvers.js";
import { UnauthenticatedError } from "../auth.js";
import type { VetraLicensingDB } from "../db/schema.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
// licence-type document id -> owning app
const TYPES: Record<string, string> = { T1: "app-1", TX: "app-2" };

function makeDeps(over: { enabled?: boolean } = {}) {
  const dispatched: Array<{ id: string; actions: Action[] }> = [];
  const created: string[] = [];
  // A real reducer behind the gateway, so rejections surface as the gateway
  // would surface them: by throwing.
  const docs = new Map<string, ReturnType<typeof utils.createDocument>>();
  const typeGateway = {
    create: vi.fn(async () => {
      const id = `NEW-${created.length + 1}`;
      created.push(id);
      docs.set(id, utils.createDocument());
      return id;
    }),
    execute: vi.fn(async (id: string, actions: Action[]) => {
      dispatched.push({ id, actions });
      let doc = docs.get(id) ?? utils.createDocument();
      for (const a of actions) {
        doc = reducer(doc, a as never);
        const err = doc.operations.global.find((o) => o.error)?.error;
        if (err) throw new Error(`${a.type} rejected: ${err}`);
      }
      docs.set(id, doc);
    }),
  };
  const reads = {
    licenseType: vi.fn(async (id: string) =>
      TYPES[id]
        ? { id, app: TYPES[id], status: "DRAFT", validityDays: null }
        : null,
    ),
  };
  const auth = {
    findAppById: vi.fn(async (id: string) =>
      APPS[id]
        ? { id, name: id, status: "ACTIVE", owner_address: APPS[id].owner }
        : null,
    ),
    listAppsForOwner: vi.fn(),
  };
  const deps = {
    auth,
    reads,
    cfg: { enabled: over.enabled ?? true },
    typeGateway,
  } as unknown as PublisherDeps;
  const m = createPublisherResolvers(throwingDb, deps)
    .VetraPublisherMutations as Record<
    string,
    (p: unknown, a: unknown, c: unknown) => Promise<unknown>
  >;
  return { m, dispatched, created, typeGateway, docs };
}

const CALLS: Array<[string, unknown]> = [
  ["createLicenseType", { input: { appId: "app-1", kind: "pro" } }],
  [
    "setLicenseTypeTemplate",
    { input: { licenseTypeId: "T1", size: "SMALL" } },
  ],
  [
    "addLicenseTypeService",
    { input: { licenseTypeId: "T1", type: "SWITCHBOARD" } },
  ],
  [
    "addLicenseTypePackage",
    { input: { licenseTypeId: "T1", packageName: "@x/y" } },
  ],
  ["publishLicenseType", { licenseTypeId: "T1" }],
  ["retireLicenseType", { licenseTypeId: "T1" }],
];

describe("publisher tier authoring", () => {
  it("creating a tier dispatches the AUTHORISED app id, not a client one", async () => {
    const { m, dispatched, docs } = makeDeps();
    const id = await m.createLicenseType(
      {},
      {
        input: { appId: "app-1", kind: "pro", label: "Pro", validityDays: 30 },
      },
      ctx(OWNER),
    );
    expect(id).toBe("NEW-1");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actions[0].type).toBe("SET_LICENSE_TYPE_DETAILS");
    expect(dispatched[0].actions[0].input).toMatchObject({
      app: "app-1",
      kind: "pro",
      label: "Pro",
      validityDays: 30,
    });
    expect(docs.get("NEW-1")?.state.global.app).toBe("app-1");
  });

  it("creating a tier under another publisher's app creates and dispatches nothing", async () => {
    const { m, dispatched, created } = makeDeps();
    await expect(
      m.createLicenseType(
        {},
        { input: { appId: "app-2", kind: "pro" } },
        ctx(OWNER),
      ),
    ).rejects.toThrow();
    expect(created).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("another publisher's licence type is UnknownLicenseTypeError, nothing dispatched", async () => {
    for (const [name, args] of CALLS.slice(1)) {
      const { m, dispatched } = makeDeps();
      const foreign = JSON.parse(JSON.stringify(args).replace("T1", "TX"));
      await expect(m[name]({}, foreign, ctx(OWNER))).rejects.toBeInstanceOf(
        UnknownLicenseTypeError,
      );
      expect(dispatched, name).toEqual([]);
    }
  });

  it("a missing licence type is the same error", async () => {
    const { m, dispatched } = makeDeps();
    await expect(
      m.publishLicenseType({}, { licenseTypeId: "nope" }, ctx(OWNER)),
    ).rejects.toThrow("no such licence type");
    expect(dispatched).toEqual([]);
  });

  it("unauthenticated callers are refused and dispatch nothing", async () => {
    for (const [name, args] of CALLS) {
      const { m, dispatched } = makeDeps();
      await expect(m[name]({}, args, ctx())).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
      expect(dispatched, name).toEqual([]);
    }
  });

  it("every mutation throws LicensingDisabledError when disabled and dispatches nothing", async () => {
    for (const [name, args] of CALLS) {
      const { m, dispatched, created } = makeDeps({ enabled: false });
      await expect(m[name]({}, args, ctx(OWNER))).rejects.toBeInstanceOf(
        LicensingDisabledError,
      );
      expect(dispatched, name).toEqual([]);
      expect(created, name).toEqual([]);
    }
  });

  it("adds a service and a package with server-generated ids", async () => {
    const { m, dispatched } = makeDeps();
    await m.addLicenseTypeService(
      {},
      { input: { licenseTypeId: "T1", type: "SWITCHBOARD", prefix: "api" } },
      ctx(OWNER),
    );
    await m.addLicenseTypePackage(
      {},
      { input: { licenseTypeId: "T1", packageName: "@x/y", version: "1.0.0" } },
      ctx(OWNER),
    );
    const [svc, pkg] = dispatched.map((d) => d.actions[0].input as never) as {
      id: string;
    }[];
    expect(svc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pkg.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(svc.id).not.toBe(pkg.id);
    expect(dispatched.every((d) => d.id === "T1")).toBe(true);
  });

  it("publishLicenseType propagates IncompleteTemplateError for a tier with no service", async () => {
    const { m } = makeDeps();
    await expect(
      m.publishLicenseType({}, { licenseTypeId: "T1" }, ctx(OWNER)),
    ).rejects.toThrow(/at least one service/);
  });

  it("publishes once a service exists, and retire follows", async () => {
    const { m, docs } = makeDeps();
    // Seed T1 as a real document so the reducer has state to work on.
    const id = await m.createLicenseType(
      {},
      { input: { appId: "app-1", kind: "pro" } },
      ctx(OWNER),
    );
    TYPES[id as string] = "app-1";
    await m.addLicenseTypeService(
      {},
      { input: { licenseTypeId: id, type: "SWITCHBOARD" } },
      ctx(OWNER),
    );
    expect(
      await m.publishLicenseType({}, { licenseTypeId: id }, ctx(OWNER)),
    ).toBe(true);
    expect(docs.get(id as string)?.state.global.status).toBe("ACTIVE");
    expect(
      await m.retireLicenseType({}, { licenseTypeId: id }, ctx(OWNER)),
    ).toBe(true);
    delete TYPES[id as string];
  });
});
