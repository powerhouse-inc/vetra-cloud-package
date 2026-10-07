import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import { buildASTSchema, type GraphQLInputObjectType } from "graphql";
import { schema } from "../schema.js";
import type { Action } from "document-model";
import {
  createPublisherResolvers,
  UnknownLicenseTypeError,
  UnknownLicenseError,
  type PublisherDeps,
} from "../publisher-resolvers.js";
import { NotAppOwnerError, UnknownAppError } from "../publisher-auth.js";
import { LicenseTypeNotIssuableError } from "../issuers/publisher-grant.js";
import type { VetraLicensingDB } from "../db/schema.js";

/**
 * Cross-publisher isolation: the security property of the whole publisher
 * surface. Two publishers, A and B, each own one app, with one licence type,
 * one licence and one environment row. A acts on B's identifiers through every
 * one of the thirteen fields and must be refused WITHOUT any read of B's data
 * and WITHOUT any write. "Refused" is never enough on its own: a refusal that
 * still dispatched is a breach, so each case asserts the gateways were not
 * called. Every refusal also has a positive control (A on A's own identifiers
 * works), so a broken harness cannot make the suite pass vacuously.
 */

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOLDER_A = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const HOLDER_B = "0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";

const APP_A = "app-a";
const APP_B = "app-b";
const TYPE_A = "type-a";
const TYPE_B = "type-b";
const LIC_A = "lic-a";
const LIC_B = "lic-b";
const GHOST_APP = "app-ghost";
const GHOST_TYPE = "type-ghost";
const GHOST_LIC = "lic-ghost";

// isAdmin is pinned so the ADMINS env of the machine running the suite cannot
// turn A into an admin and mask a breach.
const asA = { user: { address: A, networkId: "eip155", chainId: 1 }, isAdmin: () => false };

const APPS: Record<string, { owner: string }> = {
  [APP_A]: { owner: A },
  [APP_B]: { owner: B },
};
const TYPES: Record<string, string> = { [TYPE_A]: APP_A, [TYPE_B]: APP_B };
const LICENSES: Record<string, { app: string; user: string; type: string }> = {
  [LIC_A]: { app: APP_A, user: HOLDER_A, type: TYPE_A },
  [LIC_B]: { app: APP_B, user: HOLDER_B, type: TYPE_B },
};

const template = { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null };

const envRows = [
  { app_id: APP_A, user_address: HOLDER_A, environment_id: "env-a", license_id: LIC_A, template_hash: "ha" },
  { app_id: APP_B, user_address: HOLDER_B, environment_id: "env-b", license_id: LIC_B, template_hash: "hb" },
];

function makeHarness() {
  const dbSelects: string[] = [];
  const filters: Array<[string, string]> = [];
  const chain: Record<string, unknown> = {
    selectAll: () => chain,
    where: (col: string, op: string, val: string) => {
      if (op !== "=") throw new Error(`unsupported operator ${op}`);
      filters.push([col, val]);
      return chain;
    },
    // Honours every filter it is given, so a dropped filter changes the rows
    // returned rather than merely the calls made.
    execute: async () =>
      envRows.filter((r) =>
        filters.every(([c, v]) => (r as Record<string, string>)[c] === v),
      ),
  };
  const db = {
    selectFrom: (t: string) => {
      dbSelects.push(t);
      filters.length = 0;
      return chain;
    },
  } as unknown as Kysely<VetraLicensingDB>;

  const dispatched: Array<{ id: string; actions: Action[] }> = [];
  const typeGateway = {
    create: vi.fn(async () => "NEW-TYPE"),
    execute: vi.fn(async (id: string, actions: Action[]) => {
      dispatched.push({ id, actions });
    }),
  };
  const licenseGateway = {
    execute: vi.fn(async (id: string, actions: Action[]) => {
      dispatched.push({ id, actions });
    }),
  };
  const reads = {
    // By-id reads: these only ever yield the document's own app.
    licenseType: vi.fn(async (id: string) =>
      TYPES[id]
        ? { id, app: TYPES[id], status: "DRAFT", validityDays: 30 }
        : null,
    ),
    license: vi.fn(async (id: string) =>
      LICENSES[id]
        ? {
            id,
            app: LICENSES[id].app,
            user: LICENSES[id].user,
            licenseTypeId: LICENSES[id].type,
            status: "ACTIVE",
            start: null,
            end: null,
          }
        : null,
    ),
    // Listing reads: these return DATA of the app they are asked about.
    licenseTypeDetails: vi.fn(async (appId: string) =>
      Object.entries(TYPES)
        .filter(([, app]) => app === appId)
        .map(([id]) => ({
          id,
          kind: "pro",
          label: `label of ${id}`,
          status: "DRAFT",
          validityDays: 30,
          templateHash: "h",
          template,
        })),
    ),
    licenses: vi.fn(async (appId: string) =>
      Object.entries(LICENSES)
        .filter(([, l]) => l.app === appId)
        .map(([id, l]) => ({
          id,
          user: l.user,
          licenseTypeId: l.type,
          status: "ACTIVE",
          start: null,
          end: null,
        })),
    ),
  };
  const auth = {
    findAppById: vi.fn(async (id: string) =>
      APPS[id]
        ? { id, name: id, status: "ACTIVE", owner_address: APPS[id].owner }
        : null,
    ),
    listAppsForOwner: vi.fn(async (address: string) =>
      Object.entries(APPS)
        .filter(([, a]) => a.owner === address.toLowerCase())
        .map(([id, a]) => ({
          id,
          name: `name of ${id}`,
          status: "ACTIVE",
          owner_address: a.owner,
        })),
    ),
  };
  const grant = {
    isOnAllowList: vi.fn(async () => true),
    getLicenseType: vi.fn(async (id: string) =>
      TYPES[id]
        ? { id, app: TYPES[id], status: "ACTIVE", validityDays: 30 }
        : null,
    ),
    createLicenseDocument: vi.fn(async () => "NEW-LICENSE"),
    execute: vi.fn(async (id: string, actions: Action[]) => {
      dispatched.push({ id, actions });
    }),
  };
  const deps = {
    auth,
    reads,
    cfg: { enabled: true },
    typeGateway,
    licenseGateway,
    grant,
  } as unknown as PublisherDeps;
  const r = createPublisherResolvers(db, deps) as Record<
    string,
    Record<string, (p: unknown, a: unknown, c: unknown) => Promise<unknown>>
  >;
  const q = r.VetraPublisherQueries;
  const m = r.VetraPublisherMutations;

  /** Every write path: nothing may have been created, dispatched or issued. */
  const expectNoWrite = () => {
    expect(typeGateway.create).not.toHaveBeenCalled();
    expect(typeGateway.execute).not.toHaveBeenCalled();
    expect(licenseGateway.execute).not.toHaveBeenCalled();
    expect(grant.createLicenseDocument).not.toHaveBeenCalled();
    expect(grant.execute).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  };
  /** No listing read and no database access: no data of B was fetched. */
  const expectNoDataRead = () => {
    expect(reads.licenseTypeDetails).not.toHaveBeenCalled();
    expect(reads.licenses).not.toHaveBeenCalled();
    expect(dbSelects).toEqual([]);
  };
  return { q, m, dispatched, dbSelects, typeGateway, licenseGateway, reads, auth, grant, expectNoWrite, expectNoDataRead };
}

const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to be refused, but it resolved");
};

/** Message with the id the caller typed replaced, so ids can be compared. */
const sans = (e: Error, id: string) => e.message.split(id).join("<id>");

describe("app-keyed queries refuse another publisher's app", () => {
  it("myApps returns only the caller's apps", async () => {
    const h = makeHarness();
    const apps = (await h.q.myApps({}, {}, asA)) as Array<{ id: string }>;
    expect(apps.map((a) => a.id)).toEqual([APP_A]);
    // and for B the mirror image, so the filter is real, not a constant
    const asB = { ...asA, user: { ...asA.user, address: B } };
    const bApps = (await h.q.myApps({}, {}, asB)) as Array<{ id: string }>;
    expect(bApps.map((a) => a.id)).toEqual([APP_B]);
  });

  it("licenseTypes: refused, no data read; own app is served", async () => {
    const h = makeHarness();
    const own = (await h.q.licenseTypes({}, { appId: APP_A }, asA)) as Array<{ id: string }>;
    expect(own.map((t) => t.id)).toEqual([TYPE_A]);
    h.reads.licenseTypeDetails.mockClear();

    await expect(h.q.licenseTypes({}, { appId: APP_B }, asA)).rejects.toBeInstanceOf(NotAppOwnerError);
    expect(h.reads.licenseTypeDetails).not.toHaveBeenCalled();
  });

  it("licenses: refused, no data read; own app is served and excludes B", async () => {
    const h = makeHarness();
    const own = (await h.q.licenses({}, { appId: APP_A }, asA)) as Array<{ id: string }>;
    expect(own.map((l) => l.id)).toEqual([LIC_A]);
    h.reads.licenses.mockClear();
    h.dbSelects.length = 0;

    await expect(h.q.licenses({}, { appId: APP_B }, asA)).rejects.toBeInstanceOf(NotAppOwnerError);
    await expect(h.q.licenses({}, { appId: APP_B, status: "ACTIVE" }, asA)).rejects.toBeInstanceOf(NotAppOwnerError);
    expect(h.reads.licenses).not.toHaveBeenCalled();
    expect(h.dbSelects).toEqual([]);
  });

  it("environments: refused, no database access; own app returns only A's rows", async () => {
    const h = makeHarness();
    const own = (await h.q.environments({}, { appId: APP_A }, asA)) as Array<{ appId: string; environmentId: string }>;
    expect(own.map((e) => e.environmentId)).toEqual(["env-a"]);
    expect(own.every((e) => e.appId === APP_A)).toBe(true);
    h.dbSelects.length = 0;

    await expect(h.q.environments({}, { appId: APP_B }, asA)).rejects.toBeInstanceOf(NotAppOwnerError);
    expect(h.dbSelects).toEqual([]);
  });
});

describe("app-keyed mutations refuse another publisher's app", () => {
  it("createLicenseType: no document is created or dispatched", async () => {
    const h = makeHarness();
    await expect(
      h.m.createLicenseType({}, { input: { appId: APP_B, kind: "pro" } }, asA),
    ).rejects.toBeInstanceOf(NotAppOwnerError);
    h.expectNoWrite();

    // positive control
    await expect(
      h.m.createLicenseType({}, { input: { appId: APP_A, kind: "pro" } }, asA),
    ).resolves.toBe("NEW-TYPE");
    expect(h.dispatched).toHaveLength(1);
  });

  describe("issueGrant", () => {
    it("on B's app: refused, nothing issued", async () => {
      const h = makeHarness();
      await expect(
        h.m.issueGrant({}, { input: { appId: APP_B, licenseTypeId: TYPE_B, user: HOLDER_B } }, asA),
      ).rejects.toBeInstanceOf(NotAppOwnerError);
      h.expectNoWrite();
      expect(h.grant.getLicenseType).not.toHaveBeenCalled();
    });

    it("on A's app with B's licence type: refused, nothing issued", async () => {
      const h = makeHarness();
      const err = await rejection(
        h.m.issueGrant({}, { input: { appId: APP_A, licenseTypeId: TYPE_B, user: HOLDER_A } }, asA),
      );
      expect(err).toBeInstanceOf(LicenseTypeNotIssuableError);
      h.expectNoWrite();

      // indistinguishable from a type that does not exist
      const ghost = await rejection(
        h.m.issueGrant({}, { input: { appId: APP_A, licenseTypeId: GHOST_TYPE, user: HOLDER_A } }, asA),
      );
      expect(ghost).toBeInstanceOf(LicenseTypeNotIssuableError);
      expect(sans(err, TYPE_B)).toBe(sans(ghost, GHOST_TYPE));
      h.expectNoWrite();
    });

    it("positive control: A's type on A's app is issued", async () => {
      const h = makeHarness();
      await expect(
        h.m.issueGrant({}, { input: { appId: APP_A, licenseTypeId: TYPE_A, user: HOLDER_A } }, asA),
      ).resolves.toBe("NEW-LICENSE");
      expect(h.dispatched).toHaveLength(1);
    });
  });
});

describe("licence-type-keyed mutations refuse another publisher's type", () => {
  const CASES: Array<[string, (id: string) => unknown]> = [
    ["setLicenseTypeDetails", (id) => ({ input: { licenseTypeId: id, label: "hijacked" } })],
    ["setLicenseTypeTemplate", (id) => ({ input: { licenseTypeId: id, size: "SMALL" } })],
    ["addLicenseTypeService", (id) => ({ input: { licenseTypeId: id, type: "SWITCHBOARD" } })],
    ["addLicenseTypePackage", (id) => ({ input: { licenseTypeId: id, packageName: "@evil/pkg" } })],
    ["publishLicenseType", (id) => ({ licenseTypeId: id })],
    ["retireLicenseType", (id) => ({ licenseTypeId: id })],
  ];

  it.each(CASES)("%s: refused, nothing dispatched; own type works", async (field, args) => {
    const h = makeHarness();
    const err = await rejection(h.m[field]({}, args(TYPE_B), asA));
    expect(err).toBeInstanceOf(UnknownLicenseTypeError);
    h.expectNoWrite();
    h.expectNoDataRead();

    // positive control: the same call on A's own type is dispatched
    await expect(h.m[field]({}, args(TYPE_A), asA)).resolves.toBe(true);
    expect(h.dispatched.map((d) => d.id)).toEqual([TYPE_A]);
  });

  it.each(CASES)("%s: B's type is refused with the same text as a missing one", async (field, args) => {
    const h = makeHarness();
    const theirs = await rejection(h.m[field]({}, args(TYPE_B), asA));
    const missing = await rejection(h.m[field]({}, args(GHOST_TYPE), asA));
    expect(theirs.name).toBe(missing.name);
    expect(theirs.message).toBe(missing.message);
    // and it does not echo the id, which would let A confirm B's ids
    expect(theirs.message).not.toContain(TYPE_B);
    h.expectNoWrite();
  });

  it("the BUILT schema's SetLicenseTypeDetailsInput has no app field", () => {
    // Second half of the defence: GraphQL rejects an `app` at the boundary
    // only because the input does not define one. Read from the built type
    // map, not from the SDL text.
    const input = buildASTSchema(schema).getType("SetLicenseTypeDetailsInput") as
      | GraphQLInputObjectType
      | undefined;
    expect(input).toBeDefined();
    const fields = Object.keys(input!.getFields());
    expect(fields).toContain("licenseTypeId");
    expect(fields).not.toContain("app");
  });

  it("setLicenseTypeDetails cannot move a type into another publisher's app", async () => {
    const h = makeHarness();
    // A edits their OWN type and smuggles an `app` pointing at B's app.
    await h.m.setLicenseTypeDetails(
      {},
      { input: { licenseTypeId: TYPE_A, label: "x", app: APP_B } },
      asA,
    );
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].id).toBe(TYPE_A);
    for (const a of h.dispatched[0].actions) {
      // asserted on the dispatched action, not on the resolver's arguments
      expect(a.input as Record<string, unknown>).not.toHaveProperty("app");
      expect(JSON.stringify(a)).not.toContain(APP_B);
    }

    // The same via B's type is refused before any dispatch.
    const h2 = makeHarness();
    await expect(
      h2.m.setLicenseTypeDetails({}, { input: { licenseTypeId: TYPE_B, app: APP_A } }, asA),
    ).rejects.toBeInstanceOf(UnknownLicenseTypeError);
    h2.expectNoWrite();
  });
});

describe("revokeLicense refuses another publisher's licence", () => {
  const revoke = (id: string) => ({ input: { licenseId: id, reason: "x" } });

  it("B's licence: refused, nothing dispatched; own licence is revoked", async () => {
    const h = makeHarness();
    const err = await rejection(h.m.revokeLicense({}, revoke(LIC_B), asA));
    expect(err).toBeInstanceOf(UnknownLicenseError);
    h.expectNoWrite();
    h.expectNoDataRead();

    await expect(h.m.revokeLicense({}, revoke(LIC_A), asA)).resolves.toBe(true);
    expect(h.licenseGateway.execute).toHaveBeenCalledTimes(1);
    expect(h.licenseGateway.execute.mock.calls[0][0]).toBe(LIC_A);
  });

  it("B's licence is refused with the same text as a missing one", async () => {
    const h = makeHarness();
    const theirs = await rejection(h.m.revokeLicense({}, revoke(LIC_B), asA));
    const missing = await rejection(h.m.revokeLicense({}, revoke(GHOST_LIC), asA));
    expect(theirs.name).toBe(missing.name);
    expect(theirs.message).toBe(missing.message);
    expect(theirs.message).not.toContain(LIC_B);
    h.expectNoWrite();
  });
});

describe("error wording does not distinguish 'not yours' from 'does not exist'", () => {
  // The two app-level errors differ in class but must not differ in text.
  const APP_KEYED: Array<[string, "q" | "m", string, (id: string) => unknown]> = [
    ["licenseTypes", "q", "licenseTypes", (id) => ({ appId: id })],
    ["licenses", "q", "licenses", (id) => ({ appId: id })],
    ["environments", "q", "environments", (id) => ({ appId: id })],
    ["createLicenseType", "m", "createLicenseType", (id) => ({ input: { appId: id, kind: "pro" } })],
    ["issueGrant", "m", "issueGrant", (id) => ({ input: { appId: id, licenseTypeId: TYPE_A, user: HOLDER_A } })],
  ];

  it.each(APP_KEYED)("%s: B's app and a missing app read the same", async (_n, kind, field, args) => {
    const h = makeHarness();
    const target = kind === "q" ? h.q : h.m;
    const theirs = await rejection(target[field]({}, args(APP_B), asA));
    const missing = await rejection(target[field]({}, args(GHOST_APP), asA));
    expect(theirs).toBeInstanceOf(NotAppOwnerError);
    expect(missing).toBeInstanceOf(UnknownAppError);
    // Same text once the typed id is normalised, and nothing but that id.
    expect(sans(theirs, APP_B)).toBe(sans(missing, GHOST_APP));
    expect(sans(theirs, APP_B)).toBe("no app <id>");
    h.expectNoWrite();
    h.expectNoDataRead();
  });
});
