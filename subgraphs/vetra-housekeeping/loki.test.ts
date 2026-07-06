import { describe, it, expect } from "vitest";
import { classifyActivity } from "./loki.js";

describe("classifyActivity", () => {
  it("ACTIVE when there is a proper (non-automation) request", () => {
    expect(classifyActivity(3, 10, true)).toBe("ACTIVE");
    expect(classifyActivity(1, 1, false)).toBe("ACTIVE");
  });

  it("IDLE when logs exist but all are automation (total>0, proper=0)", () => {
    expect(classifyActivity(0, 5, false)).toBe("IDLE");
    expect(classifyActivity(0, 5, true)).toBe("IDLE");
  });

  it("no logs + pipeline PROVEN healthy (canary had traffic) => IDLE (genuinely idle)", () => {
    // This is the fix: zero requests over the window, and we KNOW logs are
    // flowing (canary host had traffic), so it's real idleness, not a gap.
    expect(classifyActivity(0, 0, true)).toBe("IDLE");
  });

  it("no logs + pipeline NOT proven (canary silent/absent) => UNKNOWN (never slept)", () => {
    // Preserves the dev.140 guarantee: can't distinguish idle from a broken
    // pipeline, so fail safe.
    expect(classifyActivity(0, 0, false)).toBe("UNKNOWN");
  });
});
