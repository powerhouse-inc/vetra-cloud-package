import { describe, expect, it } from "vitest";
import {
  checkPlanSlug,
  parseAccess,
  parseSize,
  slugFromKind,
} from "../plans/rules.js";

const app = { production_branch: "main", release_branches: '["next","*.x"]' };
const bad = (f: () => unknown) =>
  expect(f).toThrow(
    expect.objectContaining({
      extensions: expect.objectContaining({ code: "BAD_USER_INPUT" }),
    }),
  );

describe("plan rules", () => {
  it("parses access and size", () => {
    expect(parseAccess("SHARED")).toBe("shared");
    expect(parseAccess("own")).toBe("own");
    bad(() => parseAccess("team"));
    expect(parseSize(undefined)).toBe("VETRA_AGENT_S");
    expect(parseSize("VETRA_AGENT_M")).toBe("VETRA_AGENT_M");
    bad(() => parseSize("HUGE"));
  });
  it("derives a slug from a kind", () => {
    expect(slugFromKind("Pro Plan 2026")).toBe("pro-plan-2026");
    expect(slugFromKind("x".repeat(40))).toHaveLength(31);
  });
  it("accepts a plain slug", () => {
    expect(() => checkPlanSlug("starter", app)).not.toThrow();
  });
  it.each([
    "main",
    "team",
    "own",
    "own-1",
    "pr-12",
    "next",
    "1.x",
    "-a",
    "a-",
    "A",
    "",
  ])("refuses %j", (slug) => bad(() => checkPlanSlug(slug, app)));
});
