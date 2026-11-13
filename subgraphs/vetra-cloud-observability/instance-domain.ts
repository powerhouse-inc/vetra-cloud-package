import type { Kysely } from "kysely";

/**
 * Whether a holder's Vetra Apps instance serves this custom domain. Only
 * `issuing`/`active` claims count (a `dns`/`failed` one has proven nothing);
 * removed instances are ignored. Fails closed: when the apps database cannot
 * be read the domain is treated as taken.
 */
export function createInstanceDomainUsed(
  appsDb: Kysely<any>,
): (domain: string) => Promise<boolean> {
  return async (domain) => {
    try {
      const row = await appsDb
        .selectFrom("instances")
        .select("id")
        .where("custom_domain", "=", domain)
        .where("custom_domain_status", "in", ["issuing", "active"])
        .where("status", "!=", "removed")
        .executeTakeFirst();
      return !!row;
    } catch {
      return true;
    }
  };
}
