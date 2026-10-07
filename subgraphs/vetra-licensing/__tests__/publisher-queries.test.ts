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

const envRow = (app: string, user: string, env: string) => ({
  app_id: app,
  user_address: user,
  environment_id: env,
  license_id: `L-${env}`,
  template_hash: "h",
});

/**
 * A db whose only supported query is the app_user_environments select. It
 * honours every `where(col, "=", value)` it is given, so dropping a filter in
 * the resolver changes the rows returned, not just the calls made.
 */
function envDb(rows: Array<Record<string, string>>) {
  const filters: Array<[string, string]> = [];
  const chain: Record<string, unknown> = {
    selectAll: () => chain,
    where: (col: string, op: string, val: string) => {
      if (op !== "=") throw new Error(`unsupported operator ${op}`);
      filters.push([col, val]);
      return chain;
    },
    execute: async () =>
      rows.filter((r) => filters.every(([c, v]) => r[c] === v)),
  };
  return {
    selectFrom: (t: string) => {
      if (t !== "app_user_environments") throw new Error(`unexpected ${t}`);
      filters.length = 0;
      return chain;
    },
  } as unknown as Kysely<VetraLicensingDB>;
}

const template = {
  services: [{ id: "s1", type: "SWITCHBOARD", prefix: "api" }],
  packages: [{ id: "p1", packageName: "@x/y", version: "1.0.0" }],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};

const lic = (id: string, app: string, user: string, status = "ACTIVE") => ({
  id,
  app,
  user,
  licenseTypeId: "T1",
  status,
  start: null,
  end: null,
});
const ALL_LICENSES = [
  lic("L1", "app-1", HOLDER),
  lic("L2", "app-1", STRANGER),
  lic("L3", "app-1", OWNER, "REVOKED"),
  lic("LX", "app-2", HOLDER),
];
const typeDoc = (id: string, app: string, label: string) => ({
  id,
  app,
  kind: "pro",
  label,
  status: "PUBLISHED",
  validityDays: 30,
  templateHash: "h",
  template,
});
const ALL_TYPES = [typeDoc("T1", "app-1", "Pro"), typeDoc("TX", "app-2", "Other")];

function makeDeps(over: { cfgEnabled?: boolean } = {}) {
  const reads = {
    licenses: vi.fn(async (appId: string, status: string | null) =>
      ALL_LICENSES.filter(
        (l) => l.app === appId && (status === null || l.status === status),
      ).map(({ app: _app, ...l }) => l),
    ),
    licenseTypes: vi.fn(),
    licenseTypeDetails: vi.fn(async (appId: string) =>
      ALL_TYPES.filter((t) => t.app === appId).map(({ app: _app, ...t }) => t),
    ),
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
    const db = envDb([]);
    const q = Q(createPublisherResolvers(db, deps));
    await expect(q.myApps({}, {}, ctx(OWNER))).resolves.toHaveLength(1);
    await expect(
      q.licenseTypes({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toHaveLength(1);
    await expect(
      q.licenses({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toHaveLength(3);
    await expect(
      q.environments({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toEqual([]);
  });

  it("licenseTypes returns only the requested app's types", async () => {
    const { deps } = makeDeps();
    const q = Q(createPublisherResolvers(throwingDb, deps));
    const out = (await q.licenseTypes(
      {},
      { appId: "app-1" },
      ctx(OWNER),
    )) as Array<{ id: string }>;
    expect(out.map((t) => t.id)).toEqual(["T1"]);
  });

  it("licenses returns only the requested app's licences, filtered by status", async () => {
    const { deps } = makeDeps();
    const q = Q(createPublisherResolvers(envDb([]), deps));
    const all = (await q.licenses(
      {},
      { appId: "app-1" },
      ctx(OWNER),
    )) as Array<{ id: string }>;
    expect(all.map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
    const revoked = (await q.licenses(
      {},
      { appId: "app-1", status: "REVOKED" },
      ctx(OWNER),
    )) as Array<{ id: string }>;
    expect(revoked.map((l) => l.id)).toEqual(["L3"]);
  });

  it("joins each licence to its environment id, or null when it has none", async () => {
    const { deps } = makeDeps();
    // HOLDER also has an environment in app-2; it must not bleed into app-1.
    const db = envDb([
      envRow("app-1", HOLDER, "env-1"),
      envRow("app-2", HOLDER, "env-X"),
      envRow("app-2", STRANGER, "env-Y"),
    ]);
    const q = Q(createPublisherResolvers(db, deps));
    const out = (await q.licenses(
      {},
      { appId: "app-1" },
      ctx(OWNER),
    )) as Array<{ id: string; environmentId: string | null }>;
    expect(out.map((l) => [l.id, l.environmentId])).toEqual([
      ["L1", "env-1"],
      ["L2", null],
      ["L3", null],
    ]);
  });

  it("joins case-insensitively on the holder address", async () => {
    const { deps } = makeDeps();
    const db = envDb([envRow("app-1", HOLDER.toUpperCase(), "env-1")]);
    const q = Q(createPublisherResolvers(db, deps));
    const out = (await q.licenses(
      {},
      { appId: "app-1" },
      ctx(OWNER),
    )) as Array<{ environmentId: string | null }>;
    expect(out[0].environmentId).toBe("env-1");
  });

  it("environments returns only the requested app's rows, never another publisher's", async () => {
    const { deps } = makeDeps();
    const db = envDb([
      envRow("app-1", HOLDER, "env-1"),
      envRow("app-2", STRANGER, "env-X"),
    ]);
    const q = Q(createPublisherResolvers(db, deps));
    await expect(
      q.environments({}, { appId: "app-1" }, ctx(OWNER)),
    ).resolves.toEqual([
      {
        appId: "app-1",
        user: HOLDER,
        environmentId: "env-1",
        licenseId: "L-env-1",
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
