import { describe, expect, it } from "vitest";
import { loadLicensingConfig } from "../config.js";

describe("loadLicensingConfig", () => {
  it("is safe by default", () => {
    expect(loadLicensingConfig({})).toMatchObject({
      enabled: false, dryRun: true, destroyEnabled: false, migration: "dry-run",
      deleteLicenseTypes: false, studioAppSlug: "vetra-studio", studioPublisher: null,
      renownStatsUrl: null, licensingPublicUrl: null,
    });
  });
  it("reads every switch", () => {
    expect(loadLicensingConfig({
      LICENSING_DESTROY_ENABLED: "true", LICENSING_MIGRATION: "apply",
      LICENSING_MIGRATION_DELETE_LICENSE_TYPES: "true", VETRA_STUDIO_APP_SLUG: "studio",
      ADMINS: " 0xAA , 0xbb", RENOWN_STATS_URL: "https://r/graphql/renown-stats",
      VETRA_LICENSING_URL: "https://switchboard.vetra.io/graphql/vetra-licensing",
    })).toMatchObject({
      destroyEnabled: true, migration: "apply", deleteLicenseTypes: true, studioAppSlug: "studio",
      studioPublisher: "0xaa", renownStatsUrl: "https://r/graphql/renown-stats",
      licensingPublicUrl: "https://switchboard.vetra.io/graphql/vetra-licensing",
    });
  });
  it("prefers the explicit studio publisher and falls back to dry-run on an unknown mode", () => {
    expect(loadLicensingConfig({ ADMINS: "0xaa", VETRA_STUDIO_PUBLISHER_ADDRESS: "0xCC", LICENSING_MIGRATION: "yes" }))
      .toMatchObject({ studioPublisher: "0xcc", migration: "dry-run" });
  });
  it("accepts the migration modes case-insensitively and off explicitly", () => {
    expect(loadLicensingConfig({ LICENSING_MIGRATION: "OFF" }).migration).toBe("off");
    expect(loadLicensingConfig({ LICENSING_MIGRATION: " Apply " }).migration).toBe("apply");
  });
});
