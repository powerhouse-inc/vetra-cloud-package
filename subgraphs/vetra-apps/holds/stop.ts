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

/**
 * VETRA_STOP_KEEPS_DATABASE (default off): licensing offboarding and
 * housekeeping stop a database-backed environment by a hold instead of a
 * sleep. A sleep (STOPPED, global.disabled) removes the CNPG cluster, and CNPG
 * deletes the database with it.
 */
export function stopKeepsDatabase(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return ON.has((env.VETRA_STOP_KEEPS_DATABASE ?? "").trim().toLowerCase());
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
 * to lose). A stopper only ever releases holds with its own reason, never a
 * switch-over's or a plan instance's.
 */
export function createEnvironmentStopper(
  deps: HoldDeps,
  opts: { keepsDatabase: boolean; reason: string },
): EnvironmentStopper {
  const ownHold = async (id: string) => {
    let hold;
    try {
      hold = await getHold(deps.db, id);
    } catch (err) {
      // vetra-apps has not created the holds table yet: nothing is held.
      if ((err as { code?: unknown } | null)?.code === "42P01") return false;
      throw err;
    }
    return (
      !!hold && hold.switchover_id === null && hold.reason === opts.reason
    );
  };
  return {
    async stop(id) {
      if (opts.keepsDatabase) {
        const state = await deps.envs.getState(id);
        if (!state) return "skipped";
        if (databaseBacked(state)) {
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
    isStopped: ownHold,
  };
}
