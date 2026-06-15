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
   * Atomically flip exactly one AVAILABLE, READY, current-version row to
   * CLAIMED. `FOR UPDATE SKIP LOCKED` guarantees two concurrent claims pick
   * different rows; the `status='READY'` guard ensures a recycled/terminating
   * "zombie" (poolState lingering on a dead env) can never be handed out.
   * Returns the assigned row, or null when none is available.
   */
  claimOneAvailable(
    addr: string,
    version: string,
    nowIso: string,
  ): Promise<ClaimedRow | null>;
}

export function makeClaimDb(db: Kysely<DB>): ClaimDb {
  return {
    async claimOneAvailable(addr, version, nowIso) {
      // Query builder (NOT raw sql) so the reactor's namespaced Kysely
      // schema-qualifies `environments`.
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
            .where("status", "=", "READY")
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
  /** Clear poolState (→ null) for the given ids — removes them from the pool. */
  clearPoolState(ids: string[]): Promise<void>;
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
      // New docs insert cleanly. The onConflict guard only (re)sets poolState
      // when it is currently NULL (e.g. re-adopting a cleared env) — it never
      // clobbers a WARMING/AVAILABLE/CLAIMED row.
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
          oc
            .column("id")
            .doUpdateSet({
              poolState: "WARMING",
              pinnedVersion: input.pinnedVersion,
            })
            .where("environments.poolState", "is", null),
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

    async clearPoolState(ids) {
      if (ids.length === 0) return;
      await db
        .updateTable("environments")
        .set({ poolState: null })
        .where("id", "in", ids)
        .execute();
    },
  };
}
