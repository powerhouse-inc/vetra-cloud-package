import { describe, it, expect, vi } from "vitest";
import type { Kysely } from "kysely";
import {
  createPublisherResolvers,
  UnknownLicenseTypeError,
  UnknownLicenseError,
  type PublisherDeps,
} from "../publisher-resolvers.js";
import { NotAppOwnerError, UnknownAppError } from "../publisher-auth.js";
import { UnauthenticatedError } from "../auth.js";
import type { VetraLicensingDB } from "../db/schema.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOLDER = "0xcccccccccccccccccccccccccccccccccccccccc";

const ctx = (address?: string) =>
  address ? { user: { address, networkId: "eip155", chainId: 1 } } : {};

/** Any property access fails loudly: a refused call must never reach the db. */
const throwingDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`database touched: ${String(prop)}`);
    },
  },
) as unknown as Kysely<VetraLicensingDB>;

/** A db whose only supported query is the app_user_environments select. */
function envDb(rows: Array<Record<string, string>>) {
  const where = vi.fn();
  const chain: Record<string, unknown> = {
    selectAll: () => chain,
    where: (...a: unknown[]) => {
      where(...a);
      return chain;
    },
    execute: async () => rows,
  };
  const db = {
    selectFrom: vi.fn((t: string) => {
      if (t !== "app_user_environments") throw new Error(`unexpected ${t}`);
      return chain;
    }),
  } as unknown as Kysely<VetraLicensingDB>;
  return { db, where };
}

const template = {
  services: [{ id: "s1", type: "SWITCHBOARD", prefix: "api" }],
  packages: [{ id: "p1", packageName: "@x/y", version: "1.0.0" }],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};

function makeDeps(over: { cfgEnabled?: boolean } = {}) {
  const reads = {
    licenses: vi.fn(async () => [
      {
        id: "L1",
        user: HOLDER,
        licenseTypeId: "T1",
        status: "ACTIVE",
        start: null,
        end: null,
      },
      {
        id: "L2",
        user: STRANGER,
        licenseTypeId: "T1",
        status: "ACTIVE",
        start: null,
        end: null,
      },
    ]),
    licenseTypes: vi.fn(),
    licenseTypeDetails: vi.fn(async () => [
      {
        id: "T1",
        kind: "pro",
        label: "Pro",
        status: "PUBLISHED",
        validityDays: 30,
        templateHash: "h",
        template,
      },
    ]),
    licenseType: vi.fn(),
    templateFor: vi.fn(),
    listLicenses: vi.fn(),
    allLicenses: vi.fn(),
  };
  const auth = {
    findAppById: vi.fn(async (id: string) =>
      id === "app-1"
        ? { id, name: "KV", status: "ACTIVE", owner_address: OWNER }
        : null,
    ),
    listAppsForOwner: vi.fn(async () => [
      { id: "app-1", name: "KV", status: "ACTIVE", owner_address: OWNER },
    ]),
  };
  const deps = {
    auth,
    reads,
    cfg: { enabled: over.cfgEnabled ?? true },
  } as unknown as PublisherDeps;
  return { deps, reads, auth };
}

const Q = (r: Record<string, unknown>) =>
  r.VetraPublisherQueries as Record<
    string,
    (p: unknown, a: unknown, c: unknown) => Promise<unknown>
  >;

const expectNoReads = (reads: Record<string, ReturnType<typeof vi.fn>>) => {
  for (const fn of Object.values(reads)) expect(fn).not.toHaveBeenCalled();
};

describe("publisher queries: refusal", () => {
  const fields: Array<[string, Record<string, unknown>]> = [
    ["licenseTypes", { appId: "app-1" }],
    ["licenses", { appId: "app-1", status: null }],
    ["environments", { appId: "app-1" }],
  ];

  it.each(fields)(
    "%s refuses a stranger and touches neither the db nor the reads",
    async (field, args) => {
      const { deps, reads } = makeDeps();
      const q = Q(createPublisherResolvers(throwingDb, deps));
      await expect(q[field]({}, args, ctx(STRANGER))).rejects.toBeInstanceOf(
        NotAppOwnerError,
      );
      expectNoReads(reads);
    },
  );

  it.each(fields)("%s refuses an anonymous caller", async (field, args) => {
    const { deps, reads, auth } = makeDeps();
    const q = Q(createPublisherResolvers(throwingDb, deps));
    await expect(q[field]({}, args, ctx())).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(auth.findAppById).not.toHaveBeenCalled();
    expectNoReads(reads);
  });

  it.each(fields)("%s reports an unknown app", async (field, args) => {
    const { deps, reads } = makeDeps();
    const q = Q(createPublisherResolvers(throwingDb, deps));
    await expect(
      q[field]({}, { ...args, appId: "nope" }, ctx(OWNER)),
    ).rejects.toBeInstanceOf(UnknownAppError);
    expectNoReads(reads);
  });

  it("myApps refuses an anonymous caller without listing", async () => {
    const { deps, auth } = makeDeps();
    const q = Q(createPublisherResolvers(throwingDb, deps));
    await expect(q.myApps({}, {}, ctx())).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(auth.listAppsForOwner).not.toHaveBeenCalled();
  });
});

describe("publisher queries: reads", () => {
  it("myApps lists the caller's apps with names from the owner records", async () => {
    const { deps, auth } = makeDeps();
    const q = Q(createPublisherResolvers(throwingDb, deps));
    await expect(q.myApps({}, {}, ctx(OWNER.toUpperCase()))).resolves.toEqual([
      { id: "app-1", name: "KV", status: "ACTIVE" },
    ]);
    expect(auth.listAppsForOwner).toHaveBeenCalledWith(OWNER);
  });

  it("returns licence types with their services and packages", async () => {
    const { deps, reads } = makeDeps();
    const q = Q(createPublisherResolvers(throwingDb, deps));
    await expect(
      q.licenseTypes({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toEqual([
      {
        id: "T1",
        kind: "pro",
        label: "Pro",
        status: "PUBLISHED",
        validityDays: 30,
        templateHash: "h",
        services: template.services,
        packages: template.packages,
      },
    ]);
    expect(reads.licenseTypeDetails).toHaveBeenCalledWith("app-1");
  });

  it("serves every read even when licensing is disabled", async () => {
    const { deps } = makeDeps({ cfgEnabled: false });
    const { db } = envDb([]);
    const q = Q(createPublisherResolvers(db, deps));
    await expect(q.myApps({}, {}, ctx(OWNER))).resolves.toHaveLength(1);
    await expect(
      q.licenseTypes({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toHaveLength(1);
    await expect(
      q.licenses({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toHaveLength(2);
    await expect(
      q.environments({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toEqual([]);
  });

  it("joins each licence to its environment id, or null when it has none", async () => {
    const { deps, reads } = makeDeps();
    const { db, where } = envDb([
      {
        app_id: "app-1",
        user_address: HOLDER,
        environment_id: "env-9",
        license_id: "L1",
        template_hash: "h",
      },
    ]);
    const q = Q(createPublisherResolvers(db, deps));
    const out = (await q.licenses(
      {},
      { appId: "app-1", status: "ACTIVE" },
      ctx(OWNER),
    )) as Array<{ id: string; environmentId: string | null }>;
    expect(out.map((l) => [l.id, l.environmentId])).toEqual([
      ["L1", "env-9"],
      ["L2", null],
    ]);
    expect(reads.licenses).toHaveBeenCalledWith("app-1", "ACTIVE");
    expect(where).toHaveBeenCalledWith("app_id", "=", "app-1");
  });

  it("joins case-insensitively on the holder address", async () => {
    const { deps } = makeDeps();
    const { db } = envDb([
      {
        app_id: "app-1",
        user_address: HOLDER.toUpperCase(),
        environment_id: "env-9",
        license_id: "L1",
        template_hash: "h",
      },
    ]);
    const q = Q(createPublisherResolvers(db, deps));
    const out = (await q.licenses(
      {},
      { appId: "app-1" },
      ctx(OWNER),
    )) as Array<{ environmentId: string | null }>;
    expect(out[0].environmentId).toBe("env-9");
  });

  it("environments maps rows to the GraphQL shape", async () => {
    const { deps } = makeDeps();
    const { db } = envDb([
      {
        app_id: "app-1",
        user_address: HOLDER,
        environment_id: "env-9",
        license_id: "L1",
        template_hash: "h",
      },
    ]);
    const q = Q(createPublisherResolvers(db, deps));
    await expect(
      q.environments({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toEqual([
      {
        appId: "app-1",
        user: HOLDER,
        environmentId: "env-9",
        licenseId: "L1",
        templateHash: "h",
      },
    ]);
  });
});

describe("unknown-id errors", () => {
  it("do not distinguish another publisher's id from a missing one", () => {
    expect(new UnknownLicenseTypeError().message).toBe("no such licence type");
    expect(new UnknownLicenseError().message).toBe("no such licence");
  });
});
