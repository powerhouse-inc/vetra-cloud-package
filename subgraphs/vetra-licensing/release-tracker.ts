import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { AppDocView } from "./app-reads.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments } from "./db/schema.js";
import { NOT_APPLICABLE } from "./environments.js";
import type { RolloutStore } from "./rollout-db.js";
import { observe, updateOutcome } from "./update-outcome.js";

export interface ReleaseTrackerDeps {
  store: RolloutStore;
  envState(environmentId: string): Promise<VetraCloudEnvironmentState | null>;
  cfg: Pick<LicensingConfig, "updateTimeoutMs">;
  logger: Pick<Console, "info" | "warn">;
  now(): string;
}

/**
 * The handler's afterChains release work for one app (spec 4.3). `rows` must
 * be ALL of the app's license_environments rows (the handler's full `forApp`
 * read): an open update whose environment has no live row in it (ended, or
 * deleted) is closed as SUPERSEDED first, so a partial list would close live
 * customers' updates. A closed update is not settled, pauses nothing and
 * does not hold a rollout open. Then it settles the live APPLYING updates
 * (a failure pauses the rollout, naming the environment), then completes
 * each ACTIVE rollout that has no PENDING or APPLYING update left, once
 * LATEST points at its version and every live customer environment meets
 * its template (an environment the keeper has not visited since the
 * promotion has no update yet, but is behind). One the keeper cannot
 * provision now (no document, or asleep or going away) does not hold it
 * open.
 *
 * A resumed update whose environment already runs its version (its
 * deployment failed after the version was set: phase 1 does not revert) is
 * never moved again, as its environment meets the template; it succeeds once
 * that environment is READY again.
 *
 * A row leaves SUCCEEDED with no error (a stranded one it carried while it
 * waited included). Only the run whose write moved a row logs it, or pauses
 * its rollout: another writer may have moved it first.
 */
/**
 * Whether the keeper could move any of these environments now: one whose
 * document is missing, or whose status provisionChain refuses (asleep,
 * going away), is not waited for.
 */
async function anyProvisionable(
  deps: ReleaseTrackerDeps,
  rows: LicenseEnvironments[],
): Promise<boolean> {
  for (const r of rows) {
    const state = await deps.envState(r.environment_id);
    if (state && !NOT_APPLICABLE.has(state.status)) return true;
  }
  return false;
}

export async function trackReleases(
  deps: ReleaseTrackerDeps,
  app: AppDocView,
  rows: LicenseEnvironments[],
): Promise<void> {
  const now = deps.now();
  const live = new Set(
    rows.filter((r) => r.ended_at === null).map((r) => r.environment_id),
  );
  const isLive = (u: { environment_id: string }) => live.has(u.environment_id);
  const applying = await deps.store.applyingOf(app.id);
  const pending = await deps.store.pendingOf(app.id);
  for (const u of [...applying, ...pending].filter((x) => !isLive(x))) {
    const closed = await deps.store.transitionUpdate(
      u.id,
      ["PENDING", "APPLYING"],
      { status: "SUPERSEDED", finished_at: now, error: "environment ended" },
    );
    if (closed) {
      deps.logger.info(
        `[licensing] update of environment ${u.environment_id} of app ${app.id} to FUSION ${u.to_version} is closed: the environment ended`,
      );
    }
  }

  for (const u of applying.filter(isLive)) {
    const outcome = updateOutcome(
      u,
      observe(await deps.envState(u.environment_id)),
      now,
      deps.cfg.updateTimeoutMs,
    );
    if (!outcome) continue;
    // False: another writer moved the row first (the gate released or
    // superseded it, or an overlapping run settled it); it is theirs.
    if (
      !(await deps.store.finishUpdate(u.id, outcome.status, outcome.error, now))
    )
      continue;
    if (outcome.status === "SUCCEEDED") {
      deps.logger.info(
        `[licensing] environment ${u.environment_id} of app ${app.id} runs FUSION ${u.to_version}`,
      );
      continue;
    }
    deps.logger.warn(
      `[licensing] update of environment ${u.environment_id} to FUSION ${u.to_version} failed: ${outcome.error}`,
    );
    if (
      u.rollout_id &&
      (await deps.store.pause(
        u.rollout_id,
        `environment ${u.environment_id}: ${outcome.error}`,
        now,
      ))
    ) {
      deps.logger.warn(
        `[licensing] rollout ${u.rollout_id} of app ${app.id} is paused until the publisher resumes it`,
      );
    }
  }

  const templateHashes = new Map(
    app.templates
      .filter((t) => t.mode === "DEDICATED")
      .map((t) => [t.id, t.templateHash]),
  );
  const isBehind = (r: LicenseEnvironments) =>
    r.template_id !== null &&
    templateHashes.has(r.template_id) &&
    templateHashes.get(r.template_id) !== r.template_hash;
  const met = new Set(
    rows
      .filter((r) => r.ended_at === null && !isBehind(r))
      .map((r) => r.environment_id),
  );
  // Read before the APPLYING loop, which moves no PENDING row.
  for (const u of pending) {
    if (!met.has(u.environment_id)) continue;
    const env = observe(await deps.envState(u.environment_id));
    if (env?.fusionVersion !== u.to_version || env.status !== "READY") continue;
    if (
      !(await deps.store.finishUpdate(u.id, "SUCCEEDED", null, now, "PENDING"))
    )
      continue;
    deps.logger.info(
      `[licensing] environment ${u.environment_id} of app ${app.id} runs FUSION ${u.to_version}`,
    );
  }

  const behind = rows.filter(
    (r) =>
      r.ended_at === null &&
      (r.channel_override ?? null) === null &&
      isBehind(r),
  );
  // Read once, and only when a rollout could otherwise complete.
  let waitsForBehind: Promise<boolean> | undefined;
  for (const r of await deps.store.activeRollouts(app.id)) {
    const latest = app.artifacts
      .find((a) => a.kind === "FUSION_IMAGE" && a.name === r.artifact_name)
      ?.channels.find((c) => c.channel === "LATEST")?.version;
    if (latest !== r.version || (await deps.store.openCount(r.id)) > 0)
      continue;
    if (await (waitsForBehind ??= anyProvisionable(deps, behind))) continue;
    if (!(await deps.store.complete(r.id))) continue;
    deps.logger.info(
      `[licensing] rollout ${r.id} of app ${app.id} (${r.artifact_name} ${r.version}) is complete`,
    );
  }
}
