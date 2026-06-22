import type { Kysely } from "kysely";
import type { DB } from "./schema.js";

/**
 * Remove an environment's read-model row by document id.
 *
 * Shared between the processor's DELETE_NODE drive-operation path and the
 * subgraph's `onDocumentDeleted` subscription (which fires for
 * `deleteDocument(identifier)` calls that never emit a DELETE_NODE the
 * processor sees). Both paths must clean up the same row so the UI never shows
 * a "phantom studio" whose backing document is gone.
 *
 * Selects (id, name, subdomain), deletes the row, and returns
 * `{ subdomain, name }` so the caller can derive the gitops tenant id and tear
 * down the tenant directory. Returns `null` (a safe no-op) when no row exists
 * for the id — which is the common case when this is invoked for a
 * non-environment document id.
 */
export async function removeEnvironmentRecord(
  db: Kysely<DB>,
  documentId: string,
): Promise<{ subdomain: string | null; name: string | null } | null> {
  const environment = await db
    .selectFrom("environments")
    .select(["id", "name", "subdomain"])
    .where("id", "=", documentId)
    .executeTakeFirst();

  if (!environment) return null;

  await db.deleteFrom("environments").where("id", "=", documentId).execute();

  return { subdomain: environment.subdomain, name: environment.name };
}
