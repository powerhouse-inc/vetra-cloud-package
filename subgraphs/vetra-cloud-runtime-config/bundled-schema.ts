// Snapshot of `runtimeConfigSchema` from
// `@powerhousedao/builder-tools/connect-utils/runtime-config-schema.ts`
// (powerhouse monorepo, branch `feat/connect-config-json-2`). Bundled here
// so the subgraph does not pin a specific @powerhousedao/builder-tools
// release.
//
// Update when the upstream schema changes. Deployments that want to enforce
// the live schema can pass `schema` to the subgraph constructor.
//
// Schema scope: this is the FULL RuntimePowerhouseConfig schema, including
// top-level `schemaVersion`, `packages`, `localPackage`. The subgraph's
// validation logic strips `required` at the top level so that operator
// overrides may submit just the `connect.*` block.

export const BUNDLED_RUNTIME_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://powerhouse.inc/schemas/powerhouse.config.json",
  title: "Powerhouse Connect runtime configuration",
  description:
    "Runtime configuration loaded by Connect at boot from /powerhouse.config.json.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "packages", "localPackage"],
  properties: {
    $schema: { type: "string" },
    schemaVersion: { const: 2 },
    packages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["packageName"],
        properties: {
          packageName: { type: "string" },
          version: { type: "string" },
          provider: {
            type: "string",
            enum: ["npm", "github", "local", "registry"],
          },
          url: { type: "string" },
        },
      },
    },
    packageRegistryUrl: { type: "string" },
    localPackage: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "version"],
          properties: {
            name: { type: "string" },
            version: { type: "string" },
          },
        },
      ],
    },
    connect: {
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
    },
  },
} as const;
