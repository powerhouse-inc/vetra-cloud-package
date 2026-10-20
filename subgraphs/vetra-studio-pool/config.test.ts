import { describe, it, expect } from "vitest";
import { loadPoolConfig } from "./config.js";

describe("loadPoolConfig", () => {
  it("applies defaults and stays disabled when STUDIO_POOL_SIZE unset", () => {
    expect(loadPoolConfig({})).toEqual({
      size: 5,
      version: "0.0.1-dev.19",
      sizeName: "VETRA_AGENT_XXL",
      registry: "https://registry.vetra.io",
      switchboardUrl: "https://switchboard.staging.vetra.io",
      renownUrl: "",
      enabled: false,
      legacyAnthropicKey: true,
    });
  });

  it("enables with a positive explicit size and reads overrides", () => {
    expect(
      loadPoolConfig({
        STUDIO_POOL_SIZE: "3",
        STUDIO_POOL_VERSION: "0.0.1-dev.20",
        STUDIO_POOL_SIZE_NAME: "VETRA_AGENT_XL",
        STUDIO_POOL_REGISTRY: "https://r",
        STUDIO_POOL_SWITCHBOARD_URL: "https://sb",
        STUDIO_POOL_RENOWN_URL: " https://renown-staging.vetra.io ",
      }),
    ).toEqual({
      size: 3,
      version: "0.0.1-dev.20",
      sizeName: "VETRA_AGENT_XL",
      registry: "https://r",
      switchboardUrl: "https://sb",
      renownUrl: "https://renown-staging.vetra.io",
      enabled: true,
      legacyAnthropicKey: true,
    });
  });

  it("size 0 is valid but disabled", () => {
    expect(loadPoolConfig({ STUDIO_POOL_SIZE: "0" }).enabled).toBe(false);
  });

  it("ignores a non-numeric size (default, disabled)", () => {
    const c = loadPoolConfig({ STUDIO_POOL_SIZE: "abc" });
    expect(c.size).toBe(5);
    expect(c.enabled).toBe(false);
  });

  it("turns the legacy Anthropic write off after cut-over", () => {
    expect(loadPoolConfig({ STUDIO_POOL_LEGACY_ANTHROPIC_KEY: "false" }).legacyAnthropicKey).toBe(false);
    expect(loadPoolConfig({ STUDIO_POOL_LEGACY_ANTHROPIC_KEY: "true" }).legacyAnthropicKey).toBe(true);
  });
});
