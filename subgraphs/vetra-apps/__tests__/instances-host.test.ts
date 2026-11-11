import { describe, expect, it } from "vitest";
import { appTag, instanceLabel, InstanceHostError } from "../instances/host.js";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

describe("instanceLabel", () => {
  it("joins slug and a clean name", () => {
    expect(instanceLabel("shop", "main")).toBe("shop-main");
    expect(instanceLabel("shop", "next")).toBe("shop-next");
    expect(instanceLabel("shop", "main", "-stg")).toBe("shop-main-stg");
  });

  it("sanitizes names and adds a hash of the original when it had to", () => {
    const a = instanceLabel("shop", "release/1.x");
    const b = instanceLabel("shop", "release-1-x");
    expect(a).toMatch(/^shop-release-1-x-[0-9a-f]{6}$/);
    expect(b).toBe("shop-release-1-x");
    expect(a).not.toBe(b);
    expect(instanceLabel("shop", "Feature")).toMatch(
      /^shop-feature-[0-9a-f]{6}$/,
    );
  });

  it("truncates long names to one DNS label, with a hash", () => {
    const long = "a".repeat(80);
    const label = instanceLabel("shop", long, "-stg");
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(LABEL);
    expect(label.endsWith("-stg")).toBe(true);
    expect(label).not.toBe(instanceLabel("shop", `${long}b`, "-stg"));
  });

  it("refuses when the slug leaves no room", () => {
    expect(() => instanceLabel("s".repeat(60), "main")).toThrow(
      InstanceHostError,
    );
  });

  it("is ambiguous across apps (the reconciler checks and falls back to appTag)", () => {
    expect(instanceLabel("a", "b-c")).toBe(instanceLabel("a-b", "c"));
    expect(appTag("app-1")).toMatch(/^[0-9a-f]{4}$/);
    expect(instanceLabel("a", "b-c", `-${appTag("app-1")}`)).not.toBe(
      instanceLabel("a-b", "c", `-${appTag("app-2")}`),
    );
  });

  it("always yields a valid DNS label for odd names", () => {
    for (const name of [
      "---",
      "/",
      "é",
      "-x-",
      "a..b",
      "x".repeat(200),
      "feat/" + "y-".repeat(40),
    ]) {
      for (const suffix of ["", "-stg"]) {
        const label = instanceLabel("shop", name, suffix);
        expect(label).toMatch(LABEL);
        expect(label.length).toBeLessThanOrEqual(63);
        expect(label.endsWith(suffix)).toBe(true);
      }
    }
  });
});
