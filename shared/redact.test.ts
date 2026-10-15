import { describe, expect, it } from "vitest";
import { redactSecrets, SECRET_PATTERNS } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts OpenRouter, Claude and OpenBao values and credentials", () => {
    const out = redactSecrets(
      "a sk-or-v1-abc123 b sk-ant-api03-x c vault:v1:Zm9v+/= d Bearer tok.en",
    );
    expect(out).toBe("a [redacted] b [redacted] c [redacted] d [redacted]");
  });

  it("caps the length", () => {
    expect(redactSecrets("x".repeat(2000))).toHaveLength(1000);
  });

  it("exports the base patterns", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });
});
