import { describe, expect, it, vi } from "vitest";

// ajv always fills `message` and sets `errors` on failure; those fallbacks are
// only reachable by standing in for the validator.
const mocked = vi.hoisted(() => ({
  errors: null as unknown,
}));

vi.mock("ajv", () => {
  const validate = () => false;
  Object.defineProperty(validate, "errors", {
    get: () => mocked.errors,
  });
  return {
    Ajv: class {
      compile() {
        return validate;
      }
    },
  };
});

describe("validateRuntimeConfig issue formatting", () => {
  it("falls back to the root path and a generic message", async () => {
    mocked.errors = [{ instancePath: "", params: {} }];
    const { validateRuntimeConfig } = await import(
      "../src/reducers/runtime-config-validation.js"
    );
    expect(validateRuntimeConfig({})).toStrictEqual({
      ok: false,
      issues: [{ path: "/", message: "invalid ({})" }],
    });
  });

  it("reports no issues when the validator leaves errors unset", async () => {
    mocked.errors = null;
    const { validateRuntimeConfig } = await import(
      "../src/reducers/runtime-config-validation.js"
    );
    expect(validateRuntimeConfig({})).toStrictEqual({ ok: false, issues: [] });
  });
});
