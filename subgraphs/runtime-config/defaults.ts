import { BUNDLED_DEFAULT_CONNECT_CONFIG } from "./bundled-defaults.js";
import type { PHConnectRuntimeConfig } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Recursive deep-merge for the `connect.*` subtree.
 *
 * Merge semantics (must match Connect's entrypoint deep-merge):
 *   - Plain objects merge per-key (override wins).
 *   - Arrays are replaced wholesale (no element-wise merge).
 *   - Primitives replace.
 *   - `undefined` is "no opinion" — leave base in place.
 */
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
  overrides: PHConnectRuntimeConfig,
  defaults: PHConnectRuntimeConfig = BUNDLED_DEFAULT_CONNECT_CONFIG,
): PHConnectRuntimeConfig {
  return deepMerge(defaults, overrides);
}
