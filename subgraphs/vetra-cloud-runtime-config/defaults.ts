import { BUNDLED_DEFAULT_CONNECT_CONFIG } from "./bundled-defaults.js";
import type {
  PHConnectRuntimeConfig,
  RuntimeConfigEffective,
  RuntimeConfigOverrides,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) {
    // null, primitives, arrays: override wins.
    return override as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = deepMerge(
      (base as Record<string, unknown>)[key],
      override[key],
    );
  }
  return result as T;
}

export function mergeWithDefaults(
  overrides: RuntimeConfigOverrides,
  defaults: PHConnectRuntimeConfig = BUNDLED_DEFAULT_CONNECT_CONFIG,
): RuntimeConfigEffective {
  const connect = deepMerge(defaults, overrides.connect);
  return {
    schemaVersion: overrides.schemaVersion ?? 2,
    packages: overrides.packages ?? [],
    localPackage: overrides.localPackage ?? null,
    packageRegistryUrl: overrides.packageRegistryUrl,
    connect,
  };
}
