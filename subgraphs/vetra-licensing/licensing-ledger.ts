import { createHash } from "node:crypto";
import type { Action } from "document-model";
import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";
import type { DocGateway } from "./doc-gateway.js";
import { globalState } from "./doc-parse.js";

/**
 * The licensing-state ledger.
 *
 * Operations do not record their origin reliably (the server's reactor client
 * signs unsigned user actions with the server key), and a parent relationship
 * can be added, used to write a protected app document, and removed again. So
 * the system records what it wrote: a hash of the app document's templates and
 * terms after every system write to them. At read time a differing hash means
 * the licensing state was changed outside Vetra, and the app is held.
 */

/** JSON with object keys sorted at every depth; arrays keep their order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** sha256 over the canonical JSON of the document's raw templates and terms. */
export function licensingStateHash(templates: unknown, terms: unknown): string {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return createHash("sha256")
    .update(canonical({ templates: list(templates), terms: list(terms) }))
    .digest("hex");
}

/** The raw templates and terms of an app document's global state. */
export function licensingStateOf(doc: unknown): { templates: unknown; terms: unknown } {
  const g = globalState(doc);
  return { templates: g?.templates, terms: g?.terms };
}

export async function recordLicensingState(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  templates: unknown,
  terms: unknown,
  now: string,
): Promise<void> {
  const state_hash = licensingStateHash(templates, terms);
  await db
    .insertInto("app_licensing_state")
    .values({ app_id: appId, state_hash, updated_at: now })
    .onConflict((oc) => oc.column("app_id").doUpdateSet({ state_hash, updated_at: now }))
    .execute();
}

/** The recorded hash, or null when the app has never been recorded. */
export function createLedgerLookup(
  db: Kysely<VetraLicensingDB>,
): (appId: string) => Promise<string | null> {
  return async (appId) =>
    (
      await db
        .selectFrom("app_licensing_state")
        .select("state_hash")
        .where("app_id", "=", appId)
        .executeTakeFirst()
    )?.state_hash ?? null;
}

export interface AppLicensingWriter {
  /**
   * The ONLY way the system changes an app document's templates or terms:
   * executes the actions, re-reads the document and records the resulting
   * licensing state. Records even when an action was rejected (an earlier
   * action of the batch may have applied), then rethrows.
   */
  appendLicensingOps(appId: string, actions: Action[]): Promise<void>;
}

export function createAppLicensingWriter(deps: {
  /** A vetra-app DocGateway (it protects what it creates). */
  docs: Pick<DocGateway, "execute">;
  get(id: string): Promise<unknown>;
  db: Kysely<VetraLicensingDB>;
  now: () => string;
}): AppLicensingWriter {
  return {
    async appendLicensingOps(appId, actions) {
      let failure: Error | null = null;
      try {
        await deps.docs.execute(appId, actions);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
      try {
        const { templates, terms } = licensingStateOf(await deps.get(appId));
        await recordLicensingState(deps.db, appId, templates, terms, deps.now());
      } catch (err) {
        // The original failure (e.g. a missing document) is the one to report.
        if (failure === null) throw err;
      }
      if (failure !== null) throw failure;
    },
  };
}
