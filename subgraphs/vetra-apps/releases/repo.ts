import type { Insertable, Kysely, Selectable } from "kysely";
import type { ReleasesTable, VetraAppsDB } from "../db/schema.js";

export type ReleaseRow = Selectable<ReleasesTable>;
export type NewRelease = Insertable<ReleasesTable>;

/** `run` is a bigint column (GitHub run ids exceed 32 bits); drivers may return it as a string. */
function normalize(r: ReleaseRow): ReleaseRow {
  return { ...r, run: Number(r.run) };
}

/** Stores a release or build once; a repeat returns the stored row unchanged. */
export async function insertRelease(
  db: Kysely<VetraAppsDB>,
  row: NewRelease,
): Promise<{ row: ReleaseRow; created: boolean }> {
  const inserted = await db
    .insertInto("releases")
    .values(row)
    .onConflict((oc) => oc.columns(["app_id", "version"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return { row: normalize(inserted), created: true };
  const stored = await db
    .selectFrom("releases")
    .selectAll()
    .where("app_id", "=", row.app_id)
    .where("version", "=", row.version)
    .executeTakeFirstOrThrow();
  return { row: normalize(stored), created: false };
}

export async function listReleases(
  db: Kysely<VetraAppsDB>,
  appId: string,
  opts: { kind?: "release" | "build"; limit: number },
): Promise<ReleaseRow[]> {
  let q = db.selectFrom("releases").selectAll().where("app_id", "=", appId);
  if (opts.kind) q = q.where("kind", "=", opts.kind);
  const rows = await q.orderBy("run", "desc").limit(opts.limit).execute();
  return rows.map(normalize);
}

export async function recordPushRobot(
  db: Kysely<VetraAppsDB>,
  r: { namespace: string; robotId: number; createdAt: string },
): Promise<void> {
  await db
    .insertInto("namespace_push_robots")
    .values({
      robot_id: r.robotId,
      namespace: r.namespace,
      created_at: r.createdAt,
    })
    .execute();
}

export async function pushRobotsOlderThan(
  db: Kysely<VetraAppsDB>,
  iso: string,
) {
  return db
    .selectFrom("namespace_push_robots")
    .selectAll()
    .where("created_at", "<", iso)
    .execute();
}

export async function forgetPushRobot(
  db: Kysely<VetraAppsDB>,
  robotId: number,
): Promise<void> {
  await db
    .deleteFrom("namespace_push_robots")
    .where("robot_id", "=", robotId)
    .execute();
}
