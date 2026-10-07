import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ProvisioningKeeper,
  type ProvisioningKeeperDeps,
} from "../provisioning-keeper.js";
import type { LicenseFullRow } from "../reads.js";
import type { UserEnvironment } from "../plan.js";

const cfg = {
  enabled: true,
  dryRun: false,
  scanIntervalMs: 60_000,
  defaultMaxEnvironments: 50,
};

const lic = (over: Partial<LicenseFullRow>): LicenseFullRow => ({
  id: "lic-1",
  app: "app-a",
  user: "0x1111111111111111111111111111111111111111",
  licenseTypeId: "type-a",
  status: "ACTIVE",
  start: null,
  end: null,
  ...over,
});

const types: Record<string, { id: string; kind: string; status: string; templateHash: string }[]> = {
  "app-a": [{ id: "type-a", kind: "PRO", status: "ACTIVE", templateHash: "hash-a" }],
  "app-b": [{ id: "type-b", kind: "PRO", status: "ACTIVE", templateHash: "hash-b" }],
};

const deps = (
  over: Partial<ProvisioningKeeperDeps> = {},
  licences: LicenseFullRow[] = [lic({})],
  envs: Record<string, UserEnvironment[]> = {},
) => {
  const base = {
  allLicenses: vi.fn(async () => licences),
  licenseTypes: vi.fn(async (appId: string) => types[appId] ?? []),
  environments: vi.fn(async (appId: string) => envs[appId] ?? []),
  applyFor: vi.fn(async () => undefined),
  releaseFor: vi.fn(async () => undefined),
  cfg,
  logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { ...base, ...over } as typeof base;
};

describe("ProvisioningKeeper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies an active licence with its type's template hash", async () => {
    const d = deps();
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).toHaveBeenCalledTimes(1);
    expect(d.applyFor).toHaveBeenCalledWith("app-a", {
      licenseId: "lic-1",
      user: "0x1111111111111111111111111111111111111111",
      licenseTypeId: "type-a",
      templateHash: "hash-a",
    });
  });

  it("ignores licences that are not ACTIVE", async () => {
    const d = deps({}, [lic({ status: "ISSUED" }), lic({ id: "l2", status: "EXPIRED" })]);
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).not.toHaveBeenCalled();
  });

  it("skips a licence whose type is missing, finishes the tick, and still applies the other app", async () => {
    const d = deps({}, [
      lic({ id: "orphan", licenseTypeId: "type-gone" }),
      lic({ id: "lic-b", app: "app-b", licenseTypeId: "type-b" }),
    ]);
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).toHaveBeenCalledTimes(1);
    expect(d.applyFor).toHaveBeenCalledWith(
      "app-b",
      expect.objectContaining({ licenseId: "lic-b", templateHash: "hash-b" }),
    );
    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("orphan"),
    );
  });

  it("applies an active licence whose type is RETIRED, with that type's hash", async () => {
    const d = deps(
      {
        licenseTypes: vi.fn(async () => [
          { id: "type-a", kind: "PRO", status: "RETIRED", templateHash: "hash-retired" },
        ]),
      },
      [lic({})],
    );
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).toHaveBeenCalledTimes(1);
    expect(d.applyFor).toHaveBeenCalledWith(
      "app-a",
      expect.objectContaining({ licenseId: "lic-1", templateHash: "hash-retired" }),
    );
  });

  it("holds the environment of a user whose active licence has a missing type: no release, no apply", async () => {
    const d = deps({}, [lic({ licenseTypeId: "type-gone" })], {
      "app-a": [
        { user: "0x1111111111111111111111111111111111111111", environmentId: "env-held", licenseId: "lic-1", templateHash: "hash-a" },
      ],
    });
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor.mock.calls).toEqual([]);
    expect(d.applyFor).not.toHaveBeenCalled();
    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("env-held"),
    );
  });

  it("holds regardless of address case: checksummed licence, lowercased environment row", async () => {
    const d = deps(
      {},
      [lic({ licenseTypeId: "type-gone", user: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" })],
      {
        "app-a": [
          { user: "0xabcdef0123456789abcdef0123456789abcdef01", environmentId: "env-case", licenseId: "lic-1", templateHash: "hash-a" },
        ],
      },
    );
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor).not.toHaveBeenCalled();
  });

  it("holds regardless of address case: lowercase licence, checksummed environment row", async () => {
    // Mirror of the case above. Real rows are lowercased on write
    // (provision.ts), so this direction is defensive only; it pins the
    // precedent computeLicensePlan sets, that the invariant is enforced here
    // rather than assumed of the caller.
    const d = deps(
      {},
      [lic({ licenseTypeId: "type-gone", user: "0xabcdef0123456789abcdef0123456789abcdef01" })],
      {
        "app-a": [
          { user: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", environmentId: "env-case2", licenseId: "lic-1", templateHash: "hash-a" },
        ],
      },
    );
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor.mock.calls).toEqual([]);
  });

  it("still releases a user with no active licence while holding another user's environment", async () => {
    const d = deps(
      {},
      [
        lic({ id: "lic-held", licenseTypeId: "type-gone" }),
        lic({ id: "lic-revoked", status: "REVOKED", user: "0x2222222222222222222222222222222222222222" }),
      ],
      {
        "app-a": [
          { user: "0x1111111111111111111111111111111111111111", environmentId: "env-held", licenseId: "lic-held", templateHash: "h" },
          { user: "0x2222222222222222222222222222222222222222", environmentId: "env-gone", licenseId: "lic-revoked", templateHash: "h" },
        ],
      },
    );
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor).toHaveBeenCalledTimes(1);
    expect(d.releaseFor).toHaveBeenCalledWith("app-a", "env-gone");
  });

  it("a transient empty licenseTypes read releases nothing for the app", async () => {
    const d = deps({ licenseTypes: vi.fn(async () => []) }, [lic({})], {
      "app-a": [
        { user: "0x1111111111111111111111111111111111111111", environmentId: "env-1", licenseId: "lic-1", templateHash: "hash-a" },
      ],
    });
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor).not.toHaveBeenCalled();
    expect(d.applyFor).not.toHaveBeenCalled();
  });

  it("skips and logs a licence with a falsy app", async () => {
    const d = deps({}, [lic({ id: "noapp", app: "" }), lic({})]);
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).toHaveBeenCalledTimes(1);
    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("noapp"),
    );
  });

  it("logs a failing applyFor and still applies the rest and releases", async () => {
    const d = deps(
      {},
      [
        lic({ id: "lic-1" }),
        lic({ id: "lic-2", user: "0x2222222222222222222222222222222222222222" }),
      ],
      {
        "app-a": [
          { user: "0x3333333333333333333333333333333333333333", environmentId: "env-old", licenseId: "x", templateHash: "h" },
        ],
      },
    );
    d.applyFor.mockRejectedValueOnce(new Error("boom"));
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).toHaveBeenCalledTimes(2);
    expect(d.releaseFor).toHaveBeenCalledWith("app-a", "env-old");
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("isolates a failing release from the other releases", async () => {
    const d = deps({}, [lic({ status: "REVOKED" })], {
      "app-a": [
        { user: "0xaaaa", environmentId: "env-1", licenseId: "x", templateHash: "h" },
        { user: "0xbbbb", environmentId: "env-2", licenseId: "y", templateHash: "h" },
      ],
    });
    d.releaseFor.mockRejectedValueOnce(new Error("stuck"));
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor).toHaveBeenCalledTimes(2);
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stuck"));
  });

  it("releases the environment of an app whose only licence is no longer active", async () => {
    const d = deps({}, [lic({ status: "REVOKED" })], {
      "app-a": [
        { user: "0x1111111111111111111111111111111111111111", environmentId: "env-1", licenseId: "lic-1", templateHash: "hash-a" },
      ],
    });
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.releaseFor).toHaveBeenCalledWith("app-a", "env-1");
    expect(d.applyFor).not.toHaveBeenCalled();
  });

  it("does not apply a licence whose environment already matches", async () => {
    const d = deps({}, [lic({})], {
      "app-a": [
        { user: "0x1111111111111111111111111111111111111111", environmentId: "env-1", licenseId: "lic-1", templateHash: "hash-a" },
      ],
    });
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).not.toHaveBeenCalled();
    expect(d.releaseFor).not.toHaveBeenCalled();
  });

  it("an app whose reads fail does not stop the other apps", async () => {
    const d = deps(
      {
        licenseTypes: vi.fn(async (appId: string) => {
          if (appId === "app-a") throw new Error("read failed");
          return types[appId] ?? [];
        }),
      },
      [lic({}), lic({ id: "lic-b", app: "app-b", licenseTypeId: "type-b" })],
    );
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).toHaveBeenCalledTimes(1);
    expect(d.applyFor).toHaveBeenCalledWith("app-b", expect.anything());
    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("read failed"),
    );
  });

  it("does nothing when disabled", async () => {
    const d = deps({ cfg: { ...cfg, enabled: false } });
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.allLicenses).not.toHaveBeenCalled();
    expect(d.applyFor).not.toHaveBeenCalled();
    expect(d.releaseFor).not.toHaveBeenCalled();
  });

  it("logs but does not act in dry run", async () => {
    const d = deps({ cfg: { ...cfg, dryRun: true } }, [lic({})], {
      "app-a": [
        { user: "0x9999999999999999999999999999999999999999", environmentId: "env-z", licenseId: "z", templateHash: "h" },
      ],
    });
    await new ProvisioningKeeper(d).reconcileOnce();
    expect(d.applyFor).not.toHaveBeenCalled();
    expect(d.releaseFor).not.toHaveBeenCalled();
    expect(d.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("would apply 1, release 1"),
    );
  });

  it("does not start a second reconcile while one is in flight", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const d = deps({ allLicenses: vi.fn(async () => { await gate; return []; }) });
    const keeper = new ProvisioningKeeper(d);
    keeper.start();
    expect(d.allLicenses).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(cfg.scanIntervalMs * 3);
    expect(d.allLicenses).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(cfg.scanIntervalMs);
    expect(d.allLicenses).toHaveBeenCalledTimes(2);
    keeper.stop();
  });

  it("releases the re-entrancy guard after a throwing tick, so the next tick runs", async () => {
    vi.useFakeTimers();
    const allLicenses = vi
      .fn<() => Promise<LicenseFullRow[]>>()
      .mockRejectedValueOnce(new Error("first tick fails"))
      .mockResolvedValue([lic({})]);
    const d = deps({ allLicenses });
    const keeper = new ProvisioningKeeper(d);
    keeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.applyFor).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(cfg.scanIntervalMs);
    expect(allLicenses).toHaveBeenCalledTimes(2);
    expect(d.applyFor).toHaveBeenCalledTimes(1);
    keeper.stop();
  });

  it("logs a failed tick instead of throwing out of the timer", async () => {
    vi.useFakeTimers();
    const d = deps({ allLicenses: vi.fn(async () => { throw new Error("down"); }) });
    const keeper = new ProvisioningKeeper(d);
    keeper.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining("down"));
    keeper.stop();
  });
});
