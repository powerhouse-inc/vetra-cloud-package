import { mergeWithDefaults } from "./defaults.js";
import { InvalidRuntimeConfigError } from "./errors.js";
import { requireAuthenticatedUser } from "./auth.js";
import type { AuthContext } from "./auth.js";
import { validateRuntimeConfig } from "./validation.js";
import { RUNTIME_CONFIG_SCHEMA_VERSION } from "./types.js";
import type {
  EnvVarsStore,
  RuntimeConfigOverrides,
  RuntimeConfigPayload,
} from "./types.js";

export type ResolversDeps = { store: EnvVarsStore };

export function createResolvers(deps: ResolversDeps) {
  const { store } = deps;

  async function runtimeConfig(
    _parent: unknown,
    args: { tenantId: string },
    ctx: AuthContext,
  ): Promise<RuntimeConfigPayload> {
    requireAuthenticatedUser(ctx);
    const row = await store.getRuntimeConfigOverrides(args.tenantId);
    const overrides = parseOverrides(row?.value);
    return {
      effective: mergeWithDefaults(overrides),
      overrides,
      schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async function setRuntimeConfig(
    _parent: unknown,
    args: { tenantId: string; json: unknown },
    ctx: AuthContext,
  ): Promise<RuntimeConfigPayload> {
    requireAuthenticatedUser(ctx);
    const validation = validateRuntimeConfig(args.json);
    if (!validation.ok) {
      throw new InvalidRuntimeConfigError(validation.issues);
    }
    const overrides = (args.json ?? {}) as RuntimeConfigOverrides;
    const isEmpty = Object.keys(overrides).length === 0;
    const { updatedAt } = await store.setRuntimeConfigOverrides(
      args.tenantId,
      isEmpty ? null : JSON.stringify(overrides),
    );
    return {
      effective: mergeWithDefaults(overrides),
      overrides,
      schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }

  return {
    Query: { runtimeConfig },
    Mutation: { setRuntimeConfig },
  };
}

function parseOverrides(value: string | undefined): RuntimeConfigOverrides {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RuntimeConfigOverrides;
    }
  } catch {
    // Stored value corrupt; treat as no overrides rather than throwing on
    // every read.
  }
  return {};
}
