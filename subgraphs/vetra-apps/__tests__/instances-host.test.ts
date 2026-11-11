import { describe, expect, it } from "vitest";
import {
  instanceHash,
  instanceLabel,
  InstanceHostError,
} from "../instances/host.js";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const OLD_PATH = /-(connect|switchboard)(-stg)?$/;

describe("instanceLabel", () => {
  it("is slug-branch-hash, then the staging suffix", () => {
    const h = instanceHash("app-1", "main");
    expect(h).toMatch(/^[0-9a-f]{6}$/);
    expect(instanceLabel("app-1", "shop", "main")).toBe(`shop-main-${h}`);
    expect(instanceLabel("app-1", "shop", "main", "-stg")).toBe(
      `shop-main-${h}-stg`,
    );
  });

  it("is deterministic and depends on app and branch", () => {
    expect(instanceLabel("app-1", "shop", "main")).toBe(
      instanceLabel("app-1", "shop", "main"),
    );
    expect(instanceLabel("app-1", "shop", "main")).not.toBe(
      instanceLabel("app-2", "shop", "main"),
    );
    expect(instanceLabel("app-1", "shop", "release/1.x")).not.toBe(
      instanceLabel("app-1", "shop", "release-1-x"),
    );
    expect(instanceLabel("app-1", "shop", "Feature")).toMatch(
      /^shop-feature-[0-9a-f]{6}$/,
    );
  });

  it("never collides with old-path hosts", () => {
    for (const branch of ["connect", "switchboard"]) {
      for (const suffix of ["", "-stg"]) {
        const label = instanceLabel("app-1", "shop", branch, suffix);
        expect(label).not.toBe(`shop-${branch}${suffix}`);
        expect(label).not.toMatch(OLD_PATH);
      }
    }
  });

  it("keeps a branch named like another's staging form apart", () => {
    const stagingOfMain = instanceLabel("app-1", "shop", "main", "-stg");
    expect(instanceLabel("app-1", "shop", "main-stg")).not.toBe(stagingOfMain);
    expect(instanceLabel("app-1", "shop", "main-stg", "-stg")).not.toBe(
      stagingOfMain,
    );
  });

  it("keeps a + b-c and a-b + c apart across apps", () => {
    expect(instanceLabel("app-1", "a", "b-c")).not.toBe(
      instanceLabel("app-2", "a-b", "c"),
    );
  });

  it("truncates only slug and branch parts, to exactly 63 at the boundary", () => {
    const h = instanceHash("app-1", "b".repeat(40));
    const label = instanceLabel("app-1", "s".repeat(40), "b".repeat(40));
    expect(label).toHaveLength(63);
    expect(label.endsWith(`-${h}`)).toBe(true);
    const stg = instanceLabel("app-1", "s".repeat(40), "b".repeat(40), "-stg");
    expect(stg).toHaveLength(63);
    expect(stg.endsWith(`-${h}-stg`)).toBe(true);
    // Fits without truncation at exactly 63: 30 + 1 + 25 + 7.
    const exact = instanceLabel("app-1", "s".repeat(30), "b".repeat(25));
    expect(exact).toHaveLength(63);
    expect(exact.startsWith(`${"s".repeat(30)}-${"b".repeat(25)}-`)).toBe(true);
    // One more character is truncated, not rejected.
    expect(instanceLabel("app-1", "s".repeat(30), "b".repeat(26))).toHaveLength(
      63,
    );
  });

  it("gives long branches distinct labels", () => {
    const long = "a".repeat(80);
    expect(instanceLabel("app-1", "shop", long, "-stg")).not.toBe(
      instanceLabel("app-1", "shop", `${long}b`, "-stg"),
    );
  });

  it("always yields a valid DNS label for odd input", () => {
    const names = [
      "---",
      "/",
      "é",
      "-x-",
      "a..b",
      "x".repeat(200),
      "feat/" + "y-".repeat(40),
    ];
    for (const slug of ["shop", "s".repeat(60), "---"]) {
      for (const name of names) {
        for (const suffix of ["", "-stg"]) {
          const label = instanceLabel("app-1", slug, name, suffix);
          expect(label).toMatch(LABEL);
          expect(label.length).toBeLessThanOrEqual(63);
          expect(label.endsWith(suffix)).toBe(true);
        }
      }
    }
  });

  it("refuses an absurd suffix", () => {
    expect(() =>
      instanceLabel("app-1", "shop", "main", "-".padEnd(60, "x")),
    ).toThrow(InstanceHostError);
  });
});
