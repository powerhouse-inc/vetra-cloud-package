import {
  sleepEnvironment,
  wakeEnvironment,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { isFusionHost } from "../../../processors/vetra-cloud-environment/gitops.js";
import { AUDIT_SYSTEM_ACTOR } from "../audit/repo.js";
import { getHold } from "./repo.js";
import { holdEnvironment, releaseHold, type HoldDeps } from "./service.js";

const ON = new Set(["on", "true", "1", "yes"]);

function switchedOn(
  name: string,
  env: Record<string, string | undefined>,
): boolean {
  return ON.has((env[name] ?? "").trim().toLowerCase());
}

/**
 * VETRA_OFFBOARDING_KEEPS_DATABASE (default off): licensing offboarding stops
 * a database-backed environment by a hold instead of a sleep. A sleep
 * (STOPPED, global.disabled) removes the CNPG cluster, and CNPG deletes the
 * database with it.
 */
export function offboardingKeepsDatabase(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return switchedOn("VETRA_OFFBOARDING_KEEPS_DATABASE", env);
}

/**
 * VETRA_HOUSEKEEPING_KEEPS_DATABASE (default off): housekeeping stops an idle
 * database-backed environment by a hold instead of a sleep. CLINT studios
 * still sleep (the chart cannot scale clint down), so today this only reaches
 * a database-backed environment without CLINT.
 */
export function housekeepingKeepsDatabase(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return switchedOn("VETRA_HOUSEKEEPING_KEEPS_DATABASE", env);
}

/** Whether the environment runs an enabled CLINT agent. */
export function runsClint(state: VetraCloudEnvironmentState): boolean {
  return (state.services ?? []).some((s) => s.type === "CLINT" && s.enabled);
}

/**
 * Whether the processor renders the tenant database for this environment
 * (gitops.ts `databaseEnabled`): a FUSION host, or a platform switchboard.
 */
export function databaseBacked(state: VetraCloudEnvironmentState): boolean {
  return (
    isFusionHost(state) ||
    (state.services ?? []).some((s) => s.type === "SWITCHBOARD" && s.enabled)
  );
}

export interface EnvironmentStopper {
  /**
   * Stops an environment the caller found stoppable (callers keep their own
   * status guards: a sleep is accepted only from READY or DEPLOYMENt_FAILED).
   */
  stop(environmentId: string): Promise<"held" | "slept" | "skipped">;
  /** Undoes this stopper's stop: releases its hold, or wakes a sleep. */
  resume(environmentId: string): Promise<"released" | "woken" | "none">;
  /** Held by this stopper (its reason, no switch-over). */
  isStopped(environmentId: string): Promise<boolean>;
}

/**
 * One caller's way of stopping environments. With `keepsDatabase` off it
 * sleeps, exactly as before. On, a database-backed environment is held (its
 * database, backups and volumes kept) and any other one still sleeps (nothing
 * to lose), as does a CLINT one when `sleepsClint` is set. A stopper only ever releases holds with its own reason, never a
 * switch-over's or a plan instance's.
 */
export function createEnvironmentStopper(
  deps: HoldDeps,
  opts: {
    keepsDatabase: boolean;
    reason: string;
    /**
     * Sleeps a CLINT environment even when it has a database: the chart's
     * clint Deployment has a fixed replica count, so a hold would leave the
     * agent (and its apex ingress) running.
     */
    sleepsClint?: boolean;
  },
): EnvironmentStopper {
  const holdOf = async (id: string) => {
    try {
      return await getHold(deps.db, id);
    } catch (err) {
      // vetra-apps has not created the holds table yet: nothing is held.
      if ((err as { code?: unknown } | null)?.code === "42P01") return null;
      throw err;
    }
  };
  const ownHold = async (id: string) => {
    const hold = await holdOf(id);
    return (
      !!hold && hold.switchover_id === null && hold.reason === opts.reason
    );
  };
  return {
    async stop(id) {
      if (opts.keepsDatabase) {
        // Already held: ours is in place, and another's (a switch-over, a
        // plan instance) is left as it is; never slept (that would delete
        // the database the hold keeps).
        const existing = await holdOf(id);
        if (existing)
          return existing.switchover_id === null &&
            existing.reason === opts.reason
            ? "held"
            : "skipped";
        const state = await deps.envs.getState(id);
        if (!state) return "skipped";
        if (
          databaseBacked(state) &&
          !(opts.sleepsClint && runsClint(state))
        ) {
          await holdEnvironment(deps, {
            environmentId: id,
            reason: opts.reason,
            switchoverId: null,
            by: AUDIT_SYSTEM_ACTOR,
          });
          return "held";
        }
      }
      await deps.envs.execute(id, [sleepEnvironment({})]);
      return "slept";
    },
    async resume(id) {
      if (await ownHold(id)) {
        await releaseHold(deps, id);
        return "released";
      }
      const state = await deps.envs.getState(id);
      if (state?.status !== "STOPPED") return "none";
      await deps.envs.execute(id, [wakeEnvironment({})]);
      return "woken";
    },
    // Switch off: no hold of ours is expected, so no lookup (every tick).
    isStopped: async (id) => (opts.keepsDatabase ? ownHold(id) : false),
  };
}
