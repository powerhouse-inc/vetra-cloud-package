import { describe, it, expect } from "vitest";
import { computeLicensePlan, type ActiveLicense, type UserEnvironment } from "../plan.js";

const lic = (over: Partial<ActiveLicense> = {}): ActiveLicense => ({
  licenseId: "lic-1",
  user: "0xaaa",
  licenseTypeId: "type-1",
  templateHash: "hash-1",
  ...over,
});

const env = (over: Partial<UserEnvironment> = {}): UserEnvironment => ({
  user: "0xaaa",
  environmentId: "env-1",
  templateHash: "hash-1",
  ...over,
});

describe("computeLicensePlan", () => {
  it("applies a licence with no environment", () => {
    expect(computeLicensePlan([lic()], [])).toEqual({
      toApply: [lic()],
      toRelease: [],
    });
  });

  it("does nothing when the environment already matches", () => {
    expect(computeLicensePlan([lic()], [env()])).toEqual({
      toApply: [],
      toRelease: [],
    });
  });

  it("re-applies when the template has changed", () => {
    const plan = computeLicensePlan([lic({ templateHash: "hash-2" })], [env()]);
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toRelease).toEqual([]);
  });

  it("releases an environment with no licence behind it", () => {
    expect(computeLicensePlan([], [env()])).toEqual({
      toApply: [],
      toRelease: ["env-1"],
    });
  });

  // A user holding several active licences must resolve the same way every time.
  it("picks the same licence regardless of input order", () => {
    const a = lic({ licenseId: "lic-a", templateHash: "hash-a" });
    const b = lic({ licenseId: "lic-b", templateHash: "hash-b" });
    const forwards = computeLicensePlan([a, b], []);
    const backwards = computeLicensePlan([b, a], []);
    expect(forwards).toEqual(backwards);
    expect(forwards.toApply).toHaveLength(1);
    expect(forwards.toApply[0].licenseId).toBe("lic-a");
  });

  it("produces an identical plan when users arrive in the opposite order", () => {
    const la = lic({ licenseId: "lic-a", user: "0xaaa", templateHash: "hash-1" });
    const lb = lic({ licenseId: "lic-b", user: "0xbbb", templateHash: "hash-2" });
    const ea = env({ user: "0xccc", environmentId: "env-c", templateHash: "hash-3" });
    const eb = env({ user: "0xddd", environmentId: "env-d", templateHash: "hash-4" });

    expect(computeLicensePlan([la, lb], [ea, eb])).toEqual(
      computeLicensePlan([lb, la], [eb, ea]),
    );
  });

  // Licence documents may carry a checksummed address while the environment
  // table stores it lowercased. Keyed on the raw string, every tick would both
  // release the live environment and create a fresh one.
  it("treats a checksummed and a lowercased address as one user", () => {
    const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
    const plan = computeLicensePlan(
      [lic({ user: mixed })],
      [env({ user: mixed.toLowerCase() })],
    );
    expect(plan).toEqual({ toApply: [], toRelease: [] });
  });

  it("releases nothing for a user whose licence differs only in case", () => {
    const mixed = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
    const plan = computeLicensePlan(
      [lic({ user: mixed, templateHash: "hash-2" })],
      [env({ user: mixed.toLowerCase() })],
    );
    expect(plan.toRelease).toEqual([]);
    expect(plan.toApply).toHaveLength(1);
  });

  it("keeps users independent", () => {
    const plan = computeLicensePlan(
      [lic({ user: "0xaaa" })],
      [env({ user: "0xbbb", environmentId: "env-2" })],
    );
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toRelease).toEqual(["env-2"]);
  });
});
