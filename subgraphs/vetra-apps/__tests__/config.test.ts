import { describe, expect, it } from "vitest";
import { loadAppsConfig } from "../config.js";

describe("Studio Apps config", () => {
  it("reads no Vetra-managed GitHub org: Studio App repos live in the user's own GitHub", () => {
    const cfg = loadAppsConfig({
      VETRA_APPS_MANAGED_GITHUB_ORG: "vetra-apps",
      VETRA_APPS_MANAGED_INSTALLATION_ID: "123",
    });
    expect("managedGithub" in cfg).toBe(false);
  });
});

describe("instances config", () => {
  it("is on with no suffix by default", () => {
    expect(loadAppsConfig({}).instances).toEqual({
      enabled: true,
      labelSuffix: "",
    });
  });
  it("turns off with VETRA_APPS_INSTANCES=off", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCES: "off" }).instances.enabled,
    ).toBe(false);
  });
  it("takes a label suffix such as -stg", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg" }).instances,
    ).toEqual({
      enabled: true,
      labelSuffix: "-stg",
    });
  });
  it("accepts dashes inside the suffix but not at its end", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-s-1" }).instances
        .labelSuffix,
    ).toBe("-s-1");
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-stg-" }).instances
        .enabled,
    ).toBe(false);
  });
  it("accepts at most 8 characters including the dash", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-abcdefg" }).instances
        .labelSuffix,
    ).toBe("-abcdefg");
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: "-abcdefgh" })
        .instances.enabled,
    ).toBe(false);
  });
  it("refuses a bare dash, uppercase, and a missing dash", () => {
    for (const bad of ["-", "-STG", "stg", "--"]) {
      expect(
        loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: bad }).instances
          .enabled,
      ).toBe(false);
    }
  });
  it("turns instances off on an invalid suffix rather than risk a production host", () => {
    expect(
      loadAppsConfig({ VETRA_APPS_INSTANCE_LABEL_SUFFIX: ".staging" }).instances
        .enabled,
    ).toBe(false);
  });
});
