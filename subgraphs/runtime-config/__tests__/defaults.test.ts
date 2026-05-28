import { BUNDLED_DEFAULT_CONNECT_CONFIG } from "../bundled-defaults.js";
import { mergeWithDefaults } from "../defaults.js";

describe("mergeWithDefaults", () => {
  it("returns a clone of defaults when overrides are empty", () => {
    const result = mergeWithDefaults({});
    expect(result).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
  });

  it("primitive override replaces default", () => {
    const result = mergeWithDefaults({
      branding: { appName: "Custom" },
    });
    expect(result.branding?.appName).toBe("Custom");
    // Other branding fields fall back to defaults.
    expect(result.branding?.homeBackground).toBeNull();
  });

  it("nested object merges per-key", () => {
    const result = mergeWithDefaults({
      drives: {
        sections: {
          local: { enabled: false },
        },
      },
    });
    // Override field is replaced
    expect(result.drives?.sections?.local?.enabled).toBe(false);
    // Sibling fields under the same parent stay as defaults
    expect(result.drives?.sections?.local?.allowAdd).toBe(true);
    expect(result.drives?.sections?.remote?.enabled).toBe(true);
    // Sibling fields at higher levels stay as defaults
    expect(result.drives?.allowAddDrive).toBe(true);
  });

  it("array overrides replace wholesale (no element merge)", () => {
    const result = mergeWithDefaults({
      drives: {
        defaultDrives: [{ url: "https://drive-a" }],
      },
    });
    expect(result.drives?.defaultDrives).toEqual([
      { url: "https://drive-a" },
    ]);
  });

  it("null replaces non-null", () => {
    const result = mergeWithDefaults({
      sentry: { dsn: null, env: "prod", tracing: true },
    });
    expect(result.sentry?.dsn).toBeNull();
    expect(result.sentry?.env).toBe("prod");
    expect(result.sentry?.tracing).toBe(true);
  });

  it("undefined is no-opinion (leaves default in place)", () => {
    const result = mergeWithDefaults({
      app: { logLevel: undefined },
    });
    expect(result.app?.logLevel).toBe("info");
  });

  it("custom defaults param is honoured", () => {
    const customDefaults = {
      ...BUNDLED_DEFAULT_CONNECT_CONFIG,
      branding: { appName: "Custom Default", homeBackground: null },
    };
    const result = mergeWithDefaults({}, customDefaults);
    expect(result.branding?.appName).toBe("Custom Default");
  });

  it("does not mutate inputs", () => {
    const overrides = { branding: { appName: "X" } };
    const beforeDefaults = JSON.stringify(BUNDLED_DEFAULT_CONNECT_CONFIG);
    const beforeOverrides = JSON.stringify(overrides);
    mergeWithDefaults(overrides);
    expect(JSON.stringify(BUNDLED_DEFAULT_CONNECT_CONFIG)).toBe(beforeDefaults);
    expect(JSON.stringify(overrides)).toBe(beforeOverrides);
  });
});
