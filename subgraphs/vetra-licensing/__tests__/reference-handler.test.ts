import { describe, it, expect, vi } from "vitest";
import { LicenseHandler } from "../reference-handler/handler.js";

const logger = { info: vi.fn(), warn: vi.fn() };

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
  it("applies a template for an active licence with no environment", async () => {
    const c = client();
    await new LicenseHandler(c as never, logger).reconcileOnce();
    expect(c.applyEnvironmentTemplate).toHaveBeenCalledWith({
      licenseId: "lic-1",
      label: "2026-free-tier",
    });
  });

  it("is a no-op on the second run", async () => {
    const c = client({ appUserEnvironments: vi.fn(async () => [env("hash-1")]) });
    await new LicenseHandler(c as never, logger).reconcileOnce();
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
    await new LicenseHandler(c as never, logger).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(c.releaseEnvironment).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("lic-1"));
  });

  it("releases an environment whose licence is gone", async () => {
    const c = client({
      appLicenses: vi.fn(async () => []),
      appUserEnvironments: vi.fn(async () => [env("hash-1")]),
    });
    await new LicenseHandler(c as never, logger).reconcileOnce();
    expect(c.releaseEnvironment).toHaveBeenCalledWith({ environmentId: "env-1" });
  });
});
