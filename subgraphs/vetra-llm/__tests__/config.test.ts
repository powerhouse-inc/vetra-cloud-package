import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO_MODEL, loadLlmConfig } from "../config.js";

describe("loadLlmConfig", () => {
  it("defaults: not configured, no workspace, Sonnet 4.6, the public API", () => {
    expect(loadLlmConfig({})).toStrictEqual({
      managementKey: null,
      workspaceId: null,
      defaultModel: "anthropic/claude-sonnet-4.6",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(DEFAULT_STUDIO_MODEL).toBe("anthropic/claude-sonnet-4.6");
  });

  it("reads the env, trimming, and treats blanks as unset", () => {
    expect(
      loadLlmConfig({
        OPENROUTER_MANAGEMENT_KEY: " mgmt ",
        OPENROUTER_WORKSPACE_ID: "ws-1",
        VETRA_LLM_DEFAULT_MODEL: "openai/gpt-5",
        OPENROUTER_BASE_URL: "http://fake",
      }),
    ).toStrictEqual({
      managementKey: "mgmt",
      workspaceId: "ws-1",
      defaultModel: "openai/gpt-5",
      baseUrl: "http://fake",
    });
    expect(
      loadLlmConfig({ OPENROUTER_MANAGEMENT_KEY: "  " }).managementKey,
    ).toBeNull();
  });
});
