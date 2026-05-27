// Shape of the runtime config the SPA reads at boot. Mirrors
// `PHConnectRuntimeConfig` in `@powerhousedao/shared/connect` and the
// `connect.*` block of the canonical JSON Schema in
// `@powerhousedao/builder-tools` (runtime-config.schema.json).
//
// Defined locally so this subgraph package does not need to pin a specific
// @powerhousedao/shared version. Production deployments can override the
// bundled defaults + schema via the subgraph constructor when the upstream
// packages ship new fields.
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

export type RuntimeConfigOverrides = Partial<{
  connect: PHConnectRuntimeConfig;
  schemaVersion: number;
  packages: unknown[];
  packageRegistryUrl: string;
  localPackage: unknown;
}>;

export type RuntimeConfigEffective = {
  schemaVersion: number;
  packages: unknown[];
  localPackage: unknown;
  packageRegistryUrl?: string;
  connect: PHConnectRuntimeConfig;
};

export type RuntimeConfigPayload = {
  effective: RuntimeConfigEffective;
  overrides: RuntimeConfigOverrides;
  schemaVersion: string;
  updatedAt: string | null;
};

export type EnvVarsStore = {
  getRuntimeConfigOverrides(tenantId: string): Promise<{
    value: string;
    updatedAt: Date;
  } | null>;
  setRuntimeConfigOverrides(
    tenantId: string,
    value: string | null,
  ): Promise<{ updatedAt: Date | null }>;
};

export const RUNTIME_CONFIG_ENV_KEY = "PH_CONNECT_CONFIG_JSON";
export const RUNTIME_CONFIG_SCHEMA_VERSION = "2";
