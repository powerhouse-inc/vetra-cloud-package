import type { DumpSource } from "../db/schema.js";
import type { DumpsRepo } from "./repo.js";

/** Newest dumps kept per environment and source. SCHEDULED is overridden by the env's schedule. */
export const RETENTION: Record<DumpSource, number> = {
  MANUAL: 5,
  SCHEDULED: 7,
  PRE_RESTORE: 3,
};

/**
 * Deletes the oldest dumps of one source beyond `keep`, S3 object first,
 * then the row. In-flight dumps are never deleted (they still count towards
 * `keep`). A failed S3 delete is logged and the row goes anyway: the bucket
 * lifecycle removes an orphaned file within 30 days, while a kept row would
 * keep pointing at a file retention meant to delete. Returns deleted ids.
 */
export async function applyRetention(
  repo: Pick<DumpsRepo, "listBySource" | "deleteById">,
  deleteObject: (key: string) => Promise<void>,
  tenantId: string,
  source: DumpSource,
  keep: number,
): Promise<string[]> {
  const rows = await repo.listBySource(tenantId, source);
  const excess = rows.slice(0, Math.max(0, rows.length - keep));
  const deleted: string[] = [];
  for (const row of excess) {
    if (row.status === "PENDING" || row.status === "RUNNING") continue;
    if (row.s3Key) {
      await deleteObject(row.s3Key).catch((err: unknown) => {
        console.warn(`[dump-retention] S3 delete failed for ${row.s3Key}:`, err);
      });
    }
    await repo.deleteById(row.id);
    deleted.push(row.id);
  }
  return deleted;
}
