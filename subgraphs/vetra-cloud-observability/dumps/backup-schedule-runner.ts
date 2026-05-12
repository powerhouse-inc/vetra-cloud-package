import type { DumpsRepo } from "./repo.js";
import type { CreateDumpInput } from "./service.js";
import type { DatabaseDumps } from "../db/schema.js";

/** Cadence -> period in milliseconds. */
export const CADENCE_MS: Record<string, number> = {
  HOURLY: 3_600_000,
  DAILY: 86_400_000,
  WEEKLY: 604_800_000,
};

/**
 * Minimal projection of a VetraCloudEnvironment document used by the
 * backup-schedule runner. Built by the runner from
 * `reactorClient.get(...)` per tick (the processor's `environments`
 * table doesn't auto-project the nested backupSchedule field, so
 * we read the document directly).
 */
export type BackupEnvSnapshot = {
  /** Document id (used as both reactor id and dump.documentId). */
  documentId: string;
  /** k8s namespace where the pg_dump Job will run. */
  tenantId: string;
  backupSchedule: {
    enabled: boolean;
    cadence: string; // HOURLY | DAILY | WEEKLY
    retention: number;
  } | null;
};

/**
 * Function the runner uses to fire a dump. In production this is a
 * partial application of {@link createDumpAndJob}; in tests it's a
 * spy. Returning the row keeps tests simple (they can assert on
 * `.id`).
 */
export type FireDump = (input: CreateDumpInput) => Promise<DatabaseDumps>;

/**
 * Subset of {@link DumpsRepo} the runner depends on. Keeping it
 * narrow means tests can use a hand-rolled stub instead of standing
 * up the PGlite-backed real repo.
 */
export type RunnerRepo = Pick<
  DumpsRepo,
  "lastScheduledRequestedAt" | "listScheduledByTenant" | "deleteById"
>;

/**
 * Pure, testable single-tick implementation. Iterates the env
 * snapshots once and returns a summary so tests can assert on
 * what happened. Errors on individual envs are caught and logged
 * via `onError` — one tenant's bad state never aborts the tick.
 */
export async function runBackupScheduleTick(
  envSnapshots: readonly BackupEnvSnapshot[],
  repo: RunnerRepo,
  fire: FireDump,
  now: Date,
  onError: (env: BackupEnvSnapshot, err: unknown) => void = () => {},
): Promise<{
  considered: number;
  fired: string[]; // document ids
  deleted: string[]; // dump ids deleted for retention
}> {
  const fired: string[] = [];
  const deleted: string[] = [];

  for (const env of envSnapshots) {
    try {
      const sched = env.backupSchedule;
      // Schedule must exist and be enabled.
      if (!sched || !sched.enabled) continue;

      const cadenceMs = CADENCE_MS[sched.cadence];
      // Unknown cadence -> skip (rather than throwing). The doc-model
      // zod schema enforces the enum on write, so this is a defensive
      // guard for corrupt state, not an expected branch.
      if (!cadenceMs) continue;

      // Decide whether the tick is due.
      const last = await repo.lastScheduledRequestedAt(env.tenantId);
      const due =
        last === null || now.getTime() >= last.getTime() + cadenceMs;

      if (due) {
        try {
          await fire({
            documentId: env.documentId,
            tenantId: env.tenantId,
            requestedBy: "scheduler",
            source: "SCHEDULED",
          });
          fired.push(env.documentId);
        } catch (err) {
          // Fire failures are non-fatal: log via onError, keep
          // ticking other envs. The next tick re-attempts.
          onError(env, err);
        }
      }

      // Retention enforcement runs every tick (not just on fire) so a
      // freshly-lowered retention setting takes effect on the very
      // next minute. Count all SCHEDULED rows for the tenant (any
      // status) so a string of FAILED dumps doesn't silently extend
      // retention beyond the cap.
      const allScheduled = await repo.listScheduledByTenant(env.tenantId);
      const excess = allScheduled.length - sched.retention;
      if (excess > 0) {
        // listScheduledByTenant returns oldest-first, so the leading
        // slice is what we drop.
        const toDelete = allScheduled.slice(0, excess);
        for (const row of toDelete) {
          try {
            await repo.deleteById(row.id);
            deleted.push(row.id);
          } catch (err) {
            // Same fail-soft rule for retention deletes.
            onError(env, err);
          }
        }
      }
    } catch (err) {
      onError(env, err);
    }
  }

  return { considered: envSnapshots.length, fired, deleted };
}
