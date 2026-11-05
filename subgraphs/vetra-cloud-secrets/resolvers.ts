import { GraphQLError } from "graphql";
import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import type { OpenBaoTransitClient } from "./openbao-transit.js";
import {
  createSecretsService,
  ManagedSecretKeyError,
  MANAGED_KEY_ERROR_CODE,
} from "./services/secrets-service.js";
import {
  createTenantGuard,
  type SecretsContext,
  type TenantAccessDeps,
} from "./access.js";

/** Surface a managed-key refusal with its code so the console can tell it apart. */
async function withCodes<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ManagedSecretKeyError) {
      throw new GraphQLError(err.message, {
        extensions: { code: MANAGED_KEY_ERROR_CODE, key: err.key },
      });
    }
    throw err;
  }
}

export function createResolvers(
  db: Kysely<SecretsDB>,
  transit: OpenBaoTransitClient,
  access: TenantAccessDeps,
): Record<string, any> {
  // User-facing: refuses the keys Vetra manages (PLATFORM_MANAGED_KEYS).
  const service = createSecretsService({ db, transit, userFacing: true });
  const guard = createTenantGuard(access);
  return {
    Query: {
      envVars: async (
        _p: unknown,
        { tenantId }: { tenantId: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId);
        return service.listEnvVars(tenantId);
      },

      secrets: async (
        _p: unknown,
        { tenantId }: { tenantId: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId);
        return service.listSecretKeys(tenantId);
      },
    },

    Mutation: {
      setEnvVar: async (
        _p: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId, { wait: true });
        return withCodes(() => service.setEnvVar(tenantId, key, value));
      },

      deleteEnvVar: async (
        _p: unknown,
        { tenantId, key }: { tenantId: string; key: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId, { wait: true });
        return withCodes(() => service.deleteEnvVar(tenantId, key));
      },

      setSecret: async (
        _p: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId, { wait: true });
        return withCodes(() => service.setSecret(tenantId, key, value));
      },

      deleteSecret: async (
        _p: unknown,
        { tenantId, key }: { tenantId: string; key: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId, { wait: true });
        return withCodes(() => service.deleteSecret(tenantId, key));
      },
    },
  };
}
