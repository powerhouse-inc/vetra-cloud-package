import { describe, expect, it } from "vitest";
import { InvalidRuntimeConfigError } from "../errors.js";

describe("InvalidRuntimeConfigError", () => {
  it("exposes issues via GraphQL extensions and stringifies them in the message", () => {
    const err = new InvalidRuntimeConfigError([
      { path: "/connect/app/logLevel", message: "must be string" },
      {
        path: "/connect/branding",
        message: "must NOT have additional property 'foo'",
      },
    ]);
    expect(err.extensions).toMatchObject({ code: "INVALID_RUNTIME_CONFIG" });
    expect((err.extensions as { issues: unknown[] }).issues).toHaveLength(2);
    expect(err.message).toContain("/connect/app/logLevel");
    expect(err.message).toContain("must NOT have additional property");
  });
});
