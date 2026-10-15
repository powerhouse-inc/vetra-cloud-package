import { describe, expect, it } from "vitest";
import { isStudioState } from "./studio-package.js";

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
