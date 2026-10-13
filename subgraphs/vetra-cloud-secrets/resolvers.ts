import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import type { OpenBaoTransitClient } from "./openbao-transit.js";
import { createSecretsService } from "./services/secrets-service.js";
import {
  createTenantGuard,
  type SecretsContext,
  type TenantAccessDeps,
} from "./access.js";

export function createResolvers(
  db: Kysely<SecretsDB>,
  transit: OpenBaoTransitClient,
  access: TenantAccessDeps,
): Record<string, any> {
  const service = createSecretsService({ db, transit });
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
        await guard(ctx, tenantId);
        return service.setEnvVar(tenantId, key, value);
      },

      deleteEnvVar: async (
        _p: unknown,
        { tenantId, key }: { tenantId: string; key: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId);
        return service.deleteEnvVar(tenantId, key);
      },

      setSecret: async (
        _p: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId);
        return service.setSecret(tenantId, key, value);
      },

      deleteSecret: async (
        _p: unknown,
        { tenantId, key }: { tenantId: string; key: string },
        ctx?: SecretsContext,
      ) => {
        await guard(ctx, tenantId);
        return service.deleteSecret(tenantId, key);
      },
    },
  };
}
