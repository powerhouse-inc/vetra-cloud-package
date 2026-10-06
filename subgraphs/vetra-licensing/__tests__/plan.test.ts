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

  // Review Focus 2: a user holding two active licences must resolve deterministically.
  it("picks the same licence regardless of input order", () => {
    const a = lic({ licenseId: "lic-a", templateHash: "hash-a" });
    const b = lic({ licenseId: "lic-b", templateHash: "hash-b" });
    const forwards = computeLicensePlan([a, b], []);
    const backwards = computeLicensePlan([b, a], []);
    expect(forwards).toEqual(backwards);
    expect(forwards.toApply).toHaveLength(1);
    expect(forwards.toApply[0].licenseId).toBe("lic-a");
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
