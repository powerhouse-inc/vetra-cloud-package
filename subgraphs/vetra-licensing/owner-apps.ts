import type { AppReads } from "./app-reads.js";
import type { OwnerAppRecord, PublisherAuthDeps } from "./publisher-auth.js";
import { STUDIO_APP_ID } from "./studio-app.js";

/**
 * Ownership for the publisher surface. Ownership is NEVER read from document
 * state: with document permissions on, any signed-in user can create or write
 * an unprotected vetra-app document, so a document claiming an owner proves
 * nothing.
 *
 * - An app with an `apps` row: the row, unchanged.
 * - The studio app (STUDIO_APP_ID, document-only): owned by the configured
 *   studio publisher, ACTIVE, once its document exists.
 * - Any other document-only id: unknown.
 */
export function createOwnerAppLookup(deps: {
  table: {
    byId(id: string): Promise<OwnerAppRecord | null>;
    byOwner(address: string): Promise<OwnerAppRecord[]>;
  };
  apps: Pick<AppReads, "app">;
  /** Lowercased; null when unconfigured, which leaves the studio app unknown. */
  studioPublisher: string | null;
  logger?: Pick<Console, "warn">;
}): PublisherAuthDeps {
  async function studioApp(): Promise<OwnerAppRecord | null> {
    if (!deps.studioPublisher) return null;
    // Only the name comes from the document; a read error propagates.
    const doc = await deps.apps.app(STUDIO_APP_ID);
    if (!doc) return null;
    // Ownership never came from the document, so a tampered studio document
    // does not change who manages it; app-reads has already logged it, and
    // anything that provisions from it holds via resolveKind.
    return {
      id: STUDIO_APP_ID,
      name: doc.name ?? doc.slug ?? STUDIO_APP_ID,
      status: "ACTIVE",
      owner_address: deps.studioPublisher,
      // Only used to address its Renown profile; Renown itself checks that the
      // caller's wallet owns this identity.
      ...(doc.identityDid ? { identity_did: doc.identityDid } : {}),
    };
  }

  return {
    async findAppById(id) {
      const row = await deps.table.byId(id);
      if (row) return row;
      return id === STUDIO_APP_ID ? studioApp() : null;
    },
    async listAppsForOwner(address) {
      const rows = await deps.table.byOwner(address);
      if (
        !deps.studioPublisher ||
        address.toLowerCase() !== deps.studioPublisher ||
        rows.some((r) => r.id === STUDIO_APP_ID)
      ) {
        return rows;
      }
      try {
        const studio = await studioApp();
        return studio ? [...rows, studio] : rows;
      } catch (err) {
        // A reactor hiccup must not blank the publisher's table-backed apps.
        (deps.logger ?? console).warn(
          `[licensing] reading the studio app document failed; listing table rows only: ${err instanceof Error ? err.message : String(err)}`,
        );
        return rows;
      }
    },
  };
}
