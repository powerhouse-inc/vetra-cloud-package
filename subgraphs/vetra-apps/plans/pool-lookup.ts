import type { Kysely } from "kysely";

const MISSING = new Set(["42P01", "42703"]);

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
  ): Promise<{ appId: string; rehearsal?: true } | null> => {
    try {
      const row = (await appsDb
        .selectFrom("instances")
        .select("app_id")
        .where("environment_id", "=", documentId)
        .where("warm", "=", true)
        .where("holder_address", "is", null)
        .executeTakeFirst()) as { app_id: string } | undefined;
      if (row) return { appId: row.app_id };
      // A dry-run clone: a row with no holder whose switch-over is a rehearsal.
      // Marked explicitly (never inferred from empty ADMINS): it renders with
      // every ingress closed and its backups off.
      const rehearsal = (await appsDb
        .selectFrom("instances")
        .leftJoin("switchovers", "switchovers.id", "instances.switchover_id")
        .select("instances.app_id as app_id")
        .where("instances.environment_id", "=", documentId)
        .where("instances.holder_address", "is", null)
        .where("switchovers.mode", "=", "dry_run")
        .executeTakeFirst()) as { app_id: string } | undefined;
      return rehearsal ? { appId: rehearsal.app_id, rehearsal: true } : null;
    } catch (err) {
      if (MISSING.has(String((err as { code?: unknown } | null)?.code)))
        return null;
      throw err;
    }
  };
}
