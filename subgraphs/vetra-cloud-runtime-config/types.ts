import type { PHConnectRuntimeConfig } from "@powerhousedao/shared/connect";

export type RuntimeConfigOverrides = Partial<{
  connect: Partial<PHConnectRuntimeConfig>;
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
