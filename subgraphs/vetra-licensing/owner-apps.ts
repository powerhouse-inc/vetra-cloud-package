import type { AppReads } from "./app-reads.js";
import type { OwnerAppRecord, PublisherAuthDeps } from "./publisher-auth.js";

/**
 * Ownership for the publisher surface. The apps table still wins for every app
 * that has a row (apps-as-documents step 2 has not moved reads yet). An app
 * that exists only as a document — the vetra-studio app — falls back to the
 * document. A document without an owner resolves with an empty owner, which
 * resolveOwnerApp can never match: unowned must not read as yours.
 */
export function createOwnerAppLookup(deps: {
  table: {
    byId(id: string): Promise<OwnerAppRecord | null>;
    byOwner(address: string): Promise<OwnerAppRecord[]>;
  };
  apps: Pick<AppReads, "app" | "appsOwnedBy">;
  logger?: Pick<Console, "warn">;
}): PublisherAuthDeps {
  const fromDoc = (d: { id: string; name: string | null; slug: string | null; status: string; owner: string | null }): OwnerAppRecord => ({
    id: d.id,
    name: d.name ?? d.slug ?? d.id,
    status: d.status,
    owner_address: d.owner?.toLowerCase() ?? "",
  });
  return {
    async findAppById(id) {
      const row = await deps.table.byId(id);
      if (row) return row;
      const doc = await deps.apps.app(id);
      return doc ? fromDoc(doc) : null;
    },
    async listAppsForOwner(address) {
      const rows = await deps.table.byOwner(address);
      const seen = new Set(rows.map((r) => r.id));
      let owned: Awaited<ReturnType<AppReads["appsOwnedBy"]>>;
      try {
        owned = await deps.apps.appsOwnedBy(address);
      } catch (err) {
        // The table rows are still the truth for every app that has one: a
        // reactor hiccup must not blank the publisher's own app list.
        (deps.logger ?? console).warn(
          `[licensing] app document scan for ${address} failed; listing table rows only: ${err instanceof Error ? err.message : String(err)}`,
        );
        owned = [];
      }
      const docs = owned.filter((d) => !seen.has(d.id));
      // A document whose row exists but names another owner is not listed:
      // the row is the truth for that app.
      const docOnly: OwnerAppRecord[] = [];
      for (const d of docs) {
        if (!(await deps.table.byId(d.id))) docOnly.push(fromDoc(d));
      }
      return [...rows, ...docOnly];
    },
  };
}
