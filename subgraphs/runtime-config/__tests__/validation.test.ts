import { describe, expect, it } from "vitest";
import { validateRuntimeConfig } from "../validation.js";

describe("validateRuntimeConfig", () => {
  it("accepts empty object (clears all overrides)", () => {
    expect(validateRuntimeConfig({})).toEqual({ ok: true });
  });

  it("accepts a partial override", () => {
    expect(
      validateRuntimeConfig({
        branding: { appName: "Acme" },
      }),
    ).toEqual({ ok: true });
  });

  it("accepts a full connect-shape override", () => {
    expect(
      validateRuntimeConfig({
        branding: { appName: "Acme", homeBackground: null },
        app: { logLevel: "debug", basePath: "/app" },
        packages: { externalEnabled: false },
        drives: {
          allowAddDrive: false,
          defaultDrives: [{ url: "https://a" }],
          preserveStrategy: "preserve-all",
          sections: {
            remote: { enabled: false, allowAdd: false, allowDelete: false },
            local: { enabled: true, allowAdd: true, allowDelete: true },
          },
        },
        renown: { url: "https://r", networkId: "eip155", chainId: 1 },
        sentry: { dsn: null, env: "dev", tracing: false },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects unknown top-level key (additionalProperties: false)", () => {
    const result = validateRuntimeConfig({ unknownThing: "foo" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].message).toMatch(/additional properties|unknownThing/i);
    }
  });

  it("rejects unknown nested key", () => {
    const result = validateRuntimeConfig({
      branding: { unknownInner: "foo" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects type mismatch", () => {
    const result = validateRuntimeConfig({
      app: { logLevel: 123 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].path).toContain("logLevel");
    }
  });

  it("rejects enum mismatch", () => {
    const result = validateRuntimeConfig({
      app: { logLevel: "VERBOSE" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects defaultDrives item missing required url", () => {
    const result = validateRuntimeConfig({
      drives: { defaultDrives: [{ name: "Anonymous" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts homeBackground = null (oneOf null branch)", () => {
    expect(
      validateRuntimeConfig({ branding: { homeBackground: null } }),
    ).toEqual({ ok: true });
  });

  it("accepts homeBackground object", () => {
    expect(
      validateRuntimeConfig({
        branding: { homeBackground: { avif: "a.avif", png: "a.png" } },
      }),
    ).toEqual({ ok: true });
  });
});
