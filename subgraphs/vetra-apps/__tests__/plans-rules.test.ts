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
    expect(parseSize("vetra_agent_m")).toBe("VETRA_AGENT_M");
    expect(parseSize(" Vetra_Agent_XL ")).toBe("VETRA_AGENT_XL");
    bad(() => parseSize("HUGE"));
  });
  it("derives a slug from a kind", () => {
    expect(slugFromKind("Pro Plan 2026")).toBe("pro-plan-2026");
    expect(slugFromKind("x".repeat(40))).toHaveLength(31);
    expect(slugFromKind("!!!")).toBe("");
  });
  it("takes slugs of up to 31 characters", () => {
    expect(() => checkPlanSlug("a".repeat(31), app)).not.toThrow();
    bad(() => checkPlanSlug("a".repeat(32), app));
  });
  it("refuses what a release branch pattern matches, not its bare prefix", () => {
    const rel = {
      production_branch: "main",
      release_branches: '["release-*"]',
    };
    bad(() => checkPlanSlug("release-1", rel));
    expect(() => checkPlanSlug("release", rel)).not.toThrow();
  });
  it("refuses the production branch, whatever it is called", () => {
    const dev = { production_branch: "develop", release_branches: "[]" };
    bad(() => checkPlanSlug("develop", dev));
    bad(() => checkPlanSlug("main", dev));
  });
  it("tells to pass a slug when the one derived from the kind is refused", () => {
    expect(() => checkPlanSlug("", app, { derivedFrom: "!!!" })).toThrow(
      /kind "!!!".*pass a slug/,
    );
    expect(() => checkPlanSlug("main", app, { derivedFrom: "Main" })).toThrow(
      /pass a slug/,
    );
    expect(() => checkPlanSlug("main", app)).not.toThrow(/pass a slug/);
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
    "!!!",
  ])("refuses %j", (slug) => bad(() => checkPlanSlug(slug, app)));
});
