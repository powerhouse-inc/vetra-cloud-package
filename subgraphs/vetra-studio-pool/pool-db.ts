import type { Kysely } from "kysely";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";

export interface ClaimedRow {
  id: string;
  tenantId: string | null;
  subdomain: string | null;
  poolState: string | null;
}

export interface ClaimDb {
  /**
   * Atomically flip exactly one AVAILABLE current-version row to CLAIMED.
   * `FOR UPDATE SKIP LOCKED` guarantees two concurrent claims pick different
   * rows. Returns the assigned row, or null when none is available.
   */
  claimOneAvailable(
    addr: string,
    version: string,
    nowIso: string,
  ): Promise<ClaimedRow | null>;
  /** Mark a (partially-mutated) env FAILED so it never re-enters the pool. */
  markFailed(id: string): Promise<void>;
}

export function makeClaimDb(db: Kysely<DB>): ClaimDb {
  return {
    async claimOneAvailable(addr, version, nowIso) {
      // Atomic: lock + flip exactly one AVAILABLE current-version row to CLAIMED.
      // Uses the query builder (NOT raw sql) so the reactor's namespaced Kysely
      // schema-qualifies `environments` — raw sql runs in the default search_path
      // where the table doesn't exist.
      const row = (await db
        .updateTable("environments")
        .set({ poolState: "CLAIMED", claimedBy: addr, claimedAt: nowIso })
        .where(
          "id",
          "=",
          db
            .selectFrom("environments")
            .select("id")
            .where("poolState", "=", "AVAILABLE")
            .where("pinnedVersion", "=", version)
            .orderBy("id")
            .limit(1)
            .forUpdate()
            .skipLocked(),
        )
        .returning(["id", "tenantId", "subdomain", "poolState"])
        .executeTakeFirst()) as ClaimedRow | undefined;
      return row ?? null;
    },

    async markFailed(id) {
      await db
        .updateTable("environments")
        .set({ poolState: "FAILED" })
        .where("id", "=", id)
        .execute();
    },
  };
}

export interface SeedWarmingInput {
  id: string;
  subdomain: string;
  tenantId: string;
  pinnedVersion: string;
}

export interface PoolRowDb {
  id: string;
  poolState: string | null;
  pinnedVersion: string | null;
  status: string | null;
}

export interface KeeperDb {
  listPoolRows(): Promise<PoolRowDb[]>;
  seedWarming(input: SeedWarmingInput): Promise<void>;
  promoteReadyToAvailable(): Promise<void>;
  markFailed(id: string): Promise<void>;
}

/** Keeper-side helpers over the shared `environments` table. */
export function makeKeeperDb(db: Kysely<DB>): KeeperDb {
  return {
    async listPoolRows() {
      return (await db
        .selectFrom("environments")
        .select(["id", "poolState", "pinnedVersion", "status"])
        .where("poolState", "in", ["WARMING", "AVAILABLE", "CLAIMED", "FAILED"])
        .execute()) as PoolRowDb[];
    },

    async seedWarming(input) {
      // Disjoint from the processor's own upsert (which sets name/services/etc).
      await db
        .insertInto("environments")
        .values({
          id: input.id,
          subdomain: input.subdomain,
          tenantId: input.tenantId,
          poolState: "WARMING",
          pinnedVersion: input.pinnedVersion,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            poolState: "WARMING",
            pinnedVersion: input.pinnedVersion,
          }),
        )
        .execute();
    },

    async promoteReadyToAvailable() {
      await db
        .updateTable("environments")
        .set({ poolState: "AVAILABLE" })
        .where("poolState", "=", "WARMING")
        .where("status", "=", "READY")
        .execute();
    },

    async markFailed(id) {
      await db
        .updateTable("environments")
        .set({ poolState: "FAILED" })
        .where("id", "=", id)
        .execute();
    },
  };
}
