import { sql, type Kysely } from "kysely";
import type { RuntimeConfigDB } from "./db/schema.js";
import { mergeWithDefaults } from "./defaults.js";
import { InvalidRuntimeConfigError } from "./errors.js";
import { validateRuntimeConfig } from "./validation.js";
import {
  RUNTIME_CONFIG_NOTIFY_CHANNEL,
  RUNTIME_CONFIG_SCHEMA_VERSION,
  type PHConnectRuntimeConfig,
} from "./types.js";

export function createResolvers(
  db: Kysely<RuntimeConfigDB>,
): Record<string, any> {
  return {
    Query: {
      runtimeConfig: async (
        _parent: unknown,
        { tenantId }: { tenantId: string },
      ) => {
        const row = await db
          .selectFrom("tenant_runtime_config")
          .select(["value", "updatedAt"])
          .where("tenantId", "=", tenantId)
          .executeTakeFirst();
        const overrides = row ? safeParse(row.value) : {};
        return {
          effective: mergeWithDefaults(overrides),
          overrides,
          schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
          updatedAt: row?.updatedAt ?? null,
        };
      },
    },

    Mutation: {
      setRuntimeConfig: async (
        _parent: unknown,
        { tenantId, json }: { tenantId: string; json: unknown },
      ) => {
        const result = validateRuntimeConfig(json);
        if (!result.ok) throw new InvalidRuntimeConfigError(result.issues);

        const overrides = (json ?? {}) as PHConnectRuntimeConfig;
        const isEmpty = Object.keys(overrides).length === 0;
        const now = new Date().toISOString();

        await db.transaction().execute(async (trx) => {
          if (isEmpty) {
            await trx
              .deleteFrom("tenant_runtime_config")
              .where("tenantId", "=", tenantId)
              .execute();
          } else {
            await trx
              .insertInto("tenant_runtime_config")
              .values({
                tenantId,
                value: JSON.stringify(overrides),
                updatedAt: now,
              })
              .onConflict((oc) =>
                oc.columns(["tenantId"]).doUpdateSet({
                  value: JSON.stringify(overrides),
                  updatedAt: now,
                }),
              )
              .execute();
          }
          await sql`SELECT pg_notify(${RUNTIME_CONFIG_NOTIFY_CHANNEL}, ${tenantId})`.execute(
            trx,
          );
        });

        return {
          effective: mergeWithDefaults(overrides),
          overrides,
          schemaVersion: RUNTIME_CONFIG_SCHEMA_VERSION,
          updatedAt: isEmpty ? null : now,
        };
      },
    },
  };
}

function safeParse(value: string): PHConnectRuntimeConfig {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as PHConnectRuntimeConfig;
    }
  } catch {
    // Stored value corrupt; treat as no overrides rather than throwing on
    // every read.
  }
  return {};
}
