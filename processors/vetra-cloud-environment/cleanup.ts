import type { Kysely } from "kysely";
import type { DB } from "./schema.js";
import { getTenantId } from "./gitops.js";

export interface RemoveEnvironmentOptions {
  /**
   * Delete the tenant's env vars and secrets (vetra-cloud-secrets
   * `SecretsService.purgeTenant`). Called only when no other environment is
   * still deployed as the same tenantId. Omitted when no secrets store is
   * wired (OPENBAO_ADDR unset). A failure is logged, never thrown: the row
   * still goes, and the secrets subgraph's startup orphan sweep
   * (tenant-purge.ts) removes what was left.
   */
  purgeTenant?: ((tenantId: string) => Promise<unknown>) | null;
}

/** The tenant id a read-model row is deployed as (stored, or derived for legacy rows). */
export function rowTenantId(row: {
  id: string;
  tenantId: string | null;
  subdomain: string | null;
}): string | null {
  if (row.tenantId) return row.tenantId;
  return row.subdomain ? getTenantId(row.subdomain, row.id) : null;
}

/**
 * Remove an environment's read-model row by document id.
 *
 * Shared between the processor's DELETE_NODE drive-operation path and the
 * subgraph's `onDocumentDeleted` subscription (which fires for
 * `deleteDocument(identifier)` calls that never emit a DELETE_NODE the
 * processor sees). Both paths must clean up the same row so the UI never shows
 * a "phantom studio" whose backing document is gone.
 *
 * When the environment was the last one deployed as its tenantId, the
 * tenant's env vars and secrets are purged too (`opts.purgeTenant`): left
 * behind, a later environment that lands on the same tenantId (same
 * subdomain + same 8-character id prefix) would read the old env vars and
 * have the old secrets mounted into its namespace.
 *
 * Returns `{ subdomain, name }` so the caller can derive the gitops tenant id
 * and tear down the tenant directory, or `null` (a safe no-op) when no row
 * exists for the id — the common case for a non-environment document id.
 */
export async function removeEnvironmentRecord(
  db: Kysely<DB>,
  documentId: string,
  opts: RemoveEnvironmentOptions = {},
): Promise<{ subdomain: string | null; name: string | null } | null> {
  const environment = await db
    .selectFrom("environments")
    .select(["id", "name", "subdomain", "tenantId"])
    .where("id", "=", documentId)
    .executeTakeFirst();

  if (!environment) return null;

  await db.deleteFrom("environments").where("id", "=", documentId).execute();

  const tenantId = rowTenantId(environment);
  if (tenantId && opts.purgeTenant && !(await tenantIdOwner(db, tenantId, documentId))) {
    try {
      await opts.purgeTenant(tenantId);
    } catch (err) {
      console.error(
        `[environments] failed to purge env vars/secrets of deleted tenant ${tenantId}: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  return { subdomain: environment.subdomain, name: environment.name };
}

/**
 * The id of another environment already deployed as `tenantId`, or null.
 * The tenantId is `<subdomain>-<first 8 id chars>` and document ids can be
 * chosen client-side, so two documents can map to one tenant: the second one
 * must not take over the first one's namespace, gitops dir, env vars or
 * secrets.
 */
export async function tenantIdOwner(
  db: Kysely<DB>,
  tenantId: string,
  documentId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("environments")
    .select("id")
    .where("tenantId", "=", tenantId)
    .where("id", "!=", documentId)
    .executeTakeFirst();
  return row?.id ?? null;
}
