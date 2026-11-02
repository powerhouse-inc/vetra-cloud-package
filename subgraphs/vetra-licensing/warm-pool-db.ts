import type { Kysely } from "kysely";
import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";

export type WarmState = "WARMING" | "AVAILABLE" | "CLAIMED";

export interface WarmRow {
  environment_id: string;
  app_id: string;
  template_id: string;
  template_hash: string;
  state: WarmState;
  created_at: string;
  ready_at: string | null;
  claimed_at: string | null;
  deleted_at: string | null;
  root_license_id: string | null;
  /** When the environment document of a retired row was deleted. */
  env_deleted_at: string | null;
  /** The pool size the row was created for; null on rows from before it was recorded. */
  pool_size: number | null;
  /** Set when the keeper retired the row as a WARMING timeout. */
  timed_out_at: string | null;
}

/** A chain's `license_environments` row before it knows its environment. */
export type ChainRowDraft = Omit<LicenseEnvironments, "environment_id">;

/**
 * claimForChain's outcome: a warm environment claimed together with the
 * chain's row; none available (row null); or the chain already belonged to
 * another environment (row is that one, nothing was claimed).
 */
export type WarmChainClaim =
  | { warm: WarmRow; row: LicenseEnvironments }
  | { warm: null; row: LicenseEnvironments | null };

export interface WarmPoolStore {
  insertWarming(row: {
    environmentId: string;
    appId: string;
    templateId: string;
    templateHash: string;
    poolSize: number;
    nowIso: string;
  }): Promise<void>;
  live(appId: string, templateId: string): Promise<WarmRow[]>;
  /** Every live WARMING or AVAILABLE row (never CLAIMED ones). */
  allLive(): Promise<WarmRow[]>;
  markAvailable(environmentId: string, nowIso: string): Promise<void>;
  markDeleted(environmentId: string, nowIso: string): Promise<void>;
  /**
   * The keeper's removal: marks the row deleted only while it is live and not
   * CLAIMED, in one statement, so it cannot race a claim. True when it did;
   * only then may the caller delete the environment document. `timedOut`:
   * retired for not becoming READY in time; recorded (timed_out_at) in the
   * same statement, for timeoutStreak.
   */
  markDeletedUnclaimed(
    environmentId: string,
    nowIso: string,
    opts?: { timedOut?: boolean },
  ): Promise<boolean>;
  /**
   * Retired rows that were never CLAIMED whose environment document is not
   * yet known deleted: the keeper deletes them (again) until it is.
   */
  awaitingDeletion(): Promise<WarmRow[]>;
  /** Records that the row's environment document is deleted. */
  markEnvDeleted(environmentId: string, nowIso: string): Promise<void>;
  /**
   * How many of the pool's newest rows for this template hash and pool size
   * (at most `limit`) the keeper retired as WARMING timeouts (timed_out_at),
   * counting back to the first that was not: a row that became AVAILABLE or
   * CLAIMED, one retired for any other reason (drain, surplus, dead), or one
   * still WARMING ends the run.
   */
  timeoutStreak(q: {
    appId: string;
    templateId: string;
    templateHash: string;
    poolSize: number;
    limit: number;
  }): Promise<number>;
  claimOneAvailable(q: {
    appId: string;
    templateId: string;
    templateHash: string;
    rootLicenseId: string;
    nowIso: string;
  }): Promise<WarmRow | null>;
  /**
   * claimOneAvailable and the chain's `license_environments` row (pointing at
   * the claimed environment) in ONE transaction, so nothing ever sees the warm
   * row CLAIMED without the chain row (gitops would turn the app image off).
   * When the chain is already someone's, the transaction is rolled back and
   * the warm row stays AVAILABLE.
   */
  claimForChain(
    q: {
      appId: string;
      templateId: string;
      templateHash: string;
      rootLicenseId: string;
      nowIso: string;
    },
    chainRow: ChainRowDraft,
  ): Promise<WarmChainClaim>;
  releaseClaim(environmentId: string): Promise<void>;
  /** The row of an environment, in any state, deleted or not. */
  byEnvironment(environmentId: string): Promise<WarmRow | null>;
  isWarm(environmentId: string): Promise<{ appId: string } | null>;
  warmHours(
    appId: string,
    templateId: string,
    fromIso: string,
    toIso: string,
    nowIso?: string,
  ): Promise<number>;
  /** Rows of the pool claimed in [fromIso, toIso), deleted or not. */
  claimedBetween(
    appId: string,
    templateId: string,
    fromIso: string,
    toIso: string,
  ): Promise<number>;
}

const HOUR_MS = 3_600_000;

/** Thrown inside claimForChain's transaction to roll it back. */
class ChainTakenRollback extends Error {
  constructor(readonly row: LicenseEnvironments) {
    super("chain already claimed");
  }
}

// Single statement (UPDATE ... WHERE pk = (SELECT ... FOR UPDATE SKIP
// LOCKED)), so on its own it is one transaction; safe behind pgbouncer
// transaction mode. `db` may be a transaction.
async function claimOneAvailableIn(
  db: Kysely<VetraLicensingDB>,
  q: Parameters<WarmPoolStore["claimOneAvailable"]>[0],
): Promise<WarmRow | null> {
  const row = await db
    .updateTable("app_warm_pool")
    .set({
      state: "CLAIMED",
      claimed_at: q.nowIso,
      root_license_id: q.rootLicenseId,
    })
    .where(
      "environment_id",
      "=",
      db
        .selectFrom("app_warm_pool")
        .select("environment_id")
        .where("app_id", "=", q.appId)
        .where("template_id", "=", q.templateId)
        .where("template_hash", "=", q.templateHash)
        .where("state", "=", "AVAILABLE")
        .where("deleted_at", "is", null)
        .orderBy("ready_at")
        .limit(1)
        .forUpdate()
        .skipLocked(),
    )
    .returningAll()
    .executeTakeFirst();
  return (row as WarmRow | undefined) ?? null;
}

export function createWarmPoolStore(db: Kysely<VetraLicensingDB>): WarmPoolStore {
  return {
    async insertWarming(r) {
      await db
        .insertInto("app_warm_pool")
        .values({
          environment_id: r.environmentId,
          app_id: r.appId,
          template_id: r.templateId,
          template_hash: r.templateHash,
          state: "WARMING",
          created_at: r.nowIso,
          ready_at: null,
          claimed_at: null,
          deleted_at: null,
          root_license_id: null,
          env_deleted_at: null,
          pool_size: r.poolSize,
          timed_out_at: null,
        })
        .execute();
    },

    async live(appId, templateId) {
      return (await db
        .selectFrom("app_warm_pool")
        .selectAll()
        .where("app_id", "=", appId)
        .where("template_id", "=", templateId)
        .where("deleted_at", "is", null)
        .orderBy("created_at")
        .execute()) as WarmRow[];
    },

    async allLive() {
      return (await db
        .selectFrom("app_warm_pool")
        .selectAll()
        .where("deleted_at", "is", null)
        // A CLAIMED row is never deleted (it is the licence's environment):
        // without this every claim ever made would load on every keeper tick.
        .where("state", "!=", "CLAIMED")
        .orderBy("created_at")
        .execute()) as WarmRow[];
    },

    async markAvailable(environmentId, nowIso) {
      await db
        .updateTable("app_warm_pool")
        .set({ state: "AVAILABLE", ready_at: nowIso })
        .where("environment_id", "=", environmentId)
        .execute();
    },

    async markDeleted(environmentId, nowIso) {
      await db
        .updateTable("app_warm_pool")
        .set({ deleted_at: nowIso })
        .where("environment_id", "=", environmentId)
        .execute();
    },

    async markDeletedUnclaimed(environmentId, nowIso, opts) {
      const res = await db
        .updateTable("app_warm_pool")
        .set({
          deleted_at: nowIso,
          ...(opts?.timedOut ? { timed_out_at: nowIso } : {}),
        })
        .where("environment_id", "=", environmentId)
        .where("deleted_at", "is", null)
        .where("state", "!=", "CLAIMED")
        .executeTakeFirst();
      return Number(res.numUpdatedRows) > 0;
    },

    async awaitingDeletion() {
      return (await db
        .selectFrom("app_warm_pool")
        .selectAll()
        .where("deleted_at", "is not", null)
        .where("env_deleted_at", "is", null)
        // A CLAIMED row's environment is the licence's (a discarded claim
        // deletes its own before retiring the row).
        .where("state", "!=", "CLAIMED")
        .orderBy("deleted_at")
        .execute()) as WarmRow[];
    },

    async markEnvDeleted(environmentId, nowIso) {
      await db
        .updateTable("app_warm_pool")
        .set({ env_deleted_at: nowIso })
        .where("environment_id", "=", environmentId)
        .execute();
    },

    async timeoutStreak(q) {
      const rows = await db
        .selectFrom("app_warm_pool")
        .select("timed_out_at")
        .where("app_id", "=", q.appId)
        .where("template_id", "=", q.templateId)
        .where("template_hash", "=", q.templateHash)
        .where("pool_size", "=", q.poolSize)
        .orderBy("created_at", "desc")
        .limit(q.limit)
        .execute();
      const firstNot = rows.findIndex((r) => r.timed_out_at === null);
      return firstNot === -1 ? rows.length : firstNot;
    },

    claimOneAvailable(q) {
      return claimOneAvailableIn(db, q);
    },

    async claimForChain(q, chainRow) {
      try {
        // One BEGIN..COMMIT on one connection: fine behind pgbouncer in
        // transaction mode.
        return await db.transaction().execute(async (trx) => {
          const warm = await claimOneAvailableIn(trx, q);
          if (!warm) return { warm: null, row: null };
          // As createChainEnvironmentRows().claim: the UNIQUE root_license_id
          // is the lock and an existing claim is never overwritten.
          await trx
            .insertInto("license_environments")
            .values({ ...chainRow, environment_id: warm.environment_id })
            .onConflict((oc) => oc.column("root_license_id").doNothing())
            .execute();
          const row = await trx
            .selectFrom("license_environments")
            .selectAll()
            .where("root_license_id", "=", chainRow.root_license_id)
            .executeTakeFirstOrThrow();
          if (row.environment_id !== warm.environment_id) throw new ChainTakenRollback(row);
          return { warm, row };
        });
      } catch (err) {
        if (err instanceof ChainTakenRollback) return { warm: null, row: err.row };
        throw err;
      }
    },

    async releaseClaim(environmentId) {
      await db
        .updateTable("app_warm_pool")
        .set({ state: "AVAILABLE", claimed_at: null, root_license_id: null })
        .where("environment_id", "=", environmentId)
        .execute();
    },

    async byEnvironment(environmentId) {
      const row = await db
        .selectFrom("app_warm_pool")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .executeTakeFirst();
      return (row as WarmRow | undefined) ?? null;
    },

    async isWarm(environmentId) {
      const row = await db
        .selectFrom("app_warm_pool")
        .select("app_id")
        .where("environment_id", "=", environmentId)
        .where("deleted_at", "is", null)
        .where("state", "!=", "CLAIMED")
        .executeTakeFirst();
      return row ? { appId: row.app_id } : null;
    },

    async claimedBetween(appId, templateId, fromIso, toIso) {
      const rows = await db
        .selectFrom("app_warm_pool")
        .select("claimed_at")
        .where("app_id", "=", appId)
        .where("template_id", "=", templateId)
        .where("claimed_at", "is not", null)
        .execute();
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      return rows.filter((r) => {
        const t = Date.parse(r.claimed_at as string);
        return t >= from && t < to;
      }).length;
    },

    async warmHours(appId, templateId, fromIso, toIso, nowIso) {
      const rows = await db
        .selectFrom("app_warm_pool")
        .select(["created_at", "claimed_at", "deleted_at"])
        .where("app_id", "=", appId)
        .where("template_id", "=", templateId)
        .execute();
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      const now = nowIso ? Date.parse(nowIso) : Date.now();
      let ms = 0;
      for (const r of rows) {
        const start = Date.parse(r.created_at);
        const end = Date.parse(r.claimed_at ?? r.deleted_at ?? new Date(now).toISOString());
        ms += Math.max(0, Math.min(end, to) - Math.max(start, from));
      }
      return ms / HOUR_MS;
    },
  };
}
