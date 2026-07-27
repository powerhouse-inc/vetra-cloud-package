import type { Kysely } from "kysely";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import type { EnvRow } from "./policy.js";

/** Full studio row the housekeeping resolvers/service need to act on a host. */
export type StudioRow = EnvRow & { envId: string };

/**
 * Service host prefixes/suffixes the gitops renders (see resolveGenericHost).
 * A CLINT studio is served at its apex (`<sub>.vetra.io`); other services are
 * `<sub>-<prefix>.vetra.io` (flat) or, on legacy envs, `<prefix>.<sub>.vetra.io`.
 */
const SERVICE_TOKENS = ["connect", "switchboard", "vetra-agent"] as const;

/**
 * Extract the studio/env subdomain from a request host, so the wake activator
 * can wake an env when ANY of its service hosts is accessed (not just the CLINT
 * apex). Handles: apex `<sub>.vetra.io`, flat `<sub>-<prefix>.vetra.io`, and
 * legacy subdomain-style `<prefix>.<sub>.vetra.io`. Strips port and lowercases.
 */
export function hostToSubdomain(host: string): string | null {
  if (!host) return null;
  const h = host.toLowerCase().split(":")[0].trim();
  const parts = h.split(".");
  const first = parts[0];
  if (!first) return null;
  // Legacy subdomain-style: <prefix>.<sub>.vetra.io — the service prefix is its
  // own leading label; the subdomain is the next label.
  if (parts.length >= 3 && (SERVICE_TOKENS as readonly string[]).includes(first)) {
    return parts[1] || null;
  }
  // Flat: <sub>-<prefix>.vetra.io — strip the exact trailing service token.
  for (const t of SERVICE_TOKENS) {
    if (first.endsWith(`-${t}`)) return first.slice(0, -(t.length + 1)) || null;
  }
  // Apex / anything else: the leading label is the subdomain.
  return first;
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
    .select(["id", "subdomain", "status", "owner", "poolState", "tenantId", "services"])
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
    services: row.services,
  };
}

/**
 * All claimed studios currently READY — the sleep candidates the in-process
 * keeper evaluates (pre-eligibility; `isEligibleForSleep` filters further).
 */
export async function listReadyStudios(db: Kysely<DB>): Promise<StudioRow[]> {
  const rows = await db
    .selectFrom("environments")
    .select(["id", "subdomain", "status", "owner", "poolState", "tenantId", "services"])
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
    services: row.services,
  }));
}
