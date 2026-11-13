import { sql, type Kysely } from "kysely";
import type { VetraAppsDB } from "../db/schema.js";
import { AUDIT_SYSTEM_ACTOR, recordAudit } from "../audit/repo.js";
import type { InstanceRow } from "../instances/repo.js";

class ChainTaken extends Error {}

/**
 * Hands a ready warm instance of the plan to a new holder (W3, W4), as
 * licensing's claimOneAvailableIn: one UPDATE over a SKIP LOCKED pick, so two
 * claims never take one row. Keeps id, host, environment and tenant.
 * Null when none is claimable (the caller creates cold).
 */
export async function claimWarmInstance(
  db: Kysely<VetraAppsDB>,
  q: {
    appId: string;
    planId: string;
    digest: string;
    targetSize: string;
    holder: string;
    root: string;
    name: string;
    nowIso: string;
  },
): Promise<InstanceRow | null> {
  try {
    return await db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("instances")
        .set({
          warm: false,
          holder_address: q.holder,
          licence_root_id: q.root,
          name: q.name,
          claimed_at: q.nowIso,
          licence_ended_at: null,
          updated_at: q.nowIso,
        })
        .where(
          "id",
          "=",
          trx
            .selectFrom("instances")
            .select("id")
            .where("app_id", "=", q.appId)
            .where("plan_id", "=", q.planId)
            .where("kind", "=", "own")
            .where("warm", "=", true)
            .where("removed_at", "is", null)
            .where("stop_reason", "is", null)
            .where("status", "=", "ready")
            .where("target_digest", "=", q.digest)
            .where("running_digest", "=", q.digest)
            .where("target_size", "=", q.targetSize)
            // Never a row the monitor found unhealthy; healthy ones first.
            .where((eb) =>
              eb.or([eb("health", "is", null), eb("health", "!=", "unhealthy")]),
            )
            .orderBy(sql`coalesce(health = 'healthy', false)`, "desc")
            .orderBy("created_at")
            .orderBy("id")
            .limit(1)
            .forUpdate()
            .skipLocked(),
        )
        .returningAll()
        .executeTakeFirst()
        .catch((err: unknown) => {
          if ((err as { code?: unknown } | null)?.code === "23505")
            throw new ChainTaken();
          throw err;
        });
      if (!row) return null;
      await recordAudit(trx, {
        appId: q.appId,
        at: q.nowIso,
        actor: AUDIT_SYSTEM_ACTOR,
        source: "system",
        action: "instance.claimed",
        subject: `instance:${row.id}`,
        detail: {
          planId: q.planId,
          holder: q.holder,
          licenceRoot: q.root,
          warmSince: row.created_at,
        },
      });
      return {
        ...row,
        target_run: row.target_run == null ? null : Number(row.target_run),
      } as InstanceRow;
    });
  } catch (err) {
    if (err instanceof ChainTaken) return null;
    throw err;
  }
}

/**
 * Claimable warm rows per plan of the App now (ready on their own target;
 * W3 also needs the plan's current target and size, which the console reads
 * from the plan: this counts what is ready, for display).
 */
export async function warmReadyCounts(
  db: Kysely<VetraAppsDB>,
  appId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("instances")
    .select(["plan_id", "target_digest", "running_digest", "target_size"])
    .where("app_id", "=", appId)
    .where("kind", "=", "own")
    .where("warm", "=", true)
    .where("removed_at", "is", null)
    .where("stop_reason", "is", null)
    .where("status", "=", "ready")
    .execute();
  const out = new Map<string, number>();
  for (const r of rows)
    if (r.plan_id && r.running_digest === r.target_digest)
      out.set(r.plan_id, (out.get(r.plan_id) ?? 0) + 1);
  return out;
}
