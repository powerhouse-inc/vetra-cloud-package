import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import type { AppDocView } from "./app-reads.js";
import type { LicensingConfig } from "./config.js";
import type { LicenseEnvironments } from "./db/schema.js";
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
 * The handler's afterChains release work for one app (spec 4.3): settles its
 * APPLYING updates (a failure pauses the rollout, naming the environment),
 * then completes each ACTIVE rollout that has no PENDING or APPLYING update
 * left, once LATEST points at its version and every live customer
 * environment meets its template (an environment the keeper has not visited
 * since the promotion has no update yet, but is behind).
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
export async function trackReleases(
  deps: ReleaseTrackerDeps,
  app: AppDocView,
  rows: LicenseEnvironments[],
): Promise<void> {
  const now = deps.now();
  for (const u of await deps.store.applyingOf(app.id)) {
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
    rows.filter((r) => !isBehind(r)).map((r) => r.environment_id),
  );
  for (const u of await deps.store.pendingOf(app.id)) {
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

  if (
    rows.some(
      (r) =>
        r.ended_at === null &&
        (r.channel_override ?? null) === null &&
        isBehind(r),
    )
  )
    return;
  for (const r of await deps.store.activeRollouts(app.id)) {
    const latest = app.artifacts
      .find((a) => a.kind === "FUSION_IMAGE" && a.name === r.artifact_name)
      ?.channels.find((c) => c.channel === "LATEST")?.version;
    if (latest !== r.version || (await deps.store.openCount(r.id)) > 0)
      continue;
    if (!(await deps.store.complete(r.id))) continue;
    deps.logger.info(
      `[licensing] rollout ${r.id} of app ${app.id} (${r.artifact_name} ${r.version}) is complete`,
    );
  }
}
