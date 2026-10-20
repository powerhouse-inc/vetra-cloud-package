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
  /**
   * VETRA_LLM_FALLBACK_MODELS, written to every Studio as VETRA_MODEL_FALLBACKS
   * (joined with ",") alongside VETRA_MODEL. The agent's contract: blank → its
   * default fallback chain; `none` → no fallbacks; otherwise the list. So:
   * [] when unset (written blank), ["none"] passed through verbatim, else at
   * most MAX_FALLBACK_MODELS models, the default model dropped.
   */
  fallbackModels: string[];
  /** OPENROUTER_BASE_URL: tests and local fakes only. */
  baseUrl: string;
}

/** The agent tries at most this many fallback models. */
export const MAX_FALLBACK_MODELS = 3;
/** VETRA_MODEL_FALLBACKS value that turns the agent's fallbacks off. */
export const NO_FALLBACKS = "none";

/**
 * VETRA_LLM_FALLBACK_MODELS → the list written to Studios: blank → [] (the
 * agent's default chain), `none` → ["none"], else the list without the
 * primary model and capped at MAX_FALLBACK_MODELS (a warn when trimmed).
 */
export function parseFallbackModels(
  raw: string | undefined,
  defaultModel: string,
  logger: Pick<Console, "warn"> = console,
): string[] {
  const value = raw?.trim() ?? "";
  if (value === "") return [];
  if (value.toLowerCase() === NO_FALLBACKS) return [NO_FALLBACKS];
  const listed = value
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const models = [...new Set(listed)].filter((m) => m !== defaultModel);
  const kept = models.slice(0, MAX_FALLBACK_MODELS);
  if (kept.length !== listed.length) {
    logger.warn(
      `[vetra-llm] VETRA_LLM_FALLBACK_MODELS trimmed to ${kept.join(",") || "(none listed: the agent's default chain)"} (the default model is dropped, at most ${MAX_FALLBACK_MODELS})`,
    );
  }
  return kept;
}

export function loadLlmConfig(
  env: Record<string, string | undefined>,
  logger: Pick<Console, "warn"> = console,
): LlmConfig {
  const s = (k: string) => env[k]?.trim() || null;
  const defaultModel = s("VETRA_LLM_DEFAULT_MODEL") ?? DEFAULT_STUDIO_MODEL;
  return {
    managementKey: s("OPENROUTER_MANAGEMENT_KEY"),
    workspaceId: s("OPENROUTER_WORKSPACE_ID"),
    defaultModel,
    fallbackModels: parseFallbackModels(
      env.VETRA_LLM_FALLBACK_MODELS,
      defaultModel,
      logger,
    ),
    baseUrl: s("OPENROUTER_BASE_URL") ?? OPENROUTER_BASE_URL,
  };
}
