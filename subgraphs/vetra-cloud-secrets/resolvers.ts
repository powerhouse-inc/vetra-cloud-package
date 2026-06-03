import { sql, type Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import type { OpenBaoTransitClient } from "./openbao-transit.js";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const NOTIFY_CHANNEL = "vetra_secrets_changed";

/**
 * Keys reserved for other subgraphs' write paths. Setting these via
 * setEnvVar would either be overwritten on the next reconcile or, worse,
 * stomp a typed write coming through a different subgraph. The denylist
 * is intentionally tiny — only add keys that have a dedicated owner.
 *
 * PH_CONNECT_CONFIG_JSON is owned by the vetra-cloud-environment document
 * model; set it via the SET_RUNTIME_CONFIG operation.
 */
const RESERVED_KEYS = new Set<string>(["PH_CONNECT_CONFIG_JSON"]);

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid key "${key}": key must match ^[A-Z][A-Z0-9_]*$ (e.g. MY_VAR, API_KEY)`,
    );
  }
  if (RESERVED_KEYS.has(key)) {
    throw new Error(
      `Reserved key "${key}" cannot be set via setEnvVar; set it through the vetra-cloud-environment document's SET_CONNECT_RUNTIME_CONFIG operation instead`,
    );
  }
}

export function createResolvers(
  db: Kysely<SecretsDB>,
  transit: OpenBaoTransitClient,
): Record<string, any> {
  return {
    Query: {
      envVars: async (_parent: unknown, { tenantId }: { tenantId: string }) =>
        db
          .selectFrom("tenant_env_vars")
          .select(["key", "value"])
          .where("tenantId", "=", tenantId)
          .orderBy("key", "asc")
          .execute(),

      secrets: async (_parent: unknown, { tenantId }: { tenantId: string }) => {
        const rows = await db
          .selectFrom("tenant_secrets")
          .select("key")
          .where("tenantId", "=", tenantId)
          .orderBy("key", "asc")
          .execute();
        return rows.map((r) => ({ key: r.key }));
      },
    },

    Mutation: {
      setEnvVar: async (
        _parent: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
      ) => {
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
          await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(
            trx,
          );
        });

        return { key, value };
      },

      deleteEnvVar: async (
        _parent: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => {
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

      setSecret: async (
        _parent: unknown,
        { tenantId, key, value }: { tenantId: string; key: string; value: string },
      ) => {
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
          await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${tenantId})`.execute(
            trx,
          );
        });

        return { key };
      },

      deleteSecret: async (
        _parent: unknown,
        { tenantId, key }: { tenantId: string; key: string },
      ) => {
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
    },
  };
}
