import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { BUNDLED_CONNECT_SCHEMA } from "./bundled-schema.js";
import type { RuntimeConfigIssue } from "./errors.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validate: ValidateFunction = ajv.compile(
  BUNDLED_CONNECT_SCHEMA as unknown as Record<string, unknown>,
);

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: RuntimeConfigIssue[] };

/**
 * Validate the `connect.*` subtree of powerhouse.config.json.
 *
 * Empty object `{}` passes — it means "clear all overrides, fall back to
 * bundled defaults". Anything else must conform to BUNDLED_CONNECT_SCHEMA.
 */
export function validateRuntimeConfig(json: unknown): ValidationResult {
  const passed = validate(json);
  if (passed) return { ok: true };
  const issues: RuntimeConfigIssue[] = (validate.errors ?? []).map(
    (e: ErrorObject) => ({
      path: e.instancePath || "/",
      message: `${e.message ?? "invalid"}${
        e.params ? ` (${JSON.stringify(e.params)})` : ""
      }`,
    }),
  );
  return { ok: false, issues };
}
