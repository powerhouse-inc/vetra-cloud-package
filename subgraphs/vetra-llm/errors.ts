import { GraphQLError } from "graphql";
import { OpenRouterError } from "./openrouter.js";
import { redactSecrets } from "../../shared/redact.js";

export type LlmErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "SERVICE_NOT_CONFIGURED"
  | "UPSTREAM_ERROR"
  | "INTERNAL";

/** GraphQL error with the code in `extensions.code`. */
export function llmError(code: LlmErrorCode, message?: string): GraphQLError {
  return new GraphQLError(message ?? code, { extensions: { code } });
}

export function notConfigured(what: string): GraphQLError {
  return llmError("SERVICE_NOT_CONFIGURED", `${what} is not configured`);
}

export function isNotConfigured(err: unknown): boolean {
  return (
    err instanceof GraphQLError &&
    err.extensions.code === "SERVICE_NOT_CONFIGURED"
  );
}

/** Clean client errors; the detail goes to the log, redacted, never to the client. */
export function toLlmGraphQLError(
  err: unknown,
  logger: Pick<Console, "error"> = console,
): GraphQLError {
  if (err instanceof GraphQLError) return err;
  if (err instanceof OpenRouterError) {
    logger.error(`[vetra-llm] ${redactSecrets(err.message)}`);
    return llmError(
      "UPSTREAM_ERROR",
      `OpenRouter request failed (${err.status})`,
    );
  }
  const text =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  logger.error(`[vetra-llm] internal error: ${redactSecrets(text)}`);
  return llmError("INTERNAL", "Internal error");
}
