import { withKeyLock } from "../../../shared/key-lock.js";
import { ArchivesRepo } from "../../vetra-cloud-observability/dumps/archive-repo.js";
import { DumpsRepo } from "../../vetra-cloud-observability/dumps/repo.js";
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { backupsConfigOf } from "../config.js";
import { getInstance } from "../instances/repo.js";
import type { AppsDeps } from "../service.js";
import {
  countPendingBackups,
  deleteBackup,
  lastBackupOf,
  sweepableBackups,
} from "./repo.js";
import { BackupBusyError, startInstanceBackup } from "./service.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const DAILY_RETRY_MS = HOUR_MS;
export const SWEEP_BATCH = 200;

const message = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * The daily backup of every running shared and own instance (spec section
 * 7, decision B7), then the retention sweep. Runs every few minutes; the
 * in-flight cap spreads the first wave.
 */
export async function runDailyBackupsOnce(
  deps: AppsDeps,
): Promise<{ started: string[]; deleted: number }> {
  const cfg = backupsConfigOf(deps.cfg);
  if (!cfg.enabled || !deps.backups || !deps.cfg.instances.enabled)
    return { started: [], deleted: 0 };
  const rows = await deps.db
    .selectFrom("instances")
    .selectAll()
    .where("kind", "in", ["shared", "own"])
    .where("removed_at", "is", null)
    .where("environment_id", "is not", null)
    .where("status", "=", "ready")
    .where("stop_reason", "is", null)
    .where("maintenance", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  let budget = cfg.maxInFlight - (await countPendingBackups(deps.db));
  const started: string[] = [];
  for (const row of rows) {
    if (budget <= 0) break;
    const last = await lastBackupOf(deps.db, row.id, "daily");
    if (last) {
      const age = deps.now().getTime() - Date.parse(last.created_at);
      if (last.status === "pending") continue;
      if (last.status === "ready" && age < DAY_MS) continue;
      if (last.status === "failed" && age < DAILY_RETRY_MS) continue;
    }
    try {
      const b = await withKeyLock(`instances:${row.app_id}`, async () => {
        // Re-read under the lock: a restore may have taken it meanwhile.
        const cur = await getInstance(deps.db, row.id);
        if (
          !cur ||
          cur.maintenance ||
          cur.stop_reason ||
          cur.status !== "ready"
        )
          return null;
        return startInstanceBackup(deps, cur, {
          reason: "daily",
          requestedBy: AUDIT_SYSTEM_ACTOR,
        });
      });
      if (b) {
        started.push(b.id);
        budget--;
      }
    } catch (err) {
      if (!(err instanceof BackupBusyError))
        deps.logger.warn(
          `[vetra-apps] daily backup of instance ${row.name}: ${message(err)}`,
        );
    }
  }
  return { started, deleted: await sweepBackupsOnce(deps) };
}

/**
 * Deletes expired backups, and failed ones older than a day: their S3
 * objects (a failed delete is logged; the bucket lifecycle removes the file
 * within 30 days), their observability rows, then their row.
 */
export async function sweepBackupsOnce(deps: AppsDeps): Promise<number> {
  const b = deps.backups;
  const obs = deps.observabilityDb;
  if (!b || !obs) return 0;
  const now = deps.now();
  const rows = await sweepableBackups(
    deps.db,
    now.toISOString(),
    new Date(now.getTime() - DAY_MS).toISOString(),
    SWEEP_BATCH,
  );
  const dumps = new DumpsRepo(obs);
  const archives = new ArchivesRepo(obs);
  for (const r of rows) {
    const dump = r.dump_id ? await dumps.getById(r.dump_id) : null;
    const archive = r.archive_id ? await archives.getById(r.archive_id) : null;
    for (const key of [dump?.s3Key, archive?.s3Key])
      if (key)
        await b
          .deleteObject(key)
          .catch((err: unknown) =>
            deps.logger.warn(
              `[vetra-apps] backup sweep: deleting ${key} failed: ${message(err)}`,
            ),
          );
    if (dump) await dumps.deleteById(dump.id);
    if (archive) await archives.deleteById(archive.id);
    await deleteBackup(deps.db, r.id);
  }
  return rows.length;
}
