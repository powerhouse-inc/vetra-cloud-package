import { describe, expect, it } from "vitest";
import type { GraphQLError } from "graphql";
import {
  isReleaseBranch,
  matchesBranchPattern,
  parseReleaseBranches,
  validateReleaseBranches,
} from "../releases/branches.js";

const refusal = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    const err = e as GraphQLError;
    return { code: err.extensions?.code, message: err.message };
  }
};

describe("matchesBranchPattern", () => {
  it("matches exact names only when there is no *", () => {
    expect(matchesBranchPattern("next", "next")).toBe(true);
    expect(matchesBranchPattern("next2", "next")).toBe(false);
    expect(matchesBranchPattern("1.x", "1.x")).toBe(true);
    expect(matchesBranchPattern("1yx", "1.x")).toBe(false);
  });

  it("* matches one or more characters within one path segment", () => {
    expect(matchesBranchPattern("1.x", "*.x")).toBe(true);
    expect(matchesBranchPattern("12.x", "*.x")).toBe(true);
    expect(matchesBranchPattern(".x", "*.x")).toBe(false);
    expect(matchesBranchPattern("release/2.0", "release/*")).toBe(true);
    expect(matchesBranchPattern("release/2.0/rc", "release/*")).toBe(false);
    expect(matchesBranchPattern("release/", "release/*")).toBe(false);
    expect(matchesBranchPattern("a/1.x", "*.x")).toBe(false);
  });
});

describe("isReleaseBranch", () => {
  it("is true for the production branch and listed branches", () => {
    expect(isReleaseBranch("main", "main", [])).toBe(true);
    expect(isReleaseBranch("next", "main", [])).toBe(false);
    expect(isReleaseBranch("next", "main", ["next", "*.x"])).toBe(true);
    expect(isReleaseBranch("2.x", "main", ["next", "*.x"])).toBe(true);
    expect(isReleaseBranch("feature/a", "main", ["next", "*.x"])).toBe(false);
  });
});

describe("validateReleaseBranches", () => {
  it("accepts exact names and single-segment patterns, trims and dedupes in order", () => {
    expect(
      validateReleaseBranches([" next ", "*.x", "release/*", "next", "1.x"]),
    ).toStrictEqual(["next", "*.x", "release/*", "1.x"]);
    expect(validateReleaseBranches([])).toStrictEqual([]);
  });

  it("refuses invalid entries with BAD_USER_INPUT naming the entry", () => {
    for (const bad of [
      "",
      "a..b",
      "a//b",
      "-x",
      "/x",
      "x/",
      "x.",
      "x.lock",
      "refs/heads/x",
      "a?b",
      "a/**",
      "**",
      "[ab]",
      "{a,b}",
      "a b",
      "x".repeat(256),
    ]) {
      const r = refusal(() => validateReleaseBranches(["next", bad]));
      expect(r?.code, bad).toBe("BAD_USER_INPUT");
      expect(r?.message, bad).toContain(`'${bad.trim()}'`);
    }
  });

  it("caps the list at 20 entries after dedupe", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `b${i}`);
    expect(validateReleaseBranches([...twenty, "b0"])).toHaveLength(20);
    expect(
      refusal(() => validateReleaseBranches([...twenty, "b20"]))?.code,
    ).toBe("BAD_USER_INPUT");
  });
});

describe("parseReleaseBranches", () => {
  it("reads the stored JSON list and tolerates missing or bad values", () => {
    expect(parseReleaseBranches('["next","*.x"]')).toStrictEqual([
      "next",
      "*.x",
    ]);
    expect(parseReleaseBranches("[]")).toStrictEqual([]);
    expect(parseReleaseBranches(null)).toStrictEqual([]);
    expect(parseReleaseBranches(undefined)).toStrictEqual([]);
    expect(parseReleaseBranches("not json")).toStrictEqual([]);
    expect(parseReleaseBranches('{"a":1}')).toStrictEqual([]);
    expect(parseReleaseBranches('["ok",3]')).toStrictEqual(["ok"]);
  });
});
