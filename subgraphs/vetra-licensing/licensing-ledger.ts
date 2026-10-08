import { createHash } from "node:crypto";
import type { Action } from "document-model";
import type { Kysely } from "kysely";
import { isDocumentNotFound } from "../vetra-apps/envs.js";
import type { VetraLicensingDB } from "./db/schema.js";
import type { DocGateway } from "./doc-gateway.js";
import { globalState } from "./doc-parse.js";

/**
 * The app-state ledger (table `app_licensing_state`, namespace
 * "vetra-licensing").
 *
 * Operations do not record their origin reliably (the server's reactor client
 * signs unsigned user actions with the server key), and a parent relationship
 * can be added, used to write a protected app document, and removed again. So
 * the system records what it wrote: a hash of every part of the app document
 * that decides what the keeper provisions, after every system write. At read
 * time a differing hash means the document was changed outside Vetra, and the
 * app is held.
 *
 * Scope of the hash: `templates`, `terms` and `artifacts` (artifact versions and
 * channel pointers decide which FUSION image a DEDICATED template runs).
 *
 * Writers: vetra-licensing (publisher mutations, migration) through
 * `createAppLicensingWriter`, and vetra-apps (backfill, row mirror, CI artifact
 * registration) through its app document store (app-doc-store.ts), which opens
 * the "vetra-licensing" namespace for this one table. Both go through
 * `appendAppOps`. Any other system write to those fields makes the app read as
 * tampered: the safe direction.
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

/** The ledger-covered parts of an app document's global state. */
export interface LedgerState {
  templates?: unknown;
  terms?: unknown;
  artifacts?: unknown;
}

/**
 * sha256 over the canonical JSON of the global state's raw `templates`, `terms`
 * and `artifacts`. A missing list hashes as `[]`, so a document from before a
 * module existed hashes like an empty one. Other fields (name, repository,
 * status...) are not covered: the row is their source of truth.
 */
export function licensingStateHash(state: LedgerState | null | undefined): string {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  return createHash("sha256")
    .update(
      canonical({
        templates: list(state?.templates),
        terms: list(state?.terms),
        artifacts: list(state?.artifacts),
      }),
    )
    .digest("hex");
}

/** The ledger-covered state of an app document. */
export function licensingStateOf(doc: unknown): LedgerState {
  const g = globalState(doc);
  return { templates: g?.templates, terms: g?.terms, artifacts: g?.artifacts };
}

/** The table, for subgraphs that reach the namespace without running its migrations. */
export async function ensureAppLicensingStateTable(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("app_licensing_state")
    .addColumn("app_id", "text", (c) => c.notNull())
    .addColumn("state_hash", "text", (c) => c.notNull())
    .addColumn("updated_at", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_licensing_state_pkey", ["app_id"])
    .ifNotExists()
    .execute();
}

export async function recordLicensingState(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  state: LedgerState | null,
  now: string,
): Promise<void> {
  const state_hash = licensingStateHash(state);
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

export interface AppStateLedger {
  lookup(appId: string): Promise<string | null>;
  record(appId: string, state: LedgerState | null): Promise<void>;
}

export function createAppStateLedger(
  db: Kysely<VetraLicensingDB>,
  now: () => string,
): AppStateLedger {
  const lookup = createLedgerLookup(db);
  return {
    lookup,
    record: (appId, state) => recordLicensingState(db, appId, state, now()),
  };
}

export interface AppendAppOpsDeps {
  execute(appId: string, actions: Action[]): Promise<unknown>;
  /** The document's global state, or null when it does not exist. */
  getState(appId: string): Promise<LedgerState | null>;
  ledger: AppStateLedger;
  logger: Pick<Console, "error">;
}

/**
 * The one way the system writes an app document: executes the actions,
 * re-reads the document and records the resulting ledger state.
 *
 * - The state is checked BEFORE the write. If it no longer matches the
 *   recorded hash it was changed outside Vetra: the write is still applied
 *   (a CI artifact must not be lost) but NOT recorded, so the app stays held
 *   instead of the system laundering the foreign change.
 * - A document with no row is recorded only with `seedUnrecorded` (the
 *   licensing migration seeds; vetra-apps records the documents it creates,
 *   see app-doc-store.ts, and leaves older unrecorded ones unverified).
 * - Records even when an action was rejected (an earlier action of the batch
 *   may have applied), then rethrows. A missing document records nothing.
 */
export async function appendAppOps(
  deps: AppendAppOpsDeps,
  appId: string,
  actions: Action[],
  opts: { seedUnrecorded: boolean },
): Promise<void> {
  const before = await deps.getState(appId);
  let record = false;
  if (before !== null) {
    const recorded = await deps.ledger.lookup(appId);
    if (recorded === null) {
      record = opts.seedUnrecorded;
    } else if (recorded === licensingStateHash(before)) {
      record = true;
    } else {
      deps.logger.error(
        `[licensing] app document ${appId} changed outside Vetra before this system write; applying it without recording, the app stays held`,
      );
    }
  }

  let failure: Error | null = null;
  try {
    await deps.execute(appId, actions);
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  }
  if (record) {
    try {
      const after = await deps.getState(appId);
      if (after !== null) await deps.ledger.record(appId, after);
    } catch (err) {
      if (failure === null) throw err;
    }
  }
  if (failure !== null) throw failure;
}

export interface AppLicensingWriter {
  /**
   * The ONLY way vetra-licensing changes an app document's templates or terms
   * (appendAppOps, seeding an unrecorded document).
   */
  appendLicensingOps(appId: string, actions: Action[]): Promise<void>;
}

export function createAppLicensingWriter(deps: {
  /** A vetra-app DocGateway (it protects what it creates). */
  docs: Pick<DocGateway, "execute">;
  get(id: string): Promise<unknown>;
  db: Kysely<VetraLicensingDB>;
  now: () => string;
  logger?: Pick<Console, "error">;
}): AppLicensingWriter {
  const ledger = createAppStateLedger(deps.db, deps.now);
  const getState = async (id: string): Promise<LedgerState | null> => {
    try {
      return licensingStateOf(await deps.get(id));
    } catch (err) {
      if (isDocumentNotFound(err)) return null;
      throw err;
    }
  };
  return {
    appendLicensingOps: (appId, actions) =>
      appendAppOps(
        {
          execute: (id, a) => deps.docs.execute(id, a),
          getState,
          ledger,
          logger: deps.logger ?? console,
        },
        appId,
        actions,
        { seedUnrecorded: true },
      ),
  };
}
