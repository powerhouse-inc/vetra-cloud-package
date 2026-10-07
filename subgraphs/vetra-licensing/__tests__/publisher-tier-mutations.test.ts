import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Action } from "document-model";
import { actions, reducer, utils } from "document-models/app-license-type";
import {
  UnknownLicenseTypeError,
  type PublisherDeps,
} from "../publisher-resolvers.js";
import { createPublisherResolvers } from "./unwrapped-publisher-resolvers.js";
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
// The fake auth canonicalises ids (as a real lookup may), so the authorised id
// observably differs from what the client typed.
const canonical = (id: string) => id.toLowerCase();
// licence-type document id -> owning app
const baseTypes = (): Record<string, string> => ({
  T1: "app-1",
  TX: "app-2",
});

function makeDeps(over: { enabled?: boolean } = {}) {
  const TYPES = baseTypes();
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
        ? { id, app: TYPES[id], status: "DRAFT", validityDays: 30 }
        : null,
    ),
  };
  const auth = {
    findAppById: vi.fn(async (id: string) =>
      APPS[canonical(id)]
        ? {
            id: canonical(id),
            name: id,
            status: "ACTIVE",
            owner_address: APPS[canonical(id)].owner,
          }
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
  return { m, dispatched, created, typeGateway, docs, TYPES };
}

const CALLS: Array<[string, unknown]> = [
  ["createLicenseType", { input: { appId: "app-1", kind: "pro" } }],
  [
    "setLicenseTypeDetails",
    { input: { licenseTypeId: "T1", label: "Pro" } },
  ],
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
        input: { appId: "APP-1", kind: "pro", label: "Pro", validityDays: 30 },
      },
      ctx(OWNER),
    );
    expect(id).toBe("NEW-1");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actions[0].type).toBe("SET_LICENSE_TYPE_DETAILS");
    expect(dispatched[0].actions[0].input).toMatchObject({
      app: "app-1", // authorised, not the client's "APP-1"
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

  it("gate order: with licensing disabled, strangers and anonymous callers get the auth error, not LicensingDisabledError", async () => {
    for (const [name, args] of CALLS) {
      const foreignArgs = JSON.parse(
        JSON.stringify(args).replace("T1", "TX").replace("app-1", "app-2"),
      );
      const a = makeDeps({ enabled: false });
      const err = await a.m[name]({}, foreignArgs, ctx(OWNER)).catch(
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(Error);
      expect(err, name).not.toBeInstanceOf(LicensingDisabledError);
      expect(a.dispatched, name).toEqual([]);

      const b = makeDeps({ enabled: false });
      const anon = await b.m[name]({}, args, ctx()).catch((e: unknown) => e);
      expect(anon, name).toBeInstanceOf(UnauthenticatedError);
      expect(b.dispatched, name).toEqual([]);
    }
  });

  it("setLicenseTypeDetails dispatches SET_LICENSE_TYPE_DETAILS to the right document with the edited fields", async () => {
    const { m, dispatched } = makeDeps();
    const r = await m.setLicenseTypeDetails(
      {},
      {
        input: {
          licenseTypeId: "T1",
          kind: "team",
          label: "Team",
          validityDays: 90,
        },
      },
      ctx(OWNER),
    );
    expect(r).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].id).toBe("T1");
    expect(dispatched[0].actions).toHaveLength(1);
    expect(dispatched[0].actions[0].type).toBe("SET_LICENSE_TYPE_DETAILS");
    expect(dispatched[0].actions[0].input).toEqual({
      kind: "team",
      label: "Team",
      validityDays: 90,
    });
  });

  it("setLicenseTypeDetails never dispatches an app key, so a tier cannot be moved to another publisher's app", async () => {
    const { m, dispatched } = makeDeps();
    // A hostile client smuggles an app in the input; it must not reach the action.
    await m.setLicenseTypeDetails(
      {},
      {
        input: {
          licenseTypeId: "T1",
          label: "Pro",
          app: "app-2",
          appId: "app-2",
        },
      },
      ctx(OWNER),
    );
    const input = dispatched[0].actions[0].input as Record<string, unknown>;
    expect(Object.keys(input)).not.toContain("app");
    expect("app" in input).toBe(false);
    expect(JSON.stringify(input)).not.toContain("app-2");
    // and the reducer leaves an existing app alone when the key is absent
    const base = utils.createDocument();
    const withApp = reducer(
      base,
      actions.setLicenseTypeDetails({ app: "app-1", kind: "pro" }) as never,
    );
    const after = reducer(withApp, dispatched[0].actions[0] as never);
    expect(after.state.global.app).toBe("app-1");
  });

  it("setLicenseTypeDetails on a foreign licence type is UnknownLicenseTypeError and the gateway is never called", async () => {
    const { m, typeGateway, dispatched } = makeDeps();
    await expect(
      m.setLicenseTypeDetails(
        {},
        { input: { licenseTypeId: "TX", label: "Hijack" } },
        ctx(OWNER),
      ),
    ).rejects.toBeInstanceOf(UnknownLicenseTypeError);
    expect(typeGateway.execute).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });

  it("setLicenseTypeDetails: disabled gate applies after authorisation", async () => {
    const own = makeDeps({ enabled: false });
    await expect(
      own.m.setLicenseTypeDetails(
        {},
        { input: { licenseTypeId: "T1", label: "x" } },
        ctx(OWNER),
      ),
    ).rejects.toBeInstanceOf(LicensingDisabledError);
    expect(own.typeGateway.execute).not.toHaveBeenCalled();

    const foreign = makeDeps({ enabled: false });
    await expect(
      foreign.m.setLicenseTypeDetails(
        {},
        { input: { licenseTypeId: "TX", label: "x" } },
        ctx(OWNER),
      ),
    ).rejects.toBeInstanceOf(UnknownLicenseTypeError);

    const anon = makeDeps({ enabled: false });
    await expect(
      anon.m.setLicenseTypeDetails(
        {},
        { input: { licenseTypeId: "T1", label: "x" } },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  const detailsInput = async (input: Record<string, unknown>) => {
    const { m, dispatched } = makeDeps();
    await m
      .setLicenseTypeDetails(
        {},
        { input: { licenseTypeId: "T1", ...input } },
        ctx(OWNER),
      )
      .catch(() => undefined); // the real reducer rejects 0; the dispatch is what we inspect
    return dispatched[0].actions[0].input as Record<string, unknown>;
  };

  it("setLicenseTypeDetails: editing only the label keeps the current validityDays", async () => {
    const input = await detailsInput({ label: "Renamed" });
    expect(input.validityDays).toBe(30);
    expect(input.label).toBe("Renamed");
  });

  it("setLicenseTypeDetails: an explicit validityDays null clears it", async () => {
    const input = await detailsInput({ validityDays: null });
    expect(input.validityDays).toBeNull();
  });

  it("setLicenseTypeDetails: validityDays 0 is sent as 0, not treated as absent", async () => {
    const input = await detailsInput({ validityDays: 0 });
    expect(input.validityDays).toBe(0);
  });

  it("setLicenseTypeDetails: a number sets validityDays; absent kind and label stay null (unchanged)", async () => {
    const input = await detailsInput({ validityDays: 90 });
    expect(input).toEqual({ kind: null, label: null, validityDays: 90 });
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
    const { m, docs, TYPES } = makeDeps();
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
  });
});
