import { sql, type Kysely } from "kysely";
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
      const rows = await sql<ClaimedRow>`
        UPDATE environments
        SET "poolState" = 'CLAIMED', "claimedBy" = ${addr}, "claimedAt" = ${nowIso}
        WHERE id = (
          SELECT id FROM environments
          WHERE "poolState" = 'AVAILABLE' AND "pinnedVersion" = ${version}
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "tenantId", subdomain, "poolState"
      `.execute(db);
      return rows.rows[0] ?? null;
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
