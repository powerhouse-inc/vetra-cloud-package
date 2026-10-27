import type { DatabaseDumps } from "../db/schema.js";
import type { DumpsRepo } from "./repo.js";
import { applyRetention } from "./retention.js";
import type { CreateDumpInput } from "./service.js";

export type BackupCadence = "HOURLY" | "DAILY" | "WEEKLY";

export type BackupSchedule = {
  enabled: boolean;
  cadence: BackupCadence;
  retention: number;
};

/** Applied to every environment that hasn't set a schedule (doc state `backupSchedule: null`). */
export const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: true,
  cadence: "DAILY",
  retention: 7,
};

/** Scheduled pg_dump Jobs allowed in flight across the cluster at once. */
export const MAX_SCHEDULED_IN_FLIGHT = 5;

const CADENCE_MS: Record<BackupCadence, number> = {
  HOURLY: 3_600_000,
  DAILY: 86_400_000,
  WEEKLY: 604_800_000,
};

/** One environment the scheduler considers. A null schedule means DEFAULT_SCHEDULE. */
export type BackupEnvSnapshot = {
  documentId: string;
  tenantId: string;
  backupSchedule: BackupSchedule | null;
};

/** Projection of the processor's `environments` row the runner reads. */
export type BackupEnvRow = {
  id: string;
  tenantId: string | null;
  status: string | null;
  appRole: string | null;
  services: string | null;
  backupSchedule: string | null;
};

/**
 * Maps an environments row to a scheduler snapshot, or null when the env
 * has no database to dump: not READY (stopped, deploying, deleted), no
 * tenant namespace, a PREVIEW app env (chart disables its backups), or no
 * enabled Switchboard (the chart's gate for the CNPG cluster).
 */
export function toBackupEnvSnapshot(row: BackupEnvRow): BackupEnvSnapshot | null {
  if (row.status !== "READY" || !row.tenantId || row.appRole === "PREVIEW") return null;
  let services: Array<{ type?: string; enabled?: boolean }>;
  try {
    services = JSON.parse(row.services ?? "[]") as typeof services;
  } catch {
    return null;
  }
  if (!services.some((s) => s.type === "SWITCHBOARD" && s.enabled)) return null;
  return {
    documentId: row.id,
    tenantId: row.tenantId,
    backupSchedule: parseSchedule(row.backupSchedule),
  };
}

function parseSchedule(raw: string | null): BackupSchedule | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<BackupSchedule>;
    if (typeof s.enabled !== "boolean" || !s.cadence || !(s.cadence in CADENCE_MS)) return null;
    if (typeof s.retention !== "number") return null;
    return { enabled: s.enabled, cadence: s.cadence, retention: s.retention };
  } catch {
    return null;
  }
}

export type RunnerDeps = {
  repo: Pick<DumpsRepo, "lastRequestedAt" | "countInFlightBySource" | "listBySource" | "deleteById">;
  /** Creates a SCHEDULED dump row + Job (createDumpAndJob in production). */
  fire: (input: CreateDumpInput) => Promise<DatabaseDumps>;
  deleteObject: (key: string) => Promise<void>;
  maxInFlight: number;
  onError?: (env: BackupEnvSnapshot, err: unknown) => void;
};

/**
 * One scheduler pass. Fires a SCHEDULED dump for each env whose cadence has
 * elapsed since its last scheduled dump (immediately when it never had one),
 * while staying under `maxInFlight` scheduled Jobs cluster-wide — the cap is
 * what spreads the first nightly wave instead of a 75-Job stampede. Then
 * trims each env's scheduled dumps to its retention. A tenant that already
 * has a dump in flight is skipped quietly and retried next tick. Per-env
 * failures go to `onError`; one env never aborts the pass.
 */
export async function runBackupScheduleTick(
  envs: readonly BackupEnvSnapshot[],
  deps: RunnerDeps,
  now: Date,
): Promise<{ fired: string[]; deleted: string[] }> {
  const { repo, fire, deleteObject, onError = () => {} } = deps;
  const fired: string[] = [];
  const deleted: string[] = [];
  let budget = deps.maxInFlight - (await repo.countInFlightBySource("SCHEDULED"));

  for (const env of envs) {
    const schedule = env.backupSchedule ?? DEFAULT_SCHEDULE;
    try {
      if (schedule.enabled && budget > 0) {
        const last = await repo.lastRequestedAt(env.tenantId, "SCHEDULED");
        if (!last || now.getTime() >= last.getTime() + CADENCE_MS[schedule.cadence]) {
          try {
            await fire({
              documentId: env.documentId,
              tenantId: env.tenantId,
              requestedBy: "scheduler",
              source: "SCHEDULED",
            });
            fired.push(env.documentId);
            budget--;
          } catch (err) {
            if (!(err instanceof Error && err.message === "DUMP_IN_PROGRESS")) throw err;
          }
        }
      }
      deleted.push(
        ...(await applyRetention(repo, deleteObject, env.tenantId, "SCHEDULED", schedule.retention)),
      );
    } catch (err) {
      onError(env, err);
    }
  }
  return { fired, deleted };
}
