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
  return async (documentId: string): Promise<{ appId: string } | null> => {
    try {
      const row = (await appsDb
        .selectFrom("instances")
        .select("app_id")
        .where("environment_id", "=", documentId)
        .where("warm", "=", true)
        .where("holder_address", "is", null)
        .executeTakeFirst()) as { app_id: string } | undefined;
      return row ? { appId: row.app_id } : null;
    } catch (err) {
      if (MISSING.has(String((err as { code?: unknown } | null)?.code)))
        return null;
      throw err;
    }
  };
}
