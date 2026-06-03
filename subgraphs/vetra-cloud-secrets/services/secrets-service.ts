import { sql, type Kysely } from "kysely";
import type { SecretsDB } from "../db/schema.js";
import type { OpenBaoTransitClient } from "../openbao-transit.js";

/**
 * Shared service for reading + writing tenant env vars and secrets. Used by:
 *   - The GraphQL resolvers (`vetra-cloud-secrets` subgraph) — the public
 *     surface that the vetra.to Configuration UI talks to.
 *   - The `vetra-cloud-environment` gitops processor — when emitting tenant
 *     values.yaml, it routes env entries through here so secrets land in
 *     the encrypted `tenant_secrets` table (and never in plaintext in the
 *     synced values.yaml).
 *
 * All writes pg_notify('vetra_secrets_changed', tenantId) inside the
 * same transaction so the standalone `vetra-secrets-controller` pod
 * picks up the change and materializes the tenant ConfigMap/Secret.
 */

export const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const NOTIFY_CHANNEL = "vetra_secrets_changed";

export class InvalidSecretsKeyError extends Error {
  constructor(key: string) {
    super(
      `Invalid key "${key}": key must match ^[A-Z][A-Z0-9_]*$ (e.g. MY_VAR, API_KEY)`,
    );
    this.name = "InvalidSecretsKeyError";
  }
}

/**
 * Keys reserved for another write path. PH_CONNECT_CONFIG_JSON is owned by the
 * vetra-cloud-environment document model (SET_RUNTIME_CONFIG operation) and is
 * rendered onto the connect pod's env via the gitops processor — it must not be
 * set as a raw env var here (via the resolvers or the processor's env routing).
 */
const RESERVED_KEYS = new Set<string>(["PH_CONNECT_CONFIG_JSON"]);

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new InvalidSecretsKeyError(key);
  }
  if (RESERVED_KEYS.has(key)) {
    throw new Error(
      `Reserved key "${key}" cannot be set via setEnvVar; set it through the vetra-cloud-environment document's SET_RUNTIME_CONFIG operation instead`,
    );
  }
}

export interface SecretsService {
  /** Plaintext env vars for one tenant, sorted by key. */
  listEnvVars(tenantId: string): Promise<Array<{ key: string; value: string }>>;
  /** Secret KEY names for one tenant (values never returned), sorted. */
  listSecretKeys(tenantId: string): Promise<Array<{ key: string }>>;
  /** Upsert a plaintext env var. Notifies the secrets-controller. */
  setEnvVar(
    tenantId: string,
    key: string,
    value: string,
  ): Promise<{ key: string; value: string }>;
  /** Remove a plaintext env var. Returns true if a row was deleted. */
  deleteEnvVar(tenantId: string, key: string): Promise<boolean>;
  /** Upsert a secret. The value is encrypted via OpenBao transit before storage. */
  setSecret(
    tenantId: string,
    key: string,
    value: string,
  ): Promise<{ key: string }>;
  /** Remove a secret. Returns true if a row was deleted. */
  deleteSecret(tenantId: string, key: string): Promise<boolean>;
}

export interface CreateSecretsServiceArgs {
  db: Kysely<SecretsDB>;
  transit: OpenBaoTransitClient;
}

export function createSecretsService({
  db,
  transit,
}: CreateSecretsServiceArgs): SecretsService {
  return {
    async listEnvVars(tenantId) {
      return db
        .selectFrom("tenant_env_vars")
        .select(["key", "value"])
        .where("tenantId", "=", tenantId)
        .orderBy("key", "asc")
        .execute();
    },

    async listSecretKeys(tenantId) {
      return db
        .selectFrom("tenant_secrets")
        .select("key")
        .where("tenantId", "=", tenantId)
        .orderBy("key", "asc")
        .execute();
    },

    async setEnvVar(tenantId, key, value) {
      validateKey(key);
      const now = new Date().toISOString();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("tenant_env_vars")
          .values({ tenantId, key, value, updatedAt: now })
          .onConflict((oc) =>
            oc
              .columns(["tenantId", "key"])
              .doUpdateSet({ value, updatedAt: now }),
          )
          .execute();
        await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(trx);
      });
      return { key, value };
    },

    async deleteEnvVar(tenantId, key) {
      return await db.transaction().execute(async (trx) => {
        const result = await trx
          .deleteFrom("tenant_env_vars")
          .where("tenantId", "=", tenantId)
          .where("key", "=", key)
          .executeTakeFirst();
        const deleted = Number(result.numDeletedRows) > 0;
        if (deleted) {
          await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(
            trx,
          );
        }
        return deleted;
      });
    },

    async setSecret(tenantId, key, value) {
      validateKey(key);
      await transit.ensureTenantKey(tenantId);
      const ciphertext = await transit.encrypt(tenantId, value);
      const now = new Date().toISOString();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto("tenant_secrets")
          .values({ tenantId, key, updatedAt: now, ciphertext })
          .onConflict((oc) =>
            oc
              .columns(["tenantId", "key"])
              .doUpdateSet({ updatedAt: now, ciphertext }),
          )
          .execute();
        await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(trx);
      });
      return { key };
    },

    async deleteSecret(tenantId, key) {
      return await db.transaction().execute(async (trx) => {
        const result = await trx
          .deleteFrom("tenant_secrets")
          .where("tenantId", "=", tenantId)
          .where("key", "=", key)
          .executeTakeFirst();
        const deleted = Number(result.numDeletedRows) > 0;
        if (deleted) {
          await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(
            trx,
          );
        }
        return deleted;
      });
    },
  };
}
