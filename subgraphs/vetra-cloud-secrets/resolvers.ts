import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import type { OpenBaoTransitClient } from "./openbao-transit.js";
import { createSecretsService } from "./services/secrets-service.js";

export function createResolvers(
  db: Kysely<SecretsDB>,
  transit: OpenBaoTransitClient,
): Record<string, any> {
  const service = createSecretsService({ db, transit });
  return {
    Query: {
      envVars: (_p: unknown, { tenantId }: { tenantId: string }) =>
        service.listEnvVars(tenantId),

      secrets: (_p: unknown, { tenantId }: { tenantId: string }) =>
        service.listSecretKeys(tenantId),
    },

    Mutation: {
      setEnvVar: (
        _p: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
      ) => service.setEnvVar(tenantId, key, value),

      deleteEnvVar: (
        _p: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => service.deleteEnvVar(tenantId, key),

      setSecret: (
        _p: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
      ) => service.setSecret(tenantId, key, value),

      deleteSecret: (
        _p: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => service.deleteSecret(tenantId, key),
    },
  };
}
