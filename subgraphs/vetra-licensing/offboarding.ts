import type { Kysely } from "kysely";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments, VetraLicensingDB } from "./db/schema.js";
import type { ChainEnvRows } from "./environments.js";

export const EXPIRY_WARNING_DAYS = 7;
export const STOP_AFTER_DAYS = 14;
export const FINAL_WARNING_AFTER_DAYS = 83;
export const DESTROY_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

export function offboardingAction(
  env: { endedAt: string | null; stoppedAt: string | null; deleteAfter: string | null },
  now: string,
): "none" | "stop" | "destroy" {
  if (!env.endedAt) return "none";
  if (env.deleteAfter && now >= env.deleteAfter) return "destroy";
  if (!env.stoppedAt && now >= addDays(env.endedAt, STOP_AFTER_DAYS)) return "stop";
  return "none";
}

export interface SubscriptionWarning {
  kind: "EXPIRING" | "ENDED_STOP_PENDING" | "STOPPED_DELETE_PENDING" | "DELETE_IMMINENT";
  at: string;
  message: string;
}

const day = (iso: string) => iso.slice(0, 10);

/** Banners for vetra.io. Computed on read; email is out of scope. */
export function subscriptionWarnings(
  input: {
    status: string;
    end: string | null;
    mode: "SHARED" | "DEDICATED";
    endedAt: string | null;
    stoppedAt: string | null;
    deleteAfter: string | null;
  },
  now: string,
): SubscriptionWarning[] {
  const out: SubscriptionWarning[] = [];
  // Stopped by us, or by the holder (stopped_at unset): either way, once the
  // stop time has passed the environment is down and deletion is what is coming.
  const stopPassed =
    input.endedAt !== null && Date.parse(now) >= Date.parse(addDays(input.endedAt, STOP_AFTER_DAYS));
  if (
    input.mode === "DEDICATED" &&
    input.endedAt &&
    input.deleteAfter &&
    (input.stoppedAt || stopPassed)
  ) {
    const imminent = now >= addDays(input.deleteAfter, -(DESTROY_AFTER_DAYS - FINAL_WARNING_AFTER_DAYS));
    out.push(
      imminent
        ? {
            kind: "DELETE_IMMINENT",
            at: input.deleteAfter,
            message: `Your stopped environment will be deleted on ${day(input.deleteAfter)}.`,
          }
        : {
            kind: "STOPPED_DELETE_PENDING",
            at: input.deleteAfter,
            message: `Your environment is stopped; its data is deleted on ${day(input.deleteAfter)}. Renew your licence to bring it back.`,
          },
    );
  } else if (input.mode === "DEDICATED" && input.endedAt) {
    const stop = addDays(input.endedAt, STOP_AFTER_DAYS);
    // Once the stop time has passed the stop is imminent or done; no banner
    // promises a date in the past.
    if (now < stop) out.push({
      kind: "ENDED_STOP_PENDING",
      at: stop,
      message: `Your environment stops on ${day(stop)}. Renew to keep it running.`,
    });
  }
  // `end` may be date-only or carry an offset: compare instants, not strings.
  const endMs = input.end === null ? Number.NaN : Date.parse(input.end);
  const nowMs = Date.parse(now);
  if (
    input.status === "ACTIVE" &&
    !Number.isNaN(endMs) &&
    nowMs < endMs &&
    nowMs >= endMs - EXPIRY_WARNING_DAYS * DAY_MS
  ) {
    const days = Math.ceil((endMs - nowMs) / DAY_MS);
    out.push({
      kind: "EXPIRING",
      at: new Date(endMs).toISOString(),
      message: `Your licence expires in ${days} ${days === 1 ? "day" : "days"}.`,
    });
  }
  return out;
}

export interface OffboardingDeps {
  rows: ChainEnvRows;
  envStatus(environmentId: string): Promise<string | null>;
  sleep(environmentId: string): Promise<void>;
  wake(environmentId: string): Promise<void>;
  /** Hard delete of the environment document (gitops + namespace teardown follow). */
  destroy(environmentId: string): Promise<void>;
  cfg: Pick<LicensingConfig, "destroyEnabled">;
  logger: Pick<Console, "info" | "warn">;
  now(): string;
}

// "DEPLOYMENt_FAILED" is the environment model's own (misspelt) status value.
const SLEEPABLE = new Set(["READY", "DEPLOYMENt_FAILED"]);

/**
 * Called only when the lifecycle record says the chain ended. Idempotent: a
 * repeat never moves the deletion date out.
 */
export async function markEnded(deps: OffboardingDeps, environmentId: string): Promise<void> {
  const row = await deps.rows.byEnvironment(environmentId);
  if (!row || row.ended_at) return;
  const now = deps.now();
  await deps.rows.update(environmentId, {
    ended_at: now,
    delete_after: addDays(now, DESTROY_AFTER_DAYS),
    updated_at: now,
  });
}

/**
 * Re-licensing the same chain before deletion brings the environment back.
 * Only an environment offboarding stopped (stopped_at set) is woken; one the
 * holder stopped themselves stays as they left it.
 */
export async function markResumed(deps: OffboardingDeps, environmentId: string): Promise<void> {
  const row = await deps.rows.byEnvironment(environmentId);
  if (!row) return;
  if (row.stopped_at && (await deps.envStatus(environmentId)) === "STOPPED") {
    await deps.wake(environmentId);
  }
  await deps.rows.update(environmentId, {
    ended_at: null,
    stopped_at: null,
    delete_after: null,
    updated_at: deps.now(),
  });
}

/** Repeated per-tick messages are logged once per distinct text. */
const logged = new WeakMap<object, Set<string>>();
function infoOnce(deps: OffboardingDeps, message: string): void {
  let seen = logged.get(deps);
  if (!seen) logged.set(deps, (seen = new Set()));
  if (seen.has(message)) return;
  seen.add(message);
  deps.logger.info(message);
}

/**
 * The rows the clock may act on: ended AND confirmed ended by the handler this
 * tick. Every other ended row is frozen (neither stopped nor destroyed).
 */
export function confirmedEndedRows(
  rows: LicenseEnvironments[],
  confirmedEndedRoots: ReadonlySet<string>,
): LicenseEnvironments[] {
  return rows.filter((r) => r.ended_at !== null && confirmedEndedRoots.has(r.root_license_id));
}

export async function tickOffboarding(deps: OffboardingDeps, rows: LicenseEnvironments[]): Promise<void> {
  for (const row of rows) {
    const id = row.environment_id;
    try {
      // Only an ended chain is ever stopped or destroyed.
      if (!row.ended_at) continue;
      const action = offboardingAction(
        { endedAt: row.ended_at, stoppedAt: row.stopped_at, deleteAfter: row.delete_after },
        deps.now(),
      );
      const status = await deps.envStatus(id);
      if (action === "destroy") {
        if (!deps.cfg.destroyEnabled) {
          infoOnce(
            deps,
            `[licensing] would destroy ${id} (ended ${row.ended_at}); LICENSING_DESTROY_ENABLED is off`,
          );
          continue;
        }
        if (status !== null) await deps.destroy(id);
        await deps.rows.remove(id);
        deps.logger.info(`[licensing] destroyed ${id}, ${DESTROY_AFTER_DAYS} days after its licence ended`);
        continue;
      }
      const shouldBeDown = action === "stop" || row.stopped_at !== null;
      if (!shouldBeDown) continue;
      if (status === null || !SLEEPABLE.has(status)) continue; // gone, already down, or mid-transition
      await deps.sleep(id);
      // Stamped only when offboarding itself put it to sleep: an environment
      // the holder stopped is theirs, and markResumed must never wake it.
      if (!row.stopped_at) await deps.rows.update(id, { stopped_at: deps.now(), updated_at: deps.now() });
    } catch (err) {
      deps.logger.warn(`[licensing] offboarding of ${id} failed: ${String(err)}`);
    }
  }
}

const UNDEFINED_TABLE = "42P01";

/** For housekeeping's public wake: never undo a licence stop. */
export async function isLicenceStopped(db: Kysely<VetraLicensingDB>, environmentId: string): Promise<boolean> {
  try {
    const row = await db
      .selectFrom("license_environments")
      .select(["stopped_at", "ended_at"])
      .where("environment_id", "=", environmentId)
      .executeTakeFirst();
    return Boolean(row?.stopped_at && row.ended_at);
  } catch (err) {
    // Licensing has not migrated in this deployment: nothing can be licence-stopped.
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return false;
    throw err;
  }
}
