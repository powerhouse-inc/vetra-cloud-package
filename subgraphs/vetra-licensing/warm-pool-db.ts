import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "./db/schema.js";

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
}

export interface WarmPoolStore {
  insertWarming(row: {
    environmentId: string;
    appId: string;
    templateId: string;
    templateHash: string;
    nowIso: string;
  }): Promise<void>;
  live(appId: string, templateId: string): Promise<WarmRow[]>;
  allLive(): Promise<WarmRow[]>;
  markAvailable(environmentId: string, nowIso: string): Promise<void>;
  markDeleted(environmentId: string, nowIso: string): Promise<void>;
  claimOneAvailable(q: {
    appId: string;
    templateId: string;
    templateHash: string;
    rootLicenseId: string;
    nowIso: string;
  }): Promise<WarmRow | null>;
  releaseClaim(environmentId: string): Promise<void>;
  isWarm(environmentId: string): Promise<{ appId: string } | null>;
  warmHours(
    appId: string,
    templateId: string,
    fromIso: string,
    toIso: string,
    nowIso?: string,
  ): Promise<number>;
}

const HOUR_MS = 3_600_000;

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

    // Single statement (UPDATE ... WHERE pk = (SELECT ... FOR UPDATE SKIP
    // LOCKED)) so it is one transaction; safe behind pgbouncer transaction mode.
    async claimOneAvailable(q) {
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
    },

    async releaseClaim(environmentId) {
      await db
        .updateTable("app_warm_pool")
        .set({ state: "AVAILABLE", claimed_at: null, root_license_id: null })
        .where("environment_id", "=", environmentId)
        .execute();
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
