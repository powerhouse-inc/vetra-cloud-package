import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { BUNDLED_RUNTIME_CONFIG_SCHEMA } from "./bundled-schema.js";
import type { RuntimeConfigIssue } from "./errors.js";

// Build a schema that accepts partial input. The published schema requires
// `schemaVersion`, `packages`, `localPackage` (emitter-stamped fields the
// operator never sets), so we strip top-level `required` for subgraph
// validation. Per-property shapes and enums are preserved.
function relaxRequired(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown> &
    { required?: string[] };
  delete cloned.required;
  return cloned;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate: ValidateFunction = ajv.compile(
  relaxRequired(BUNDLED_RUNTIME_CONFIG_SCHEMA as unknown as Record<string, unknown>),
);

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: RuntimeConfigIssue[] };

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
