// JSON-Schema validation for the Connect runtime config stored on
// `VetraCloudEnvironmentState.runtimeConfig`.
//
// This is the operator-editable subset of powerhouse.config.json — the same
// shape that `PH_CONNECT_CONFIG_JSON` carries and that the connect entrypoint
// deep-merges into /dist/powerhouse.config.json: the `connect.*` block plus the
// top-level `packageRegistryUrl`. The build-stamped fields (schemaVersion,
// packages, localPackage) are NOT operator-editable and are intentionally not
// part of this shape.
//
// Runs inside the SET_RUNTIME_CONFIG reducer (pure + synchronous — ajv
// compile/validate is sync and side-effect-free), so a malformed config is
// rejected before it can ever persist and reach the rendered values.yaml.
//
// CONNECT_SUBSCHEMA mirrors `runtimeConfigSchema.properties.connect` and the
// top-level `packageRegistryUrl` from
// `@powerhousedao/builder-tools/connect-utils/runtime-config-schema.ts`
// (powerhouse monorepo, branch `feat/connect-config-json-2`). Bundled here so
// the document model stays self-contained (it loads in both Switchboard and the
// browser). Keep in sync with that upstream schema when it changes.

import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";

const CONNECT_SUBSCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    branding: {
      type: "object",
      additionalProperties: false,
      properties: {
        appName: { type: "string" },
        homeBackground: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                avif: { type: "string" },
                png: { type: "string" },
              },
            },
          ],
        },
      },
    },
    app: {
      type: "object",
      additionalProperties: false,
      properties: {
        logLevel: {
          type: "string",
          enum: ["debug", "info", "warn", "error"],
          default: "info",
        },
        basePath: { type: "string", default: "/" },
      },
    },
    packages: {
      type: "object",
      additionalProperties: false,
      properties: {
        externalEnabled: { type: "boolean", default: true },
      },
    },
    drives: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowAddDrive: { type: "boolean", default: true },
        defaultDrives: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["url"],
            properties: {
              url: { type: "string" },
              name: { type: ["string", "null"] },
              icon: { type: ["string", "null"] },
            },
          },
        },
        preserveStrategy: {
          type: "string",
          enum: ["preserve-all", "preserve-by-url-and-detach"],
        },
        sections: {
          type: "object",
          additionalProperties: false,
          properties: {
            remote: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean", default: true },
                allowAdd: { type: "boolean", default: true },
                allowDelete: { type: "boolean", default: true },
              },
            },
            local: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean", default: true },
                allowAdd: { type: "boolean", default: true },
                allowDelete: { type: "boolean", default: true },
              },
            },
          },
        },
      },
    },
    renown: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", default: "https://www.renown.id" },
        networkId: { type: "string", default: "eip155" },
        chainId: { type: "number", default: 1 },
      },
    },
    sentry: {
      type: "object",
      additionalProperties: false,
      properties: {
        dsn: { type: ["string", "null"], default: null },
        env: { type: "string", default: "dev" },
        tracing: { type: "boolean", default: false },
      },
    },
  },
} as const;

// The operator-editable powerhouse.config.json partial: the connect.* block +
// the top-level packageRegistryUrl (+ optional $schema). All optional, so a
// partial override validates. Unknown top-level keys are rejected so a typo
// can't silently end up in PH_CONNECT_CONFIG_JSON.
export const BUNDLED_RUNTIME_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://powerhouse.inc/schemas/powerhouse.config.editable.json",
  title: "Powerhouse Connect runtime configuration — operator-editable subset",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    packageRegistryUrl: { type: "string" },
    connect: CONNECT_SUBSCHEMA,
  },
} as const;

export type RuntimeConfigIssue = { path: string; message: string };

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: RuntimeConfigIssue[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const validate: ValidateFunction = ajv.compile(
  BUNDLED_RUNTIME_CONFIG_SCHEMA as unknown as Record<string, unknown>,
);

/**
 * Validate the operator-editable runtime-config partial (connect.* +
 * packageRegistryUrl). An empty object `{}` passes (it means "clear all
 * overrides, fall back to bundled defaults"); anything else must conform.
 */
export function validateRuntimeConfig(json: unknown): ValidationResult {
  if (validate(json)) return { ok: true };
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
