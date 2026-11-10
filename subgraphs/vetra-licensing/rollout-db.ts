import { sql, type Kysely } from "kysely";
import type {
  AppRollouts,
  EnvironmentUpdates,
  ReleasePolicy,
  UpdateStatus,
  VetraLicensingDB,
} from "./db/schema.js";

/** Postgres SQLSTATE for "relation does not exist". */
const UNDEFINED_TABLE = "42P01";

export interface ReleaseSettings {
  appId: string;
  policy: ReleasePolicy;
  defaultNoticeHours: number;
}

/** What an app without a settings row has: every app before this feature. */
export const DEFAULT_NOTICE_HOURS = 72;

/**
 * The app's release policy, for vetra-apps' CI artifact path (spec 4.1). The
 * licensing subgraph creates the table; until it has booted no app can be
 * GATED, so a missing table reads as AUTO. Any other failure propagates: CI
 * fails loudly rather than publishing a gated build to every customer.
 */
export async function releasePolicyOf(
  db: Kysely<VetraLicensingDB>,
  appId: string,
): Promise<ReleasePolicy> {
  try {
    const row = await db
      .selectFrom("app_release_settings")
      .select("policy")
      .where("app_id", "=", appId)
      .executeTakeFirst();
    return row?.policy ?? "AUTO";
  } catch (err) {
    if ((err as { code?: string } | null)?.code === UNDEFINED_TABLE)
      return "AUTO";
    throw err;
  }
}

const OPEN: UpdateStatus[] = ["PENDING", "APPLYING"];

/**
 * First key of this module's two-int advisory locks ("roll"), so an app's
 * lock cannot collide with another module's keys. No other advisory lock is
 * taken in this repo.
 */
const ROLLOUT_LOCK_NAMESPACE = 0x726f6c6c;

/** Every field but the status: a status changes only through a guarded transition. */
type UpdatePatch = Partial<
  Omit<
    EnvironmentUpdates,
    "id" | "environment_id" | "app_id" | "rollout_id" | "status"
  >
>;

/** The store's queries, over the database or over one transaction. */
export type RolloutQueries = ReturnType<typeof rolloutQueries>;

export type RolloutStore = RolloutQueries & {
  /**
   * fn over the queries bound to one transaction. Not nestable, but promote
   * and resume called on those queries join it rather than opening their own.
   */
  inTransaction<T>(fn: (queries: RolloutQueries) => Promise<T>): Promise<T>;
};

/**
 * `app_release_settings`, `app_rollouts` and `environment_updates`. Newest
 * means latest `created_at` (then id, so the order is total).
 */
export function createRolloutStore(db: Kysely<VetraLicensingDB>): RolloutStore {
  return {
    ...rolloutQueries(db),
    inTransaction: (fn) =>
      db.transaction().execute((trx) => fn(rolloutQueries(trx))),
  };
}

function rolloutQueries(db: Kysely<VetraLicensingDB>) {
  /** fn on the current transaction, or on a new one when there is none. */
  const atomically = <T>(fn: (trx: Kysely<VetraLicensingDB>) => Promise<T>) =>
    db.isTransaction ? fn(db) : db.transaction().execute(fn);
  const lockApp = async (
    trx: Kysely<VetraLicensingDB>,
    appId: string,
  ): Promise<void> => {
    await sql`select pg_advisory_xact_lock(${ROLLOUT_LOCK_NAMESPACE}::int, hashtext(${appId}))`.execute(
      trx,
    );
  };
  const transitionUpdate = async (
    id: string,
    from: UpdateStatus | readonly UpdateStatus[],
    patch: Partial<Omit<EnvironmentUpdates, "id">>,
  ): Promise<boolean> => {
    const statuses = typeof from === "string" ? [from] : from;
    if (statuses.length === 0) return false;
    const r = await db
      .updateTable("environment_updates")
      .set(patch)
      .where("id", "=", id)
      .where("status", "in", statuses)
      .executeTakeFirst();
    return Number(r.numUpdatedRows) > 0;
  };
  const updates = () =>
    db
      .selectFrom("environment_updates")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc");
  const first = (q: Promise<EnvironmentUpdates | undefined>) =>
    q.then((r) => r ?? null);
  return {
    /**
     * Holds the app's transaction-scoped advisory lock until commit or
     * rollback, so writers of one app (the keeper on one chain, the machine
     * API on another) serialise across connections. Only meaningful inside
     * inTransaction: on its own it is released as soon as it is taken.
     * Transaction-scoped on purpose: production reaches Postgres through
     * pgbouncer in transaction mode, where session locks leak (see
     * withChainLock in environments.ts).
     */
    lockApp: (appId: string): Promise<void> => lockApp(db, appId),
    async settings(appId: string): Promise<ReleaseSettings> {
      const row = await db
        .selectFrom("app_release_settings")
        .selectAll()
        .where("app_id", "=", appId)
        .executeTakeFirst();
      return {
        appId,
        policy: row?.policy ?? "AUTO",
        defaultNoticeHours: row?.default_notice_hours ?? DEFAULT_NOTICE_HOURS,
      };
    },
    async saveSettings(s: ReleaseSettings, now: string): Promise<void> {
      const row = {
        policy: s.policy,
        default_notice_hours: s.defaultNoticeHours,
        updated_at: now,
      };
      await db
        .insertInto("app_release_settings")
        .values({ app_id: s.appId, ...row })
        .onConflict((oc) => oc.column("app_id").doUpdateSet(row))
        .execute();
    },

    rollout: (id: string): Promise<AppRollouts | null> =>
      db
        .selectFrom("app_rollouts")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst()
        .then((r) => r ?? null),
    /**
     * The artifact's newest rollout of `version` that is ACTIVE, PAUSED or
     * COMPLETE (never SUPERSEDED), or null: the release a gated customer
     * moving to `version` belongs to.
     */
    releasedRollout: (
      appId: string,
      artifactName: string,
      version: string,
    ): Promise<AppRollouts | null> =>
      db
        .selectFrom("app_rollouts")
        .selectAll()
        .where("app_id", "=", appId)
        .where("artifact_name", "=", artifactName)
        .where("version", "=", version)
        .where("status", "in", ["ACTIVE", "PAUSED", "COMPLETE"])
        .orderBy("promoted_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst()
        .then((r) => r ?? null),
    /** Newest promotion first. */
    rolloutsOf: (appId: string): Promise<AppRollouts[]> =>
      db
        .selectFrom("app_rollouts")
        .selectAll()
        .where("app_id", "=", appId)
        .orderBy("promoted_at", "desc")
        .orderBy("id", "desc")
        .execute(),
    /** Newest promotion first. */
    activeRollouts: (appId: string): Promise<AppRollouts[]> =>
      db
        .selectFrom("app_rollouts")
        .selectAll()
        .where("app_id", "=", appId)
        .where("status", "=", "ACTIVE")
        .orderBy("promoted_at", "desc")
        .orderBy("id", "desc")
        .execute(),
    /**
     * Every ACTIVE or PAUSED rollout of the artifact becomes SUPERSEDED and
     * `row` is inserted, in one transaction (the caller's, if any), under
     * the app's lock so two promotions serialise and the later supersedes
     * the earlier. Their PENDING updates stay: the keeper supersedes each
     * when it inserts its successor, keeping the earlier deadline (decision 9).
     */
    async promote(row: AppRollouts): Promise<void> {
      await atomically(async (trx) => {
        await lockApp(trx, row.app_id);
        await trx
          .updateTable("app_rollouts")
          .set({ status: "SUPERSEDED" })
          .where("app_id", "=", row.app_id)
          .where("artifact_name", "=", row.artifact_name)
          .where("status", "in", ["ACTIVE", "PAUSED"])
          .execute();
        await trx.insertInto("app_rollouts").values(row).execute();
      });
    },
    /** ACTIVE -> PAUSED; false when it was not ACTIVE (already paused, superseded...). */
    async pause(id: string, reason: string, now: string): Promise<boolean> {
      const r = await db
        .updateTable("app_rollouts")
        .set({ status: "PAUSED", paused_at: now, paused_reason: reason })
        .where("id", "=", id)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },
    /** PAUSED -> ACTIVE, and its FAILED updates back to PENDING, in one transaction (the caller's, if any). */
    async resume(id: string): Promise<boolean> {
      return atomically(async (trx) => {
        const r = await trx
          .updateTable("app_rollouts")
          .set({ status: "ACTIVE", paused_at: null, paused_reason: null })
          .where("id", "=", id)
          .where("status", "=", "PAUSED")
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) === 0) return false;
        await trx
          .updateTable("environment_updates")
          .set({
            status: "PENDING",
            error: null,
            started_at: null,
            finished_at: null,
          })
          .where("rollout_id", "=", id)
          .where("status", "=", "FAILED")
          .execute();
        return true;
      });
    },
    /** ACTIVE -> COMPLETE; false when it was not ACTIVE. */
    async complete(id: string): Promise<boolean> {
      const r = await db
        .updateTable("app_rollouts")
        .set({ status: "COMPLETE" })
        .where("id", "=", id)
        .where("status", "=", "ACTIVE")
        .executeTakeFirst();
      return Number(r.numUpdatedRows) > 0;
    },
    /** PENDING and APPLYING updates of the rollout. */
    openCount: async (rolloutId: string): Promise<number> =>
      Number(
        (
          await db
            .selectFrom("environment_updates")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("rollout_id", "=", rolloutId)
            .where("status", "in", OPEN)
            .executeTakeFirstOrThrow()
        ).n,
      ),
    countsByStatus: async (
      rolloutId: string,
    ): Promise<{ status: UpdateStatus; count: number }[]> =>
      (
        await db
          .selectFrom("environment_updates")
          .select((eb) => ["status", eb.fn.countAll<string>().as("n")])
          .where("rollout_id", "=", rolloutId)
          .groupBy("status")
          .orderBy("status")
          .execute()
      ).map((r) => ({ status: r.status, count: Number(r.n) })),

    update: (id: string): Promise<EnvironmentUpdates | null> =>
      first(
        db
          .selectFrom("environment_updates")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst(),
      ),
    /** The environment's row of a rollout (there is at most one). */
    updateFor: (
      rolloutId: string,
      environmentId: string,
    ): Promise<EnvironmentUpdates | null> =>
      first(
        updates()
          .where("rollout_id", "=", rolloutId)
          .where("environment_id", "=", environmentId)
          .executeTakeFirst(),
      ),
    /** The environment's newest row without a rollout to `toVersion` that is not SUPERSEDED. */
    unrolledUpdate: (
      environmentId: string,
      toVersion: string,
    ): Promise<EnvironmentUpdates | null> =>
      first(
        updates()
          .where("environment_id", "=", environmentId)
          .where("rollout_id", "is", null)
          .where("to_version", "=", toVersion)
          .where("status", "!=", "SUPERSEDED")
          .executeTakeFirst(),
      ),
    /** The environment's newest PENDING or APPLYING row other than `exceptId`. */
    openExcept: (
      environmentId: string,
      exceptId: string | null,
    ): Promise<EnvironmentUpdates | null> => {
      let q = updates()
        .where("environment_id", "=", environmentId)
        .where("status", "in", OPEN);
      if (exceptId !== null) q = q.where("id", "!=", exceptId);
      return first(q.executeTakeFirst());
    },
    /** Whether another environment of the app has an APPLYING update. */
    anotherApplying: async (
      appId: string,
      environmentId: string,
    ): Promise<boolean> =>
      (await db
        .selectFrom("environment_updates")
        .select("id")
        .where("app_id", "=", appId)
        .where("environment_id", "!=", environmentId)
        .where("status", "=", "APPLYING")
        .executeTakeFirst()) !== undefined,
    applyingOf: (appId: string): Promise<EnvironmentUpdates[]> =>
      updates()
        .where("app_id", "=", appId)
        .where("status", "=", "APPLYING")
        .execute(),
    pendingOf: (appId: string): Promise<EnvironmentUpdates[]> =>
      updates()
        .where("app_id", "=", appId)
        .where("status", "=", "PENDING")
        .execute(),
    /** The environment's newest row that is not SUPERSEDED. */
    latest: (environmentId: string): Promise<EnvironmentUpdates | null> =>
      first(
        updates()
          .where("environment_id", "=", environmentId)
          .where("status", "!=", "SUPERSEDED")
          .executeTakeFirst(),
      ),
    /** Newest first. */
    history: (
      environmentId: string,
      limit: number,
    ): Promise<EnvironmentUpdates[]> =>
      updates()
        .where("environment_id", "=", environmentId)
        .limit(limit)
        .execute(),

    async insertUpdate(row: EnvironmentUpdates): Promise<void> {
      await db.insertInto("environment_updates").values(row).execute();
    },
    async patchUpdate(id: string, patch: UpdatePatch): Promise<void> {
      await db
        .updateTable("environment_updates")
        .set(patch)
        .where("id", "=", id)
        .execute();
    },
    /**
     * The row from one of `from` to `patch` (which may set the status), in
     * one guarded UPDATE; false when the row was in no status of `from`.
     */
    transitionUpdate,
    /** APPLYING -> PENDING: an admitted update whose actions never went out. */
    releaseApplying: (id: string): Promise<boolean> =>
      transitionUpdate(id, "APPLYING", { status: "PENDING", started_at: null }),
    /** `from` (APPLYING unless given) -> SUCCEEDED or FAILED; false when it was not in `from`. */
    finishUpdate: (
      id: string,
      status: "SUCCEEDED" | "FAILED",
      error: string | null,
      now: string,
      from: UpdateStatus = "APPLYING",
    ): Promise<boolean> =>
      transitionUpdate(id, from, { status, error, finished_at: now }),
  };
}
