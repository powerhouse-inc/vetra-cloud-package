/**
 * The vetra-studio app exists only as a document (no `apps` row). Its id is
 * FIXED here so that the one place that creates it (Task 16) and every place
 * that trusts it agree. Reactor ids are UUIDv4 (generateId), as are app ids
 * (randomUUID), so this is a constant UUIDv4.
 *
 * Ownership of this app is never read from its document: anyone signed in can
 * write an unprotected document. It comes from configuration.
 */
export const STUDIO_APP_ID = "5f0e7a1c-3b2d-4c8e-9a6f-0d1e2f3a4b5c";

/**
 * The publisher of the studio app: VETRA_STUDIO_PUBLISHER_ADDRESS, else the
 * first ADMINS entry; lowercased. null when neither is set.
 */
export function studioPublisherAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.VETRA_STUDIO_PUBLISHER_ADDRESS?.trim();
  if (explicit) return explicit.toLowerCase();
  const first = (env.ADMINS ?? "")
    .split(",")
    .map((a) => a.trim())
    .find(Boolean);
  return first ? first.toLowerCase() : null;
}
