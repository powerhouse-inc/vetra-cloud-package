import { describe, expect, it } from "vitest";
import { BUNDLED_DEFAULT_CONNECT_CONFIG } from "../bundled-defaults.js";
import { mergeWithDefaults } from "../defaults.js";

describe("mergeWithDefaults", () => {
  it("returns a populated effective config when overrides are empty", () => {
    const effective = mergeWithDefaults({});
    expect(effective.connect).toEqual(BUNDLED_DEFAULT_CONNECT_CONFIG);
  });

  it("replaces only touched keys, leaving siblings as defaults", () => {
    const effective = mergeWithDefaults({
      connect: { branding: { appName: "Acme Connect" } },
    });
    expect(effective.connect.branding?.appName).toBe("Acme Connect");
    // sibling default preserved
    expect(effective.connect.app?.logLevel).toBe(
      BUNDLED_DEFAULT_CONNECT_CONFIG.app?.logLevel,
    );
  });

  it("nested merge: deep override only the explicit leaves", () => {
    const effective = mergeWithDefaults({
      connect: {
        drives: {
          sections: { remote: { allowAdd: false } },
        },
      },
    });
    expect(effective.connect.drives?.sections?.remote?.allowAdd).toBe(false);
    expect(effective.connect.drives?.sections?.remote?.enabled).toBe(true);
    expect(effective.connect.drives?.sections?.remote?.allowDelete).toBe(true);
    expect(effective.connect.drives?.sections?.local).toEqual(
      BUNDLED_DEFAULT_CONNECT_CONFIG.drives?.sections?.local,
    );
  });

  it("array overrides replace wholesale (no element merge)", () => {
    const drives = [
      { url: "https://a.example", name: null, icon: null },
      { url: "https://b.example", name: null, icon: null },
    ];
    const effective = mergeWithDefaults({
      connect: { drives: { defaultDrives: drives } },
    });
    expect(effective.connect.drives?.defaultDrives).toEqual(drives);
  });

  it("null override replaces a non-null default (sentry.dsn off-switch)", () => {
    const effective = mergeWithDefaults({ connect: { sentry: { dsn: null } } });
    expect(effective.connect.sentry?.dsn).toBeNull();
  });

  it("honors a caller-supplied default object", () => {
    const altDefault = {
      branding: { appName: "Custom App", homeBackground: null },
      app: { logLevel: "warn" as const, basePath: "/" },
    };
    const effective = mergeWithDefaults(
      { connect: { branding: { appName: "Override" } } },
      altDefault,
    );
    expect(effective.connect.branding?.appName).toBe("Override");
    expect(effective.connect.app?.logLevel).toBe("warn");
  });
});
