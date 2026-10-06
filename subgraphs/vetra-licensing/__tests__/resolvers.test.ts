import { describe, it, expect, vi } from "vitest";
import { createResolvers, type ResolverDeps } from "../resolvers.js";
import { UnauthenticatedError } from "../auth.js";
import { LicensingDisabledError } from "../resolvers.js";

type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;

/**
 * Every property access throws. Any resolver that reaches the database before
 * it has an app identity fails this test loudly rather than silently.
 */
const noDb = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`database touched: ${String(prop)}`);
    },
  },
) as never;

const spies = () => ({
  findAppByIdentityDid: vi.fn(async () => ({ id: "app-1", status: "ACTIVE" })),
  licenses: vi.fn(async () => []),
  licenseTypes: vi.fn(async () => []),
  templateFor: vi.fn(async () => null),
  findRowByEnvironment: vi.fn(async () => null),
  environmentStatus: vi.fn(async () => null),
  stopEnvironment: vi.fn(async () => undefined),
  deleteRow: vi.fn(async () => undefined),
  create: vi.fn(async () => "env-1"),
  execute: vi.fn(async () => undefined),
  getState: vi.fn(async () => null),
  deleteEnv: vi.fn(async () => undefined),
});

const build = (s: ReturnType<typeof spies>, enabled = false) => {
  const deps = {
    auth: { findAppByIdentityDid: s.findAppByIdentityDid },
    provision: {
      envs: {
        create: s.create,
        execute: s.execute,
        getState: s.getState,
        delete: s.deleteEnv,
      },
      generateSubdomain: (id: string) => `sub-${id}`,
    },
    release: {
      findRowByEnvironment: s.findRowByEnvironment,
      environmentStatus: s.environmentStatus,
      stopEnvironment: s.stopEnvironment,
      deleteRow: s.deleteRow,
    },
    cfg: {
      enabled,
      dryRun: true,
      scanIntervalMs: 60_000,
      defaultMaxEnvironments: 50,
    },
    read: {
      licenses: s.licenses,
      licenseTypes: s.licenseTypes,
      templateFor: s.templateFor,
    },
  } as unknown as ResolverDeps;

  return createResolvers(noDb, deps) as unknown as {
    VetraLicensingQueries: Record<string, Field>;
    VetraLicensingMutations: Record<string, Field>;
  };
};

/** Field name → the arguments that field expects. */
const FIELDS: [group: string, field: string, args: unknown][] = [
  ["VetraLicensingQueries", "appLicenses", { status: null }],
  ["VetraLicensingQueries", "appLicenseTypes", {}],
  ["VetraLicensingQueries", "appUserEnvironments", {}],
  [
    "VetraLicensingMutations",
    "applyEnvironmentTemplate",
    { input: { licenseId: "lic-1", label: "Acme" } },
  ],
  [
    "VetraLicensingMutations",
    "releaseEnvironment",
    { input: { environmentId: "env-1" } },
  ],
];

/**
 * The authorization invariant of this subgraph: no field takes an app id from
 * its arguments, and no field touches anything before resolveCallerApp has
 * answered. A context with no appKey must get nowhere.
 */
describe("resolver authorization", () => {
  it.each(FIELDS)("%s.%s rejects a caller with no app identity", async (
    group,
    field,
    args,
  ) => {
    const s = spies();
    const r = build(s);
    const resolve = (
      group === "VetraLicensingQueries"
        ? r.VetraLicensingQueries
        : r.VetraLicensingMutations
    )[field];

    await expect(
      resolve(
        {},
        args,
        { user: { address: "0xAbC", networkId: "eip155", chainId: 1 } },
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    // Nothing was read, nothing was written, nothing was released.
    expect(s.findAppByIdentityDid).not.toHaveBeenCalled();
    expect(s.licenses).not.toHaveBeenCalled();
    expect(s.licenseTypes).not.toHaveBeenCalled();
    expect(s.templateFor).not.toHaveBeenCalled();
    expect(s.findRowByEnvironment).not.toHaveBeenCalled();
    expect(s.stopEnvironment).not.toHaveBeenCalled();
    expect(s.deleteRow).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it.each(FIELDS)("%s.%s rejects an empty context", async (
    group,
    field,
    args,
  ) => {
    const s = spies();
    const r = build(s);
    const resolve = (
      group === "VetraLicensingQueries"
        ? r.VetraLicensingQueries
        : r.VetraLicensingMutations
    )[field];

    await expect(resolve({}, args, {})).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(s.findAppByIdentityDid).not.toHaveBeenCalled();
  });

  // The identity is looked up, so the app id can only ever come from the
  // caller's own did:key — never from an argument.
  it("takes the app id from the caller's identity, not its arguments", async () => {
    const s = spies();
    const r = build(s);
    await r.VetraLicensingQueries.appLicenses({}, { status: "ACTIVE" }, {
      user: {
        address: "0xAbC",
        networkId: "eip155",
        chainId: 1,
        appKey: "did:key:z6MkApp",
      },
    });
    expect(s.findAppByIdentityDid).toHaveBeenCalledWith("did:key:z6MkApp");
    expect(s.licenses).toHaveBeenCalledWith("app-1", "ACTIVE");
  });
});

const APP_CTX = {
  user: {
    address: "0xAbC",
    networkId: "eip155",
    chainId: 1,
    appKey: "did:key:z6MkApp",
  },
};

/**
 * cfg.enabled gates the write path. The database is the throwing Proxy, so a
 * mutation that reaches it fails loudly; every spy below proves nothing was
 * read for, or written on behalf of, a refused call.
 */
describe("licensing disabled", () => {
  const writes: [string, unknown][] = [
    ["applyEnvironmentTemplate", { input: { licenseId: "lic-1", label: "Acme" } }],
    ["releaseEnvironment", { input: { environmentId: "env-1" } }],
  ];

  it.each(writes)("%s is refused and touches neither the database nor the reactor", async (field, args) => {
    const s = spies();
    s.licenses.mockResolvedValue([
      { id: "lic-1", user: "0xaaa", licenseTypeId: "t", status: "ACTIVE", start: null, end: null },
    ] as never);
    s.findRowByEnvironment.mockResolvedValue({ app_id: "app-1", user_address: "0xaaa", environment_id: "env-1" } as never);
    const r = build(s, false);

    const err = await r.VetraLicensingMutations[field]({}, args, APP_CTX).catch((e) => e);
    expect(err).toBeInstanceOf(LicensingDisabledError);
    expect((err as Error).message).toMatch(/licensing is disabled/i);

    expect(s.licenses).not.toHaveBeenCalled();
    expect(s.templateFor).not.toHaveBeenCalled();
    expect(s.findRowByEnvironment).not.toHaveBeenCalled();
    expect(s.environmentStatus).not.toHaveBeenCalled();
    expect(s.stopEnvironment).not.toHaveBeenCalled();
    expect(s.deleteRow).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.deleteEnv).not.toHaveBeenCalled();
  });

  it("applyEnvironmentTemplate proceeds when enabled", async () => {
    const s = spies();
    s.licenses.mockResolvedValue([
      { id: "lic-1", user: "0xaaa", licenseTypeId: "t", status: "ACTIVE", start: null, end: null },
    ] as never);
    const r = build(s, true);
    // templateFor is null, so provisioning stops at LicenseTypeUnavailableError
    // before it would need the database: the call got past the gate.
    await expect(
      r.VetraLicensingMutations.applyEnvironmentTemplate({}, { input: { licenseId: "lic-1", label: "Acme" } }, APP_CTX),
    ).rejects.toThrow(/no usable template/);
    expect(s.licenses).toHaveBeenCalledWith("app-1", "ACTIVE");
    expect(s.templateFor).toHaveBeenCalledWith("lic-1");
  });

  it("releaseEnvironment proceeds when enabled", async () => {
    const s = spies();
    const r = build(s, true);
    await expect(
      r.VetraLicensingMutations.releaseEnvironment({}, { input: { environmentId: "env-1" } }, APP_CTX),
    ).resolves.toBe(false);
    expect(s.findRowByEnvironment).toHaveBeenCalledWith("env-1");
  });

  it("reads keep working when disabled", async () => {
    const s = spies();
    const r = build(s, false);
    await expect(r.VetraLicensingQueries.appLicenses({}, { status: null }, APP_CTX)).resolves.toEqual([]);
    await expect(r.VetraLicensingQueries.appLicenseTypes({}, {}, APP_CTX)).resolves.toEqual([]);
    expect(s.licenses).toHaveBeenCalled();
    expect(s.licenseTypes).toHaveBeenCalled();
  });
});
