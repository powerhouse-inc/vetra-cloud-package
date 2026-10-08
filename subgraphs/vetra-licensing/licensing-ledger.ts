import { createHash, randomUUID } from "node:crypto";
import type { Action } from "document-model";
import type { Kysely } from "kysely";
import { isDocumentNotFound } from "../vetra-apps/envs.js";
import type { VetraLicensingDB } from "./db/schema.js";
import type { DocGateway } from "./doc-gateway.js";
import { globalState } from "./doc-parse.js";
import { keyedMutex } from "./keyed-mutex.js";

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
 * the "vetra-licensing" namespace for the ledger tables. Both go through
 * `AppLedger.append` (createAppLedger). Any other system write to those fields makes the app read as
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


/** SQLSTATEs a concurrent CREATE ... IF NOT EXISTS still raises (unique_violation on the catalog, duplicate_table). */
const CONCURRENT_CREATE = new Set(["23505", "42P07"]);

async function tolerateConcurrentCreate(create: () => Promise<unknown>): Promise<void> {
  try {
    await create();
  } catch (err) {
    if (!CONCURRENT_CREATE.has((err as { code?: string } | null)?.code ?? "")) throw err;
  }
}

/**
 * The ledger tables (forward-only, idempotent), for every subgraph that writes
 * them: vetra-licensing's up() and vetra-apps on first use, since boot order is
 * not fixed and replicas may boot at the same time.
 */
export async function ensureLedgerTables(db: Kysely<any>): Promise<void> {
  await tolerateConcurrentCreate(() =>
    db.schema
      .createTable("app_licensing_state")
      .addColumn("app_id", "text", (c) => c.notNull())
      .addColumn("state_hash", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("app_licensing_state_pkey", ["app_id"])
      .ifNotExists()
      .execute(),
  );
  await tolerateConcurrentCreate(() =>
    db.schema
      .createTable("app_licensing_intent")
      .addColumn("id", "text", (c) => c.notNull())
      .addColumn("app_id", "text", (c) => c.notNull())
      .addColumn("base_hash", "text", (c) => c.notNull())
      .addColumn("base_revision", "integer", (c) => c.notNull())
      .addColumn("action_ids", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("done_at", "text")
      .addColumn("abandoned_at", "text")
      .addPrimaryKeyConstraint("app_licensing_intent_pkey", ["id"])
      .ifNotExists()
      .execute(),
  );
  await addAbandonedAt(db);
  await tolerateConcurrentCreate(() =>
    db.schema
      .createIndex("app_licensing_intent_app_id_idx")
      .ifNotExists()
      .on("app_licensing_intent")
      .column("app_id")
      .execute(),
  );
}

/** SQLSTATEs: undefined_column, duplicate_column. */
const UNDEFINED_COLUMN = "42703";
const DUPLICATE_COLUMN = "42701";

/**
 * `abandoned_at` arrived after the table (forward-only). Probe with a query
 * first: ALTER TABLE takes an ACCESS EXCLUSIVE lock even when it then fails,
 * and this runs on every boot. The probe goes through the query builder, so a
 * namespaced db reads its own schema. 42701 is swallowed for a concurrent boot.
 */
async function addAbandonedAt(db: Kysely<any>): Promise<void> {
  try {
    await db.selectFrom("app_licensing_intent").select("abandoned_at").limit(0).execute();
    return;
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== UNDEFINED_COLUMN) throw err;
  }
  try {
    await db.schema.alterTable("app_licensing_intent").addColumn("abandoned_at", "text").execute();
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== DUPLICATE_COLUMN) throw err;
  }
}

export async function recordLicensingState(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  state: LedgerState | null,
  now: string,
): Promise<void> {
  await recordHash(db, appId, licensingStateHash(state), now);
}

async function recordHash(
  db: Kysely<VetraLicensingDB>,
  appId: string,
  state_hash: string,
  now: string,
): Promise<void> {
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

/**
 * Serialises the system's writes (and heals) to one app document, from the
 * read of the state it starts from to the record of the state it left. ONE
 * mutex for the whole process, shared by every ledger instance, so
 * vetra-apps and vetra-licensing never interleave writes to the same app.
 *
 * Production runs a single switchboard replica, so an in-process lock is the
 * whole lock. A session advisory lock is deliberately not used: production
 * reaches PostgreSQL through pgbouncer in transaction mode, where session
 * locks leak across clients and can hang writes. Running several replicas
 * would need pg_advisory_xact_lock taken inside a transaction that spans the
 * read, the write and the record.
 */
const withAppLock = keyedMutex();

/** What the ledger reads from the reactor. */
export interface LedgerDoc {
  state: LedgerState | null;
  /** The global-scope revision (index of the next global operation). */
  revision: number;
}
export interface LedgerSource {
  /** Null when the document does not exist. */
  getDoc(appId: string): Promise<LedgerDoc | null>;
  /** Action ids of the global operations with index >= revision, in order (null: no id). */
  operationsSince(appId: string, revision: number): Promise<(string | null)[]>;
}

type LedgerReactorClient = {
  get(id: string): Promise<unknown>;
  getOperations(
    id: string,
    view?: { branch?: string; scopes?: string[] },
    filter?: { sinceRevision?: number },
    paging?: { cursor: string; limit: number },
  ): Promise<{ results: unknown[]; nextCursor?: string }>;
};

export function reactorLedgerSource(client: LedgerReactorClient): LedgerSource {
  return {
    async getDoc(appId) {
      let doc: unknown;
      try {
        doc = await client.get(appId);
      } catch (err) {
        if (isDocumentNotFound(err)) return null;
        throw err;
      }
      const revision = (doc as { header?: { revision?: { global?: unknown } } } | null)
        ?.header?.revision?.global;
      return {
        state: licensingStateOf(doc),
        revision: typeof revision === "number" ? revision : 0,
      };
    },
    async operationsSince(appId, revision) {
      const out: (string | null)[] = [];
      let cursor = "0";
      for (;;) {
        const page = await client.getOperations(
          appId,
          { branch: "main", scopes: ["global"] },
          { sinceRevision: revision },
          { cursor, limit: 200 },
        );
        for (const op of page.results as { action?: { id?: unknown } }[]) {
          out.push(typeof op.action?.id === "string" ? op.action.id : null);
        }
        if (!page.nextCursor || page.nextCursor === cursor) return out;
        cursor = page.nextCursor;
      }
    },
  };
}

/** Completed intents are kept this long, then pruned. */
const INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppLedger {
  /** The recorded hash, null when never recorded. */
  lookup: (appId: string) => Promise<string | null>;
  /** Records a state the system built itself (a document it just created). */
  record: (appId: string, state: LedgerState | null) => Promise<void>;
  /**
   * The one way the system writes an app document; see createAppLedger.
   * `execute` throws when the write (or an action of it) failed.
   */
  append: (
    appId: string,
    actions: Action[],
    execute: (appId: string, actions: Action[]) => Promise<unknown>,
    opts: { seedUnrecorded: boolean },
  ) => Promise<void>;
  /**
   * Records the document's current state, only when the app has no ledger
   * row yet (the startup migration seeds every trusted app so none reads as
   * unverified). True when it recorded; false for a recorded app (never
   * overwritten: that could launder a later change) or a missing document.
   */
  seed: (appId: string) => Promise<boolean>;
  /**
   * Records the document's state when it differs from the ledger only by
   * system writes journalled as intents. True when the ledger matches the
   * document afterwards.
   */
  heal: (appId: string) => Promise<boolean>;
}

type Settled =
  | { status: "clean" | "healed"; doc: LedgerDoc }
  | { status: "tampered" | "unrecorded" | "missing" };

/**
 * The app-state ledger with its intent journal (`app_licensing_intent`).
 *
 * `append`, holding the app's lock (withAppLock):
 * - Reads the state BEFORE the write. If it no longer matches the recorded
 *   hash, it tries to heal (below); if that finds the document changed outside
 *   Vetra the write is still applied (a CI artifact must not be lost) but NOT
 *   recorded, so the app stays held. If the check itself fails (the document
 *   or its operations cannot be read) nothing is executed: the error is
 *   rethrown rather than applying a write that is not journalled.
 * - A document with no row is recorded (seeded) only with `seedUnrecorded`.
 * - Journals an intent (base hash, base revision, the batch's action ids)
 *   before executing; if that insert fails nothing is executed.
 * - After the write (also after a rejection: an earlier action of the batch
 *   may have applied) settles: records the new state when every operation
 *   since the base revision is one of the journalled actions. A foreign
 *   operation interleaved with the write leaves the app held. A failure to
 *   record is logged, not thrown: the intent stays pending and the next read
 *   or write heals it.
 *
 * Healing: when the document differs from the recorded hash, the pending
 * intents based on that hash are taken; if the operations since their base
 * revision are exactly those intents' actions (each at most once), the current
 * state is recorded. System action ids are generated by the server and unknown
 * until applied, so a foreign write cannot pass as one.
 *
 * An intent is completed only once every one of its actions appears among the
 * document's operations since its base; one whose actions have not (yet)
 * applied stays pending, unless its write failed with none of them applied:
 * then it is abandoned at once (done, and marked `abandoned_at`). When
 * healing, the actions of intents completed since the oldest pending base
 * count as system writes too, but never an abandoned intent's: its actions
 * were not seen applied, so an operation carrying one of its ids (a late
 * landing, or a forger reusing it) reads as foreign. Intents abandoned
 * before `abandoned_at` existed look completed and stay allowed until pruned
 * (INTENT_RETENTION_MS after done_at).
 */
export function createAppLedger(deps: {
  db: Kysely<VetraLicensingDB>;
  source: LedgerSource;
  now: () => string;
  newId?: () => string;
  logger?: Pick<Console, "error" | "warn">;
}): AppLedger {
  const { db, source, now } = deps;
  const newId = deps.newId ?? (() => randomUUID());
  const logger = deps.logger ?? console;
  const lookup = createLedgerLookup(db);

  async function complete(ids: string[], opts: { abandoned?: boolean } = {}): Promise<void> {
    if (ids.length === 0) return;
    const at = now();
    await db
      .updateTable("app_licensing_intent")
      .set(opts.abandoned ? { done_at: at, abandoned_at: at } : { done_at: at })
      .where("id", "in", ids)
      .execute();
    const cutoff = new Date(Date.parse(at) - INTENT_RETENTION_MS).toISOString();
    await db
      .deleteFrom("app_licensing_intent")
      .where("done_at", "is not", null)
      .where("done_at", "<", cutoff)
      .execute();
  }

  async function settle(appId: string): Promise<Settled> {
    const recorded = await lookup(appId);
    if (recorded === null) return { status: "unrecorded" };
    // The document first, then its operations: an operation landing in
    // between shows up in the list and fails the check, never the reverse.
    const doc = await source.getDoc(appId);
    if (doc === null) return { status: "missing" };
    const hash = licensingStateHash(doc.state);
    const rows = await db
      .selectFrom("app_licensing_intent")
      .selectAll()
      .where("app_id", "=", appId)
      .execute();
    const parse = (i: (typeof rows)[number]) => ({
      id: i.id,
      revision: i.base_revision,
      actions: JSON.parse(i.action_ids) as string[],
    });
    const intents = rows.filter((i) => i.done_at === null && i.base_hash === recorded).map(parse);
    if (hash === recorded && intents.length === 0) return { status: "clean", doc };
    const since = Math.min(...intents.map((i) => i.revision));
    const ops = intents.length === 0 ? [] : await source.operationsSince(appId, since);
    if (hash !== recorded) {
      if (intents.length === 0) return { status: "tampered" };
      // Also the actions of system writes completed since the oldest pending
      // base: a write that left the hash unchanged is recorded as done without
      // moving the hash, yet its operations sit in this range.
      const completed = rows
        .filter((i) => i.done_at !== null && i.abandoned_at === null && i.base_revision >= since)
        .map(parse);
      const allowed = new Set([...intents, ...completed].flatMap((i) => i.actions));
      const seen = new Set<string>();
      for (const id of ops) {
        if (id === null || !allowed.has(id) || seen.has(id)) return { status: "tampered" };
        seen.add(id);
      }
      if (seen.size === 0) return { status: "tampered" };
      await recordHash(db, appId, hash, now());
    }
    const applied = new Set(ops);
    await complete(intents.filter((i) => i.actions.every((a) => applied.has(a))).map((i) => i.id));
    return { status: hash === recorded ? "clean" : "healed", doc };
  }

  return {
    lookup,
    record: (appId, state) =>
      withAppLock(appId, () => recordHash(db, appId, licensingStateHash(state), now())),
    seed: (appId) =>
      withAppLock(appId, async () => {
        if ((await lookup(appId)) !== null) return false;
        const doc = await source.getDoc(appId);
        if (doc === null) return false;
        await recordHash(db, appId, licensingStateHash(doc.state), now());
        return true;
      }),
    heal: (appId) =>
      withAppLock(appId, async () => {
        const settled = await settle(appId);
        if (settled.status === "healed") {
          logger.warn(`[licensing] app document ${appId}: recorded system writes from the intent journal`);
        }
        return settled.status === "clean" || settled.status === "healed";
      }),
    append: (appId, actions, execute, opts) =>
      withAppLock(appId, async () => {
        let base = await source.getDoc(appId);
        if (base !== null) {
          const recorded = await lookup(appId);
          if (recorded === null) {
            if (opts.seedUnrecorded) await recordHash(db, appId, licensingStateHash(base.state), now());
            else base = null;
          } else if (recorded !== licensingStateHash(base.state)) {
            // A failure here throws: never apply a write that is not journalled.
            const settled = await settle(appId);
            base = "doc" in settled ? settled.doc : null;
            if (base === null) {
              logger.error(
                `[licensing] app document ${appId} changed outside Vetra before this system write; applying it without recording, the app stays held`,
              );
            }
          }
        }
        // base !== null: the write starts from a recorded state and is recorded.
        const intentId = newId();
        const actionIds = actions.flatMap((a) => (a.id ? [a.id] : []));
        if (base !== null) {
          await db
            .insertInto("app_licensing_intent")
            .values({
              id: intentId,
              app_id: appId,
              base_hash: licensingStateHash(base.state),
              base_revision: base.revision,
              action_ids: JSON.stringify(actionIds),
              created_at: now(),
              done_at: null,
            })
            .execute();
        }

        let failure: Error | null = null;
        try {
          await execute(appId, actions);
        } catch (err) {
          failure = err instanceof Error ? err : new Error(String(err));
        }
        if (base !== null) {
          try {
            if (failure !== null) {
              // A write that failed with none of its actions applied is
              // abandoned; one that returned but is not visible yet stays
              // pending until its actions show up.
              const applied = new Set(await source.operationsSince(appId, base.revision));
              if (!actionIds.some((id) => applied.has(id))) {
                await complete([intentId], { abandoned: true });
              }
            }
            const settled = await settle(appId);
            if (settled.status === "tampered") {
              logger.error(
                `[licensing] app document ${appId} changed outside Vetra during this system write; not recorded, the app stays held`,
              );
            }
          } catch (err) {
            logger.error(
              `[licensing] recording app document ${appId} failed after the write; the next read or write records it from the intent journal: ${String(err)}`,
            );
          }
        }
        if (failure !== null) throw failure;
      }),
  };
}

export interface AppLicensingWriter {
  /**
   * The ONLY way vetra-licensing changes an app document's templates or terms
   * (AppLedger.append, seeding an unrecorded document).
   */
  appendLicensingOps(appId: string, actions: Action[]): Promise<void>;
}

export function createAppLicensingWriter(deps: {
  /** A vetra-app DocGateway (it protects what it creates). */
  docs: Pick<DocGateway, "execute">;
  ledger: AppLedger;
}): AppLicensingWriter {
  return {
    appendLicensingOps: (appId, actions) =>
      deps.ledger.append(appId, actions, (id, a) => deps.docs.execute(id, a), {
        seedUnrecorded: true,
      }),
  };
}

/**
 * Initialises on first use and caches the result. A failed initialisation is
 * not cached: the next call tries again, so a ledger that was unreachable at
 * boot is never disabled for the life of the process.
 */
export function lazyLedger(init: () => Promise<AppLedger>): () => Promise<AppLedger> {
  let pending: Promise<AppLedger> | undefined;
  return () => {
    if (pending) return pending;
    const attempt = init();
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  };
}
