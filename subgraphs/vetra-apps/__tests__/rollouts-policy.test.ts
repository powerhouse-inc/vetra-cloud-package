import { describe, expect, it } from "vitest";
import {
  parsePolicy,
  policyCandidate,
  policyText,
} from "../rollouts/policy.js";

const r = (
  version: string,
  run: number,
  branch = "main",
  withdrawn_at: string | null = null,
) => ({
  version,
  kind: "release" as const,
  branch,
  run,
  withdrawn_at,
});
const RELEASES = [
  r("1.4.0", 100),
  r("1.4.1", 110),
  r("1.4.2-rc.1", 115, "next"),
  r("1.4.3", 116, "main", "2026-11-12T00:00:00.000Z"),
  r("1.5.0", 120),
  r("2.0.0", 130),
  r("2.1.0-beta.1", 140, "next"),
];
const pick = (policy: string, current = "1.4.0") =>
  policyCandidate(parsePolicy(policy), current, RELEASES)?.version ?? null;

describe("policies (spec section 7)", () => {
  it("manual: nothing; patches: the highest stable patch; minor: the highest stable minor; never a major, a prerelease or a withdrawn release", () => {
    expect(pick("manual")).toBeNull();
    expect(pick("patches")).toBe("1.4.1");
    expect(pick("minor")).toBe("1.5.0");
    expect(pick("patches", "1.4.1")).toBeNull();
    expect(pick("minor", "1.5.0")).toBeNull();
  });

  it("follow:<branch>: the newest release of the branch, majors and prereleases too, only when newer than the current one", () => {
    expect(pick("follow:next")).toBe("2.1.0-beta.1");
    expect(pick("follow:main")).toBe("2.0.0");
    expect(pick("follow:main", "2.0.0")).toBeNull();
    expect(pick("follow:next", "2.1.0-beta.1")).toBeNull();
  });

  it("parses and prints; refuses anything else", () => {
    expect(parsePolicy(" follow:release/x ")).toEqual({
      kind: "follow",
      branch: "release/x",
    });
    expect(policyText(parsePolicy("minor"))).toBe("minor");
    expect(policyText(parsePolicy("follow:next"))).toBe("follow:next");
    for (const bad of ["", "auto", "follow:", "majors"])
      expect(() => parsePolicy(bad)).toThrow();
  });

  it("moves nothing from a current version that is not a release, nor backwards", () => {
    expect(pick("patches", "1.4.0-main.3")).toBeNull();
    expect(pick("minor", "nonsense")).toBeNull();
    expect(pick("follow:main", "1.4.0-main.3")).toBeNull();
    // follow takes only a version above the current one, whatever the runs say.
    expect(
      policyCandidate(parsePolicy("follow:hotfix"), "1.5.0", [
        r("1.5.0", 120),
        r("1.4.9", 150, "hotfix"),
      ]),
    ).toBeNull();
  });

  it("from a prerelease: patches and minor take the stable releases above it", () => {
    expect(pick("patches", "1.4.2-rc.1")).toBeNull(); // 1.4.3 is withdrawn
    expect(pick("minor", "1.4.2-rc.1")).toBe("1.5.0");
    expect(
      policyCandidate(parsePolicy("patches"), "1.4.2-rc.1", [
        ...RELEASES,
        r("1.4.2", 117),
      ])?.version,
    ).toBe("1.4.2");
  });

  it("follow skips a withdrawn newest release for the newest unwithdrawn one", () => {
    const releases = [
      r("1.4.0", 100),
      r("1.5.0", 120),
      r("1.6.0", 130, "main", "2026-11-12T00:00:00.000Z"),
    ];
    expect(
      policyCandidate(parsePolicy("follow:main"), "1.4.0", releases)?.version,
    ).toBe("1.5.0");
    expect(
      policyCandidate(parsePolicy("follow:main"), "1.5.0", releases),
    ).toBeNull();
  });

  it("0.x: a minor is a major (semver), so minor takes patches only", () => {
    const releases = [r("0.4.0", 1), r("0.4.2", 2), r("0.5.0", 3)];
    expect(
      policyCandidate(parsePolicy("minor"), "0.4.0", releases)?.version,
    ).toBe("0.4.2");
    expect(
      policyCandidate(parsePolicy("patches"), "0.4.0", releases)?.version,
    ).toBe("0.4.2");
  });

  it("0.0.x: every release may break (semver), so patches and minor take nothing; follow still does", () => {
    const releases = [r("0.0.3", 1), r("0.0.4", 2), r("0.1.0", 3)];
    expect(
      policyCandidate(parsePolicy("patches"), "0.0.3", releases),
    ).toBeNull();
    expect(policyCandidate(parsePolicy("minor"), "0.0.3", releases)).toBeNull();
    expect(
      policyCandidate(parsePolicy("follow:main"), "0.0.3", releases)?.version,
    ).toBe("0.1.0");
  });
});
