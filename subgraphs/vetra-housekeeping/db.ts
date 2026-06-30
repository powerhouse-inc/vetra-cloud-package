import type { Kysely } from "kysely";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import type { EnvRow } from "./policy.js";

/** Full studio row the housekeeping resolvers/service need to act on a host. */
export type StudioRow = EnvRow & { envId: string };

/**
 * Extract the studio subdomain from a request host. Studios are served at their
 * apex (`<subdomain>.vetra.io`), so the subdomain is the leading DNS label.
 * Strips any port and lowercases.
 */
export function hostToSubdomain(host: string): string | null {
  if (!host) return null;
  const h = host.toLowerCase().split(":")[0].trim();
  const label = h.split(".")[0];
  return label || null;
}

/**
 * Look up the environment read-model row for a studio host. Returns null when
 * no environment matches (unknown host, or a non-apex host we don't manage).
 */
export async function findStudioByHost(
  db: Kysely<DB>,
  host: string,
): Promise<StudioRow | null> {
  const subdomain = hostToSubdomain(host);
  if (!subdomain) return null;
  const row = await db
    .selectFrom("environments")
    .select(["id", "subdomain", "status", "owner", "poolState", "tenantId"])
    .where("subdomain", "=", subdomain)
    .executeTakeFirst();
  if (!row) return null;
  return {
    envId: row.id,
    subdomain: row.subdomain,
    status: row.status,
    owner: row.owner,
    poolState: row.poolState,
    tenantId: row.tenantId,
  };
}

/**
 * All claimed studios currently READY — the sleep candidates the in-process
 * keeper evaluates (pre-eligibility; `isEligibleForSleep` filters further).
 */
export async function listReadyStudios(db: Kysely<DB>): Promise<StudioRow[]> {
  const rows = await db
    .selectFrom("environments")
    .select(["id", "subdomain", "status", "owner", "poolState", "tenantId"])
    .where("status", "=", "READY")
    .where("owner", "is not", null)
    .execute();
  return rows.map((row) => ({
    envId: row.id,
    subdomain: row.subdomain,
    status: row.status,
    owner: row.owner,
    poolState: row.poolState,
    tenantId: row.tenantId,
  }));
}
