import { describe, expect, it } from "vitest";
import {
  compareReleases,
  compareSemver,
  parseVersion,
  powerhouseAtLeast,
  versionKind,
} from "../releases/version.js";

describe("versionKind", () => {
  it("calls plain and alpha/beta/rc.N versions releases", () => {
    for (const v of ["1.4.0", "2.0.0-alpha.0", "2.0.0-beta.12", "2.0.0-rc.1"]) {
      expect(versionKind(v)).toBe("release");
    }
  });
  it("calls every other prerelease a build", () => {
    for (const v of [
      "1.5.0-main.37",
      "2.0.0-beta.2-next.12",
      "1.4.0-pr.12.3",
      "2.0.0-beta",
      "2.0.0-rc.1.2",
    ]) {
      expect(versionKind(v)).toBe("build");
    }
  });
  it("rejects what is not semver", () => {
    for (const v of [
      "v1.4.0",
      "1.4",
      "sha-cac9276bc10b",
      "1.4.0+meta",
      "01.4.0",
      "",
    ]) {
      expect(versionKind(v)).toBeNull();
      expect(parseVersion(v)).toBeNull();
    }
  });
});

describe("compareReleases", () => {
  it("orders releases by semver, prereleases before the final", () => {
    const sorted = [
      "2.0.0",
      "1.4.1",
      "2.0.0-beta.2",
      "2.0.0-rc.1",
      "2.0.0-beta.10",
      "2.0.0-alpha.0",
    ].sort(compareReleases);
    expect(sorted).toStrictEqual([
      "1.4.1",
      "2.0.0-alpha.0",
      "2.0.0-beta.2",
      "2.0.0-beta.10",
      "2.0.0-rc.1",
      "2.0.0",
    ]);
  });
  it("refuses to compare a build", () => {
    expect(() => compareReleases("1.5.0-main.37", "1.4.0")).toThrow(/build/);
  });
});

describe("compareSemver and powerhouseAtLeast", () => {
  it("orders any semver version, prereleases of builds included", () => {
    expect(compareSemver("6.2.3-dev.101", "6.2.3-dev.102")).toBeLessThan(0);
    expect(compareSemver("6.2.3-dev.9", "6.2.3-dev.10")).toBeLessThan(0);
    expect(compareSemver("6.2.3", "6.2.3-dev.999")).toBeGreaterThan(0);
    expect(compareSemver("6.2.3-staging.1", "6.2.3-dev.5")).toBeGreaterThan(0);
    expect(compareSemver("6.3.0-dev.1", "6.2.9")).toBeGreaterThan(0);
    expect(compareSemver("6.2.3-dev.1", "6.2.3-dev.1")).toBe(0);
    expect(() => compareSemver("x", "6.2.3")).toThrow();
  });
  it("is at least the floor, false when either does not parse", () => {
    expect(powerhouseAtLeast("6.3.0", "6.2.3-dev.102")).toBe(true);
    expect(powerhouseAtLeast("6.2.3-dev.102", "6.2.3-dev.102")).toBe(true);
    expect(powerhouseAtLeast("6.2.3-dev.101", "6.2.3-dev.102")).toBe(false);
    expect(powerhouseAtLeast("garbage", "6.2.3")).toBe(false);
    expect(powerhouseAtLeast("", "6.2.3")).toBe(false);
    expect(powerhouseAtLeast("6.3.0", "nope")).toBe(false);
  });
  it("compareReleases still refuses builds", () => {
    expect(() => compareReleases("1.0.0-dev.1", "1.0.0")).toThrow(/build/);
  });
});
