import { REACTOR_SCHEMA, type IReactorClient } from "@powerhousedao/reactor";
import type { Kysely } from "kysely";

/** The reactor-client calls the existence check needs. */
export type EnvExistenceClient = Pick<IReactorClient, "isDocumentIdTaken" | "get">;

export interface EnvExistenceOptions {
  /**
   * Positive evidence of a deletion, from the reactor's own storage. Every
   * delete in this repo is a soft delete (DELETE_DOCUMENT appended, stream
   * kept), and with REACTOR_DOCUMENT_DECISIONS off `get()` hides a deleted
   * document behind the same "not found" as a missing snapshot — so without
   * this, a deleted env is indistinguishable from a snapshot gap. A throw
   * (query error, other database, abort) keeps the record.
   */
  isMarkedDeleted?: (documentId: string, signal?: AbortSignal) => Promise<boolean>;
}

/**
 * Whether an environment document still exists, for the pull worker's
 * dead-env cleanup. `false` only when the reactor says the document is gone
 * for certain; anything uncertain keeps the record.
 *
 * - Positive evidence of a deletion (`opts.isMarkedDeleted`) → `false`.
 * - No operation stream (`isDocumentIdTaken`, answered from the operation
 *   store, not from snapshots) → `false`.
 * - A stream whose document is deleted (`DocumentDeletedError`, or a returned
 *   document with `state.document.isDeleted`) → `false`.
 * - A stream with a readable live document → `true`.
 * - A stream whose snapshot can't be read ("Document not found": rebuild, lag,
 *   migration) or any other `get` error → `true`: ambiguous, keep.
 * - The deletion query or the stream lookup failing → throws (the caller
 *   keeps the record).
 */
export async function environmentDocumentExists(
  client: EnvExistenceClient,
  documentId: string,
  signal?: AbortSignal,
  opts: EnvExistenceOptions = {},
): Promise<boolean> {
  if (opts.isMarkedDeleted && (await opts.isMarkedDeleted(documentId, signal))) {
    return false;
  }
  if (!(await client.isDocumentIdTaken(documentId, signal))) return false;
  try {
    const doc: { state?: { document?: { isDeleted?: unknown } } } =
      await client.get(documentId, undefined, signal);
    return doc.state?.document?.isDeleted !== true;
  } catch (err) {
    if (err instanceof Error && err.name === "DocumentDeletedError") return false;
    return true;
  }
}

/**
 * Whether the reactor's DocumentSnapshot read model marks `documentId` as
 * deleted. The indexer sets `isDeleted = true` only for an accepted (not
 * denied) DELETE_DOCUMENT, so a row is positive evidence; no row is not
 * evidence of anything. `db` must reach the reactor's own database (the
 * `reactor` schema); otherwise the query throws and the caller keeps the record.
 */
export async function reactorSnapshotMarkedDeleted(
  db: Kysely<any>,
  documentId: string,
): Promise<boolean> {
  const row: unknown = await db
    .withSchema(REACTOR_SCHEMA)
    .selectFrom("DocumentSnapshot")
    .select("documentId")
    .where("documentId", "=", documentId)
    .where("isDeleted", "=", true)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
