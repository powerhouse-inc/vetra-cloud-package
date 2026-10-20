import type { Kysely } from "kysely";
import type {
  StudioLlmBudgetOverrides,
  StudioLlmBudgetRequests,
  StudioLlmKeys,
  VetraLlmDB,
} from "./db/schema.js";

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

export interface LlmBudgetStore {
  /** The Studio's admin override (USD/month); null when none. */
  getOverride(environmentId: string): Promise<number | null>;
  /** Insert or replace the Studio's override. */
  setOverride(row: StudioLlmBudgetOverrides): Promise<void>;
  /** An unhandled request made at or after `sinceIso`; null when none. */
  openRequestSince(
    environmentId: string,
    sinceIso: string,
  ): Promise<StudioLlmBudgetRequests | null>;
  addRequest(row: StudioLlmBudgetRequests): Promise<void>;
  /** Mark every unhandled request of the Studio handled; returns how many. */
  handleRequests(environmentId: string, handledAt: string): Promise<number>;
}

export function createBudgetStore(db: Kysely<VetraLlmDB>): LlmBudgetStore {
  return {
    async getOverride(environmentId) {
      const row = await db
        .selectFrom("studio_llm_budget_overrides")
        .select("limit_usd")
        .where("environment_id", "=", environmentId)
        .executeTakeFirst();
      return row?.limit_usd ?? null;
    },
    async setOverride(row) {
      await db
        .insertInto("studio_llm_budget_overrides")
        .values(row)
        .onConflict((oc) =>
          oc.column("environment_id").doUpdateSet({
            limit_usd: row.limit_usd,
            set_by: row.set_by,
            updated_at: row.updated_at,
          }),
        )
        .execute();
    },
    async openRequestSince(environmentId, sinceIso) {
      // ISO-8601 UTC strings order lexicographically.
      return (
        (await db
          .selectFrom("studio_llm_budget_requests")
          .selectAll()
          .where("environment_id", "=", environmentId)
          .where("handled_at", "is", null)
          .where("requested_at", ">=", sinceIso)
          .orderBy("requested_at", "desc")
          .executeTakeFirst()) ?? null
      );
    },
    async addRequest(row) {
      await db.insertInto("studio_llm_budget_requests").values(row).execute();
    },
    async handleRequests(environmentId, handledAt) {
      const res = await db
        .updateTable("studio_llm_budget_requests")
        .set({ handled_at: handledAt })
        .where("environment_id", "=", environmentId)
        .where("handled_at", "is", null)
        .executeTakeFirst();
      return Number(res.numUpdatedRows);
    },
  };
}
