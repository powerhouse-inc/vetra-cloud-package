import { describe, expect, it } from "vitest";
import { loadAppsConfig } from "../config.js";

describe("managed GitHub org", () => {
  it("is set only when both org and installation are given", () => {
    expect(loadAppsConfig({}).managedGithub).toBeNull();
    expect(
      loadAppsConfig({ VETRA_APPS_MANAGED_GITHUB_ORG: "vetra-apps" })
        .managedGithub,
    ).toBeNull();
    expect(
      loadAppsConfig({
        VETRA_APPS_MANAGED_GITHUB_ORG: " vetra-apps ",
        VETRA_APPS_MANAGED_INSTALLATION_ID: "123",
      }).managedGithub,
    ).toStrictEqual({ org: "vetra-apps", installationId: "123" });
  });
});
