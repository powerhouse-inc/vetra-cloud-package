import type { IReactorClient } from "@powerhousedao/reactor";

/** The reactor-client calls the existence check needs. */
export type EnvExistenceClient = Pick<IReactorClient, "isDocumentIdTaken" | "get">;

/**
 * Whether an environment document still exists, for the pull worker's
 * dead-env cleanup. `false` only when the reactor says the document is gone
 * for certain; anything uncertain keeps the record.
 *
 * - No operation stream (`isDocumentIdTaken`, answered from the operation
 *   store, not from snapshots) → `false`: the document never existed here or
 *   is gone entirely.
 * - A stream whose document is deleted (`DocumentDeletedError`, or a returned
 *   document with `state.document.isDeleted`) → `false`.
 * - A stream with a readable live document → `true`.
 * - A stream whose snapshot is missing ("Document not found" from the
 *   DocumentSnapshot read model: rebuild, lag, migration — or a soft-deleted
 *   document the view hides) → `true`: ambiguous, keep.
 * - Any failure of the stream lookup → throws (the caller keeps the record).
 */
export async function environmentDocumentExists(
  client: EnvExistenceClient,
  documentId: string,
  signal?: AbortSignal,
): Promise<boolean> {
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
