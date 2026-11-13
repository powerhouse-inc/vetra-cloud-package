import type { Kysely, Selectable } from "kysely";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import type { TeamReleaseRunsTable, VetraAppsDB } from "../db/schema.js";
import type { InstanceRow } from "../instances/repo.js";

export type TeamRunRow = Selectable<TeamReleaseRunsTable>;

export async function teamRunOf(
  db: Kysely<VetraAppsDB>,
  appId: string,
  version: string,
): Promise<TeamRunRow | null> {
  return (
    (await db
      .selectFrom("team_release_runs")
      .selectAll()
      .where("app_id", "=", appId)
      .where("version", "=", version)
      .executeTakeFirst()) ?? null
  );
}

export async function teamRunsOf(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<Map<string, TeamRunRow>> {
  const rows = await db
    .selectFrom("team_release_runs")
    .selectAll()
    .where("app_id", "=", appId)
    .execute();
  return new Map(rows.map((r) => [r.version, r]));
}

/** Ready and healthy on what it runs, continuously for the soak (decision T6). */
export function qualifiesAsRun(
  row: InstanceRow,
  soakMs: number,
  now: Date,
): boolean {
  if (row.status !== "ready" || row.health !== "healthy") return false;
  if (
    !row.running_version ||
    !row.running_digest ||
    row.health_digest !== row.running_digest
  )
    return false;
  const since = Date.parse(row.health_since ?? "");
  return Number.isFinite(since) && now.getTime() - since >= soakMs;
}

/** Records the run once (a repeat is a no-op); true when it was new. */
export async function recordTeamRun(
  db: Kysely<VetraAppsDB>,
  row: InstanceRow,
  soakMinutes: number,
  nowIso: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const res = await trx
      .insertInto("team_release_runs")
      .values({
        app_id: row.app_id,
        version: row.running_version!,
        digest: row.running_digest!,
        instance_id: row.id,
        healthy_since: row.health_since!,
        recorded_at: nowIso,
      })
      .onConflict((oc) => oc.columns(["app_id", "version"]).doNothing())
      .executeTakeFirst();
    if (Number(res.numInsertedOrUpdatedRows ?? 0) === 0) return false;
    await recordAudit(trx, {
      appId: row.app_id,
      at: nowIso,
      actor: AUDIT_SYSTEM_ACTOR,
      source: "system",
      action: "team.ran_healthy",
      subject: `release:${row.running_version}`,
      detail: {
        digest: row.running_digest,
        instanceId: row.id,
        soakMinutes,
      },
    });
    return true;
  });
}
