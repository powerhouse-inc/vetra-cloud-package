import { describe, expect, it } from "vitest";
import { validateRuntimeConfig } from "../validation.js";

describe("validateRuntimeConfig", () => {
  it("accepts an empty override", () => {
    expect(validateRuntimeConfig({}).ok).toBe(true);
  });

  it("accepts a partial connect.* override matching the schema", () => {
    expect(
      validateRuntimeConfig({
        connect: { branding: { appName: "Acme" } },
      }).ok,
    ).toBe(true);
  });

  it("accepts a fully-populated connect.* override", () => {
    expect(
      validateRuntimeConfig({
        connect: {
          branding: { appName: "Acme", homeBackground: null },
          app: { logLevel: "warn", basePath: "/" },
          packages: { externalEnabled: false },
          drives: {
            allowAddDrive: false,
            defaultDrives: [{ url: "https://a.example", name: null, icon: null }],
            sections: {
              remote: { enabled: true, allowAdd: false, allowDelete: false },
              local: { enabled: true, allowAdd: true, allowDelete: true },
            },
          },
          renown: {
            url: "https://renown.example",
            networkId: "eip155",
            chainId: 137,
          },
          sentry: { dsn: null, env: "prod", tracing: true },
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown top-level properties with structured issues", () => {
    const result = validateRuntimeConfig({ notAConfig: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(
        result.issues.some((i) =>
          /additional/i.test(i.message) || /notAConfig/.test(JSON.stringify(i)),
        ),
      ).toBe(true);
    }
  });

  it("rejects wrong-type fields with a path pointing at them", () => {
    const result = validateRuntimeConfig({
      connect: { app: { logLevel: 123 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.includes("logLevel"))).toBe(true);
    }
  });

  it("rejects a logLevel outside the enum", () => {
    const result = validateRuntimeConfig({
      connect: { app: { logLevel: "verbose" } },
    });
    expect(result.ok).toBe(false);
  });
});
