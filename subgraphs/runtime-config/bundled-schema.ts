// Snapshot of `runtimeConfigSchema.properties.connect` from
// `@powerhousedao/builder-tools/connect-utils/runtime-config-schema.ts`
// (powerhouse monorepo, branch `feat/connect-config-json-2`). Bundled here
// so the subgraph does not pin a specific @powerhousedao/builder-tools
// release.
//
// Scope: this is JUST the `connect.*` subschema — what the subgraph stores
// and validates. The surrounding envelope (schemaVersion / packages /
// localPackage / packageRegistryUrl) is emitter-stamped by the build
// pipeline and is not editable from the UI, so we don't validate it here.
//
// Update when the upstream schema changes.

export const BUNDLED_CONNECT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://powerhouse.inc/schemas/powerhouse.config.connect.json",
  title: "Powerhouse Connect runtime configuration — connect subtree",
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
