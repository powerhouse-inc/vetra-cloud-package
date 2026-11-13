import type { Kysely } from "kysely";

const MISSING = new Set(["42P01", "42703"]);

/** States of a real switch-over in which the new instance may run but is not verified yet. */
const UNVERIFIED = new Set(["STARTING", "VERIFYING"]);

/**
 * The processor's warm lookup for own plans' pools (slice 8): an unclaimed
 * warm instance renders with its ingress closed. A table or column that does
 * not exist yet means no pool row exists; any other failure throws, so a warm
 * environment never renders open by accident. A row marked removed but not
 * yet deleted still answers warm (its ingress stays closed while it goes).
 */
export function createInstancePoolLookup(appsDb: Kysely<any>) {
  return async (
    documentId: string,
  ): Promise<{ appId: string; rehearsal?: true; unverified?: true } | null> => {
    try {
      const row = (await appsDb
        .selectFrom("instances")
        .select("app_id")
        .where("environment_id", "=", documentId)
        .where("warm", "=", true)
        .where("holder_address", "is", null)
        .executeTakeFirst()) as { app_id: string } | undefined;
      if (row) return { appId: row.app_id };
      // A switch-over's instance (switchover_id set until LINKING):
      //  - a dry-run clone (no holder) is a rehearsal, closed for good, backups off;
      //  - a real new instance has its hold released in STARTING but is not
      //    reachable until VERIFYING passed, so no holder can write before the
      //    copy is verified (it opens when LINKING re-renders it).
      // Marked explicitly, never inferred from empty ADMINS.
      const sw = (await appsDb
        .selectFrom("instances")
        .innerJoin("switchovers", "switchovers.id", "instances.switchover_id")
        .select([
          "instances.app_id as app_id",
          "instances.holder_address as holder_address",
          "switchovers.mode as mode",
          "switchovers.state as state",
        ])
        .where("instances.environment_id", "=", documentId)
        .executeTakeFirst()) as
        | {
            app_id: string;
            holder_address: string | null;
            mode: string;
            state: string;
          }
        | undefined;
      if (!sw) return null;
      if (sw.mode === "dry_run" && sw.holder_address === null)
        return { appId: sw.app_id, rehearsal: true };
      if (sw.mode === "real" && UNVERIFIED.has(sw.state))
        return { appId: sw.app_id, unverified: true };
      return null;
    } catch (err) {
      if (MISSING.has(String((err as { code?: unknown } | null)?.code)))
        return null;
      throw err;
    }
  };
}
