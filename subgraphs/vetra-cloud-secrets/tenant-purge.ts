import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import { purgeTenantRows } from "./services/secrets-service.js";
import { rowTenantId } from "../../processors/vetra-cloud-environment/cleanup.js";
import type { DB as EnvProjection } from "../../processors/vetra-cloud-environment/schema.js";

export { purgeTenantRows };

export interface OrphanPurgeArgs {
  /** The vetra-cloud-secrets namespace (tenant_env_vars, tenant_secrets). */
  secretsDb: Kysely<SecretsDB>;
  /** The vetra-cloud-environments namespace (the processor's projection). */
  envDb: Kysely<EnvProjection>;
  /**
   * Circuit breaker: when more than this fraction of the stored tenants would
   * be purged, purge nothing (a half-projected or wrong projection must not
   * wipe the fleet's configuration). Default 0.5.
   */
  maxPurgeFraction?: number;
  /** Report what would be purged without deleting anything. */
  dryRun?: boolean;
}

/**
 * SECRETS_ORPHAN_PURGE: "true" purges, "false" skips the sweep, anything else
 * (the default) is a dry run that only logs the orphans. A projection that is
 * being rebuilt (partially replayed) would make live tenants look orphaned, so
 * deleting is an explicit operator decision.
 */
export function orphanPurgeMode(value: string | undefined): "purge" | "dry-run" | "off" {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "true") return "purge";
  if (v === "false") return "off";
  return "dry-run";
}

/**
 * One-off, idempotent sweep for env vars and secrets left behind by
 * environments deleted before deletion purged them (and any purge that failed
 * since): rows whose tenantId no environment row is deployed as.
 *
 * Fail-safe: purges nothing when the projection knows no environment, when
 * more than `maxPurgeFraction` of the tenants would go, and throws (purging
 * nothing) when the projection is unreadable. The tenants are read before the
 * live set, so a tenant created during the sweep is never in the purge list.
 * Every statement goes through the schema-bound instances (no raw SQL).
 */
export async function purgeOrphanTenantRows(
  args: OrphanPurgeArgs,
): Promise<{ purged: string[]; skippedForSafety: boolean }> {
  const { secretsDb, envDb } = args;
  const stored = new Set<string>();
  for (const table of ["tenant_env_vars", "tenant_secrets"] as const) {
    const rows = await secretsDb.selectFrom(table).select("tenantId").distinct().execute();
    for (const r of rows) stored.add(r.tenantId);
  }

  const envRows = await envDb
    .selectFrom("environments")
    .select(["id", "tenantId", "subdomain"])
    .execute();
  const live = new Set<string>();
  for (const row of envRows) {
    const t = rowTenantId(row);
    if (t) live.add(t);
  }
  if (live.size === 0) return { purged: [], skippedForSafety: stored.size > 0 };

  const orphans = [...stored].filter((t) => !live.has(t)).sort();
  const cap = args.maxPurgeFraction ?? 0.5;
  if (orphans.length > 0 && orphans.length / stored.size > cap) {
    return { purged: [], skippedForSafety: true };
  }
  if (args.dryRun) return { purged: orphans, skippedForSafety: false };
  for (const tenantId of orphans) await purgeTenantRows(secretsDb, tenantId);
  return { purged: orphans, skippedForSafety: false };
}
