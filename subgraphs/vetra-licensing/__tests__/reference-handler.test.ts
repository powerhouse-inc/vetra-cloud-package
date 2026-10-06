import { describe, it, expect, vi, beforeEach } from "vitest";
import { LicenseHandler } from "../reference-handler/handler.js";

const logger = { info: vi.fn(), warn: vi.fn() };

/** Dry run is the default; every behavioural test opts out of it explicitly. */
const acting = (c: unknown) =>
  new LicenseHandler(c as never, logger, { dryRun: false });

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
});

const client = (over: Record<string, unknown> = {}) => ({
  appLicenses: vi.fn(async () => [
    {
      id: "lic-1",
      user: "0xaaa",
      licenseTypeId: "type-1",
      status: "ACTIVE",
      start: null,
      end: null,
    },
  ]),
  appLicenseTypes: vi.fn(async () => [
    {
      id: "type-1",
      kind: "2026-free-tier",
      status: "ACTIVE",
      templateHash: "hash-1",
    },
  ]),
  appUserEnvironments: vi.fn(async () => []),
  applyEnvironmentTemplate: vi.fn(async () => ({ environmentId: "env-1" })),
  releaseEnvironment: vi.fn(async () => true),
  ...over,
});

const env = (templateHash: string) => ({
  user: "0xaaa",
  environmentId: "env-1",
  templateHash,
  licenseId: "lic-1",
  appId: "app-1",
});

describe("LicenseHandler", () => {
  // The handler a publisher just generated logs its plan before it is trusted
  // to act, so the default must change nothing.
  it("defaults to a dry run that only logs the plan", async () => {
    const c = client();
    await new LicenseHandler(c as never, logger).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("dry run"),
    );
  });

  it("names the licence it would apply in the dry-run log", async () => {
    const c = client();
    await new LicenseHandler(c as never, logger).reconcileOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("lic-1"));
  });

  // The licence document may carry a checksummed address; the environment
  // table stores it lowercased. Both must mean the same user.
  it("matches a checksummed licence address to a lowercased environment", async () => {
    const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
    const c = client({
      appLicenses: vi.fn(async () => [
        {
          id: "lic-1",
          user: mixed,
          licenseTypeId: "type-1",
          status: "ACTIVE",
          start: null,
          end: null,
        },
      ]),
      appUserEnvironments: vi.fn(async () => [
        { ...env("hash-1"), user: mixed.toLowerCase() },
      ]),
    });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
  });

  it("applies a template for an active licence with no environment", async () => {
    const c = client();
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).toHaveBeenCalledWith({
      licenseId: "lic-1",
      label: "2026-free-tier",
    });
  });

  it("is a no-op on the second run", async () => {
    const c = client({ appUserEnvironments: vi.fn(async () => [env("hash-1")]) });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
  });

  // The environment's hash is stale, so a handler that merely dropped the
  // licence but kept the environment would see "no licence justifies env-1"
  // and release it. Parking the user must prevent that.
  it("skips a licence whose type is retired and releases nothing", async () => {
    const c = client({
      appLicenseTypes: vi.fn(async () => [
        {
          id: "type-1",
          kind: "2026-free-tier",
          status: "RETIRED",
          templateHash: "hash-1",
        },
      ]),
      appUserEnvironments: vi.fn(async () => [env("stale")]),
    });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("lic-1"));
  });

  it("releases an environment whose licence is gone", async () => {
    const c = client({
      appLicenses: vi.fn(async () => []),
      appUserEnvironments: vi.fn(async () => [env("hash-1")]),
    });
    await acting(c).reconcileOnce();
    expect(c.releaseEnvironment).toHaveBeenCalledWith({ environmentId: "env-1" });
  });
});
