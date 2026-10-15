import { describe, expect, it } from "vitest";
import { isStudioPackagesJson, isStudioState } from "./studio-package.js";

describe("isStudioState", () => {
  it("is true when a package is the studio agent (either name)", () => {
    expect(isStudioState({ packages: [{ name: "vetra" }] })).toBe(true);
    expect(
      isStudioState({ packages: [{ name: "x" }, { name: "vetra-cli" }] }),
    ).toBe(true);
  });
  it("is false otherwise", () => {
    expect(
      isStudioState({ packages: [{ name: "@powerhousedao/vetra" }] }),
    ).toBe(false);
    expect(isStudioState({ packages: [] })).toBe(false);
    expect(isStudioState(null)).toBe(false);
  });
});

describe("isStudioPackagesJson", () => {
  it("reads the projection's packages column", () => {
    expect(
      isStudioPackagesJson(
        JSON.stringify([{ name: "vetra-cli", version: "1" }]),
      ),
    ).toBe(true);
    expect(isStudioPackagesJson(JSON.stringify([{ name: "x" }]))).toBe(false);
    expect(isStudioPackagesJson("not json")).toBe(false);
    expect(isStudioPackagesJson(null)).toBe(false);
  });
});
