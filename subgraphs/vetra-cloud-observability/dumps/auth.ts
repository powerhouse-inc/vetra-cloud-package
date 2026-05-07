/**
 * Owner-only auth predicate for the dumps surface.
 *
 * Stricter than the rest of the observability subgraph (where logs/pods
 * etc. trust tenantId). A dump file IS the database — anyone holding the
 * presigned URL can download every row, so we enforce ownership on
 * every mutation and every list call. The presigned URL is minted at
 * read time, not stored, so a leaked URL has at most 15-min authority.
 */
export type RequireOwnerInput = {
  caller: string | null | undefined;
  envOwner: string | null | undefined;
};

export function requireOwner({ caller, envOwner }: RequireOwnerInput): void {
  if (!caller) throw new Error("UNAUTHENTICATED");
  if (!envOwner) throw new Error("ENV_NOT_FOUND");
  if (caller.toLowerCase() !== envOwner.toLowerCase()) {
    throw new Error("FORBIDDEN");
  }
}
