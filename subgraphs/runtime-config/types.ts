// Shape of the runtime config the SPA reads at boot. Mirrors the `connect.*`
// block of `@powerhousedao/shared/connect/runtime-config.ts` (powerhouse
// monorepo, branch `feat/connect-config-json-2`).
//
// Defined locally so this subgraph package does not need to pin a specific
// @powerhousedao/shared release. The subgraph stores and returns this shape
// directly (the surrounding envelope — schemaVersion / packages / localPackage —
// is emitter-stamped by the build pipeline and not editable from the UI).
export type DriveSection = {
  enabled?: boolean;
  allowAdd?: boolean;
  allowDelete?: boolean;
};

export type PHConnectRuntimeConfig = {
  branding?: {
    appName?: string;
    homeBackground?:
      | null
      | { avif?: string; png?: string };
  };
  app?: {
    logLevel?: "debug" | "info" | "warn" | "error";
    basePath?: string;
  };
  packages?: {
    externalEnabled?: boolean;
  };
  drives?: {
    allowAddDrive?: boolean;
    defaultDrives?: Array<{
      url: string;
      name?: string | null;
      icon?: string | null;
    }>;
    preserveStrategy?: "preserve-all" | "preserve-by-url-and-detach";
    sections?: {
      remote?: DriveSection;
      local?: DriveSection;
    };
  };
  renown?: {
    url?: string;
    networkId?: string;
    chainId?: number;
  };
  sentry?: {
    dsn?: string | null;
    env?: string;
    tracing?: boolean;
  };
};

/**
 * Payload returned by `runtimeConfig` query / `setRuntimeConfig` mutation.
 *
 * - `effective`: BUNDLED_DEFAULT_CONNECT_CONFIG deep-merged with overrides.
 * - `overrides`: the keys the user has explicitly set (the connect.* subtree).
 * - `schemaVersion`: the schema version this resolver knows about.
 * - `updatedAt`: ISO-8601 timestamp of the most recent write; null when no
 *   overrides exist.
 */
export type RuntimeConfigPayload = {
  effective: PHConnectRuntimeConfig;
  overrides: PHConnectRuntimeConfig;
  schemaVersion: string;
  updatedAt: string | null;
};

/**
 * Key used in the `<tenantId>-env` ConfigMap that the secrets-controller
 * projects from the `tenant_runtime_config` table. Connect's entrypoint
 * reads this env var, JSON-parses it, and deep-merges into
 * `/dist/powerhouse.config.json`.
 *
 * Also the reserved key that `vetra-cloud-secrets.setEnvVar` rejects (the
 * denylist guard) so the two writers never race for the same ConfigMap key.
 */
export const RUNTIME_CONFIG_ENV_KEY = "PH_CONNECT_CONFIG_JSON";

/** Schema version this resolver was built against. Returned in the payload. */
export const RUNTIME_CONFIG_SCHEMA_VERSION = "2";

/** Postgres NOTIFY channel name the resolver fires on every write. Must match
 *  what secrets-controller's runtime-config listener subscribes to. */
export const RUNTIME_CONFIG_NOTIFY_CHANNEL = "vetra_runtime_config_changed";

/** Reactor namespace passed to `relationalDb.createNamespace(...)`. The
 *  secrets-controller computes `hashNamespace(...)` on this same string to
 *  resolve the actual Postgres schema name. */
export const RUNTIME_CONFIG_DB_NAMESPACE = "vetra-cloud-runtime-config";
