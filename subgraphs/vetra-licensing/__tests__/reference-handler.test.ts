import { describe, it, expect, vi, beforeEach } from "vitest";
import { LicenseHandler } from "../reference-handler/handler.js";

const logger = { info: vi.fn(), warn: vi.fn() };

/** Dry run is the default; every behavioural test opts out of it explicitly. */
const acting = (c: unknown) => new LicenseHandler(c as never, logger, { dryRun: false });

beforeEach(() => {
  logger.info.mockClear();
  logger.warn.mockClear();
});

const DID = "did:pkh:eip155:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const client = (over: Record<string, unknown> = {}) => ({
  appLicenses: vi.fn(async () => [{ id: "lic-1", user: DID, kind: "pro", status: "ACTIVE" }]),
  appTerms: vi.fn(async () => [
    { id: "term-1", kind: "pro", status: "ACTIVE", templateHash: "hash-1" },
    // SHARED: no environment of its own, so no hash.
    { id: "term-2", kind: "free", status: "ACTIVE", templateHash: null },
    { id: "term-3", kind: "beta", status: "DRAFT", templateHash: "hash-3" },
  ]),
  appUserEnvironments: vi.fn(async () => []),
  applyEnvironmentTemplate: vi.fn(async () => ({ environmentId: "env-1" })),
  ...over,
});

const env = (licenseId: string, templateHash: string) => ({ environmentId: "env-1", licenseId, templateHash });

describe("LicenseHandler (reference client)", () => {
  // The handler a publisher just generated logs its plan before it is trusted
  // to act, so the default must change nothing.
  it("defaults to a dry run that only logs the plan, naming the licences", async () => {
    const c = client();
    await new LicenseHandler(c as never, logger).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("dry run"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("lic-1"));
  });

  it("asks only for ACTIVE licences", async () => {
    const c = client();
    await acting(c).reconcileOnce();
    expect(c.appLicenses).toHaveBeenCalledWith({ status: "ACTIVE" });
  });

  it("applies the template for an ACTIVE licence with no environment, labelled with its kind", async () => {
    const c = client();
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).toHaveBeenCalledExactlyOnceWith({ licenseId: "lic-1", label: "pro" });
  });

  it("is a no-op when the environment is current", async () => {
    const c = client({ appUserEnvironments: vi.fn(async () => [env("lic-1", "hash-1")]) });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
  });

  it("re-applies a stale template", async () => {
    const c = client({ appUserEnvironments: vi.fn(async () => [env("lic-1", "old-hash")]) });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).toHaveBeenCalledExactlyOnceWith({ licenseId: "lic-1", label: "pro" });
  });

  it("applies a renewal, whose chain's environment still names its predecessor (Vetra repoints it)", async () => {
    const c = client({
      appLicenses: vi.fn(async () => [{ id: "lic-2", user: DID, kind: "pro", status: "ACTIVE" }]),
      appUserEnvironments: vi.fn(async () => [env("lic-1", "hash-1")]),
    });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).toHaveBeenCalledExactlyOnceWith({ licenseId: "lic-2", label: "pro" });
  });

  it("logs and skips a licence whose kind has no usable term, and leaves SHARED licences alone", async () => {
    const c = client({
      appLicenses: vi.fn(async () => [
        { id: "lic-x", user: DID, kind: "gone", status: "ACTIVE" },
        { id: "lic-b", user: DID, kind: "beta", status: "ACTIVE" },
        { id: "lic-f", user: DID, kind: "free", status: "ACTIVE" },
      ]),
    });
    await acting(c).reconcileOnce();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("lic-x"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("lic-b"));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("lic-f"));
  });

  it("never releases: an environment without a licence is left to Vetra's offboarding clock", async () => {
    // A client that still offers release (the old API): never called.
    const releaseEnvironment = vi.fn(async () => true);
    const c = client({
      appLicenses: vi.fn(async () => []),
      appUserEnvironments: vi.fn(async () => [env("lic-gone", "hash-1")]),
      releaseEnvironment,
    });
    await acting(c).reconcileOnce();
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(c.applyEnvironmentTemplate).not.toHaveBeenCalled();
  });

  it("logs a failed apply and carries on with the next licence", async () => {
    const apply = vi.fn(async (input: { licenseId: string }) => {
      if (input.licenseId === "lic-1") throw new Error("boom");
      return { environmentId: "env-2" };
    });
    const c = client({
      appLicenses: vi.fn(async () => [
        { id: "lic-1", user: DID, kind: "pro", status: "ACTIVE" },
        { id: "lic-2", user: DID, kind: "pro", status: "ACTIVE" },
      ]),
      applyEnvironmentTemplate: apply,
    });
    await acting(c).reconcileOnce();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
