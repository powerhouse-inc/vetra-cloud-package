import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { SecretsDB } from "./db/schema.js";
import { MANAGED_SECRET_KEYS, purgeTenantRows } from "./services/secrets-service.js";
import { rowTenantId } from "../../processors/vetra-cloud-environment/cleanup.js";
import type { DB as EnvProjection } from "../../processors/vetra-cloud-environment/schema.js";

export { purgeTenantRows };

/** Absolute cap on tenants one sweep may purge, whatever the fraction. */
export const MAX_ORPHAN_TENANTS = 25;

export interface OrphanPurgeArgs {
  /** The vetra-cloud-secrets namespace (tenant_env_vars, tenant_secrets, tenant_orphan_purges). */
  secretsDb: Kysely<SecretsDB>;
  /** The vetra-cloud-environments namespace (the processor's projection). */
  envDb: Kysely<EnvProjection>;
  /**
   * The token a dry run printed (`<count>:<hash of the orphan set>`). Only an
   * exact match purges: the operator confirms that very set, and a set that
   * changed since (e.g. a projection still replaying) purges nothing.
   */
  confirm?: string;
  /** Refuse when more than this fraction of the stored tenants would go (default 0.5). */
  maxPurgeFraction?: number;
  /** Refuse when more than this many tenants would go (default MAX_ORPHAN_TENANTS). */
  maxTenants?: number;
}

export type OrphanPurgeOutcome =
  | "ALREADY_DONE"
  | "NONE"
  | "SKIPPED_SAFETY"
  | "DRY_RUN"
  | "TOKEN_MISMATCH"
  | "PURGED";

export interface OrphanPurgeResult {
  outcome: OrphanPurgeOutcome;
  orphans: string[];
  token: string;
}

/** `<count>:<first 16 hex of sha256 over the sorted orphan ids>`. */
export function orphanToken(orphans: string[]): string {
  const sorted = [...orphans].sort();
  const hash = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
  return `${sorted.length}:${hash}`;
}

/**
 * SECRETS_ORPHAN_PURGE: unset/empty → dry run (logs the orphans and the
 * token); "false"/"off" → no sweep; anything else is the confirmation token
 * (an old "true" therefore purges nothing).
 */
export function orphanPurgeMode(
  value: string | undefined,
): { mode: "dry-run" } | { mode: "off" } | { mode: "confirm"; token: string } {
  const v = (value ?? "").trim();
  if (v === "") return { mode: "dry-run" };
  if (["false", "off"].includes(v.toLowerCase())) return { mode: "off" };
  return { mode: "confirm", token: v };
}

/**
 * One-shot sweep for env vars and secrets left behind by deleted
 * environments: tenants whose tenantId no environment row is deployed as.
 * Managed keys (the workflows master key) are never counted or purged.
 *
 * Runs at most once per database: a completed purge is recorded in
 * tenant_orphan_purges and every later call is ALREADY_DONE. It purges only
 * when `confirm` equals the token of the current orphan set (printed by a
 * dry run), and never when the projection knows no environment, more than
 * `maxPurgeFraction` of the tenants or more than `maxTenants` tenants would
 * go. An unreadable projection throws (nothing purged). The tenants are read
 * before the live set, so a tenant created meanwhile is never an orphan.
 * Query builder only: every statement stays in the schema-bound namespaces.
 */
export async function purgeOrphanTenantRows(args: OrphanPurgeArgs): Promise<OrphanPurgeResult> {
  const { secretsDb, envDb } = args;
  const done = await secretsDb.selectFrom("tenant_orphan_purges").select("token").executeTakeFirst();
  if (done) return { outcome: "ALREADY_DONE", orphans: [], token: done.token };

  const managed = [...MANAGED_SECRET_KEYS];
  const stored = new Set<string>();
  for (const r of await secretsDb.selectFrom("tenant_env_vars").select("tenantId").distinct().execute()) {
    stored.add(r.tenantId);
  }
  for (const r of await secretsDb
    .selectFrom("tenant_secrets")
    .select("tenantId")
    .where("key", "not in", managed)
    .distinct()
    .execute()) {
    stored.add(r.tenantId);
  }

  const envRows = await envDb.selectFrom("environments").select(["id", "tenantId", "subdomain"]).execute();
  const live = new Set<string>();
  for (const row of envRows) {
    const t = rowTenantId(row);
    if (t) live.add(t);
  }

  const orphans = [...stored].filter((t) => !live.has(t)).sort();
  const token = orphanToken(orphans);
  if (orphans.length === 0) return { outcome: "NONE", orphans, token };
  const cap = args.maxPurgeFraction ?? 0.5;
  const maxTenants = args.maxTenants ?? MAX_ORPHAN_TENANTS;
  if (live.size === 0 || orphans.length / stored.size > cap || orphans.length > maxTenants) {
    return { outcome: "SKIPPED_SAFETY", orphans, token };
  }
  if (args.confirm === undefined) return { outcome: "DRY_RUN", orphans, token };
  if (args.confirm !== token) return { outcome: "TOKEN_MISMATCH", orphans, token };

  for (const tenantId of orphans) await purgeTenantRows(secretsDb, tenantId);
  await secretsDb
    .insertInto("tenant_orphan_purges")
    .values({ token, tenants: orphans.length, purgedAt: new Date().toISOString() })
    .execute();
  return { outcome: "PURGED", orphans, token };
}
