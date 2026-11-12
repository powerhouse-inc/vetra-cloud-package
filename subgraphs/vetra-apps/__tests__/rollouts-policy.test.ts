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
});
