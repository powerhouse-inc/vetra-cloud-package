import type { Kysely } from "kysely";
import type { StudioLlmKeys, VetraLlmDB } from "./db/schema.js";

export type StudioLlmKeysPatch = Partial<
  Omit<StudioLlmKeys, "environment_id" | "created_at">
>;

export interface LlmKeyStore {
  get(environmentId: string): Promise<StudioLlmKeys | null>;
  /** Insert, or replace everything but environment_id and created_at. */
  upsert(row: StudioLlmKeys): Promise<void>;
  update(environmentId: string, patch: StudioLlmKeysPatch): Promise<void>;
  /** Rows whose key still exists on OpenRouter: ACTIVE or DISABLED, with a hash. */
  listHeld(): Promise<StudioLlmKeys[]>;
}

export function createLlmKeyStore(db: Kysely<VetraLlmDB>): LlmKeyStore {
  return {
    async get(environmentId) {
      return (
        (await db
          .selectFrom("studio_llm_keys")
          .selectAll()
          .where("environment_id", "=", environmentId)
          .executeTakeFirst()) ?? null
      );
    },
    async upsert(row) {
      const rest = {
        source: row.source,
        key_hash: row.key_hash,
        key_ciphertext: row.key_ciphertext,
        limit_usd: row.limit_usd,
        limit_reset: row.limit_reset,
        model: row.model,
        owner_did: row.owner_did,
        status: row.status,
        updated_at: row.updated_at,
      };
      await db
        .insertInto("studio_llm_keys")
        .values(row)
        .onConflict((oc) => oc.column("environment_id").doUpdateSet(rest))
        .execute();
    },
    async update(environmentId, patch) {
      await db
        .updateTable("studio_llm_keys")
        .set(patch)
        .where("environment_id", "=", environmentId)
        .execute();
    },
    async listHeld() {
      return db
        .selectFrom("studio_llm_keys")
        .selectAll()
        .where("status", "in", ["ACTIVE", "DISABLED"])
        .where("key_hash", "is not", null)
        .orderBy("environment_id")
        .execute();
    },
  };
}
