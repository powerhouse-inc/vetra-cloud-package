import { randomUUID } from "node:crypto";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments } from "./db/schema.js";
import { decideRelease } from "./release-gate.js";
import type { RolloutStore } from "./rollout-db.js";
import type { FusionMove, FusionVersionMode } from "./template.js";

/** What provisionChain asks before it moves a live environment's FUSION version (spec 4.3). */
export interface UpdateGate {
  /**
   * Decides (decideRelease) and records the update, in one transaction.
   * `updateId` is the update now APPLYING when the version moves.
   */
  admit(q: {
    row: LicenseEnvironments;
    move: FusionMove;
    now: string;
  }): Promise<{
    version: FusionVersionMode;
    updateId: string | null;
  }>;
  /** An admitted update whose actions were never dispatched goes back to PENDING. */
  release(updateId: string): Promise<void>;
}

/**
 * Thrown inside admit's transaction when its start or revive is lost (the
 * row left the status it was read in), to roll the decision back.
 */
class TransitionLostRollback extends Error {
  constructor() {
    super("update transition lost");
  }
}

export function createUpdateGate(deps: {
  store: RolloutStore;
  logger: Pick<Console, "warn">;
  newId?: () => string;
}): UpdateGate {
  const newId = deps.newId ?? randomUUID;
  // Once per version: logged when the error is first written to the update.
  const warnHeld = (
    row: LicenseEnvironments,
    move: FusionMove,
    error: string,
  ) =>
    deps.logger.warn(
      `[licensing] environment ${row.environment_id} of chain ${row.root_license_id} stays on FUSION ${move.from}: ${error}`,
    );
  return {
    admit: async ({ row, move, now }) => {
      // Logged once the transaction has committed the errors they report.
      const held: string[] = [];
      let admitted: Awaited<ReturnType<UpdateGate["admit"]>>;
      try {
        admitted = await deps.store.inTransaction(async (q) => {
          // Before any read: the decision reads "is another update of this app
          // APPLYING" and then writes, so two admissions of one app (the keeper
          // on one chain, the machine API on another) must not interleave.
          await q.lockApp(row.app_id);
          const policy = (await q.settings(row.app_id)).policy;
          const canary = (row.channel_override ?? null) !== null;
          const rolledOut = policy === "GATED" && !canary;
          const rollout =
            rolledOut && move.artifactName
              ? await q.releasedRollout(row.app_id, move.artifactName, move.to)
              : null;
          const existing = rolledOut
            ? rollout
              ? await q.updateFor(rollout.id, row.environment_id)
              : null
            : await q.unrolledUpdate(row.environment_id, move.to);
          const d = decideRelease({
            policy,
            canary,
            move,
            rollout,
            existing,
            open: await q.openExcept(row.environment_id, existing?.id ?? null),
            otherApplying: await q.anotherApplying(
              row.app_id,
              row.environment_id,
            ),
            environmentId: row.environment_id,
            appId: row.app_id,
            newId: newId(),
            now,
          });
          for (const w of d.writes) {
            if (w.kind === "insert") {
              await q.insertUpdate(w.row);
              if (w.row.error) held.push(w.row.error);
            } else if (w.kind === "start") {
              const started = await q.transitionUpdate(w.id, "PENDING", {
                status: "APPLYING",
                started_at: now,
              });
              // The row left PENDING after it was read: it is not moving,
              // and nothing this decision wrote (a supersede) is kept.
              if (!started) throw new TransitionLostRollback();
            } else if (w.kind === "revive") {
              const revived = await q.transitionUpdate(w.id, "SUPERSEDED", {
                status: "PENDING",
                error: null,
                started_at: null,
                finished_at: null,
              });
              // Read as an ended update, now something else: decided on
              // a row that is gone, so nothing of it is kept.
              if (!revived) throw new TransitionLostRollback();
            } else if (w.kind === "supersede") {
              // A lost transition is harmless: the row has already moved on.
              await q.transitionUpdate(w.id, ["PENDING", "APPLYING"], {
                status: "SUPERSEDED",
                finished_at: now,
              });
            } else {
              await q.patchUpdate(w.id, { error: w.error });
              held.push(w.error);
            }
          }
          return { version: d.version, updateId: d.updateId };
        });
      } catch (err) {
        if (err instanceof TransitionLostRollback)
          return { version: "hold", updateId: null };
        throw err;
      }
      for (const error of held) warnHeld(row, move, error);
      return admitted;
    },
    release: async (updateId) => {
      await deps.store.releaseApplying(updateId);
    },
  };
}

/**
 * The gate provisionChain is given: none while the keeper is in dry run
 * (provisionChain then moves FUSION ungated, as before the gate). Dry run
 * applies nothing, so no update could ever settle there: an admission made
 * on the machine API's real provision would stay APPLYING, and hold every
 * other environment of a gated app.
 */
export function activeUpdateGate(
  cfg: Pick<LicensingConfig, "dryRun">,
  gate: UpdateGate,
): UpdateGate | undefined {
  return cfg.dryRun ? undefined : gate;
}
