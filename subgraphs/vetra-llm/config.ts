import { OPENROUTER_BASE_URL } from "./openrouter.js";

/** Verified against GET https://openrouter.ai/api/v1/models on 2026-10-15. */
export const DEFAULT_STUDIO_MODEL = "anthropic/claude-sonnet-4.6";

/**
 * vetra-llm configuration, read once at setup. Without a management key the
 * broker refuses with SERVICE_NOT_CONFIGURED; nothing else breaks.
 */
export interface LlmConfig {
  /** OPENROUTER_MANAGEMENT_KEY (OpenBao via ExternalSecret). */
  managementKey: string | null;
  /**
   * OPENROUTER_WORKSPACE_ID: the workspace this deployment's keys live in.
   * Required for the orphan sweep (staging and prod share one organisation).
   */
  workspaceId: string | null;
  /** VETRA_LLM_DEFAULT_MODEL: the model a new Studio key starts with. */
  defaultModel: string;
  /** OPENROUTER_BASE_URL: tests and local fakes only. */
  baseUrl: string;
}

export function loadLlmConfig(
  env: Record<string, string | undefined>,
): LlmConfig {
  const s = (k: string) => env[k]?.trim() || null;
  return {
    managementKey: s("OPENROUTER_MANAGEMENT_KEY"),
    workspaceId: s("OPENROUTER_WORKSPACE_ID"),
    defaultModel: s("VETRA_LLM_DEFAULT_MODEL") ?? DEFAULT_STUDIO_MODEL,
    baseUrl: s("OPENROUTER_BASE_URL") ?? OPENROUTER_BASE_URL,
  };
}
