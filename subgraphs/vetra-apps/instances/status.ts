import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";

/** A host runs its migrations before it serves: allow minutes. */
export const UPDATE_TIMEOUT_MS = 20 * 60 * 1000;

export type Observation =
  | { kind: "ready" }
  /** reason: why an update past its timeout is still waiting. */
  | { kind: "updating"; reason?: string }
  | { kind: "stopped" }
  | { kind: "degraded"; reason: string }
  | { kind: "failed"; reason: string }
  /** Nothing new to say (health stale, unknown, or not settled): keep the status. */
  | { kind: "unchanged" };

const GONE = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

/**
 * What the environment's state says about its instance. Interim health
 * (until releases phase 2 slice 3): READY and running the target tag
 * (`<version>@<digest>`), spec section 6 step 3. `runsTarget`: the instance
 * already ran the target (running = target digest), so anything short of
 * READY is a restart (owner stop/start, a wake, a failed-deployment blip):
 * "updating" until it recovers, never timed out against the old start.
 */
export function observeEnvironment(
  state: VetraCloudEnvironmentState,
  targetTag: string,
  updateStartedAt: string | null,
  now: Date,
  runsTarget = false,
): Observation {
  if (state.status === "STOPPED") return { kind: "stopped" };
  if (GONE.has(state.status))
    return { kind: "failed", reason: `the environment is ${state.status}` };
  const version =
    state.services.find((s) => s.type === "FUSION")?.version ?? null;
  // NOTE: document READY is not proof of a deployment (Argo can fail to render
  // while the document stays READY); the state has no health field yet, real
  // health arrives with slice 3 (14.7).
  if (version === targetTag && state.status === "READY")
    return { kind: "ready" };
  if (runsTarget) return { kind: "updating" };
  // Definite outcome for this rollout; a failure left on an old tag is not.
  if (version === targetTag && state.status === "DEPLOYMENt_FAILED")
    return { kind: "failed", reason: "the deployment failed" };
  // The reconciler always records a start time; without a usable one (missing
  // or unparseable) an unknown status stays "updating", never "ready".
  const startedMs = updateStartedAt ? Date.parse(updateStartedAt) : Number.NaN;
  if (
    Number.isFinite(startedMs) &&
    now.getTime() - startedMs > UPDATE_TIMEOUT_MS
  )
    return { kind: "failed", reason: "not ready after 20 minutes" };
  return { kind: "updating" };
}

/** Healthy this long before ready: longer than the chart's liveness delay (60 s) plus three periods, so a crash loop never looks stable. */
export const HEALTH_STABLE_MS = 120_000;
/** A steady instance not healthy this long is degraded. */
export const DEGRADED_AFTER_MS = 60_000;
/** An update is failed only after at least two checks agree (checks run every 30 s). */
export const CONFIRM_MS = 30_000;
/** Older checks are not evidence (the monitor stopped, or the budget skipped this instance). */
export const HEALTH_STALE_MS = 180_000;

export interface HealthView {
  health: "healthy" | "unhealthy" | "unknown" | null;
  check: string | null;
  reason: string | null;
  checkedAt: string | null;
  since: string | null;
  digest: string | null;
  observedDigest: string | null;
}

export const healthView = (r: {
  health: HealthView["health"];
  health_check: string | null;
  health_reason: string | null;
  health_checked_at: string | null;
  health_since: string | null;
  health_digest: string | null;
  observed_digest: string | null;
}): HealthView => ({
  health: r.health,
  check: r.health_check,
  reason: r.health_reason,
  checkedAt: r.health_checked_at,
  since: r.health_since,
  digest: r.health_digest,
  observedDigest: r.observed_digest,
});

const msOf = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * Spec 6 step 3 with 14.7's health: ready = healthy (stable) on the target
 * digest; an update unhealthy past the window fails (the reconciler reverts);
 * an instance that ran the target healthy and is not healthy now is degraded
 * (never reverted). The document's status only decides stopped and gone.
 */
export function observeHealth(
  state: VetraCloudEnvironmentState,
  target: { tag: string; digest: string },
  row: {
    update_started_at: string | null;
    running_digest: string | null;
    status?: string;
  },
  h: HealthView,
  now: Date,
  unhealthyWindowMs: number,
): Observation {
  if (state.status === "STOPPED") return { kind: "stopped" };
  if (GONE.has(state.status))
    return { kind: "failed", reason: `the environment is ${state.status}` };
  const t = now.getTime();
  const inFlight = row.running_digest !== target.digest;
  const started = msOf(row.update_started_at);
  const checked = msOf(h.checkedAt);
  const onTarget =
    (state.services.find((s) => s.type === "FUSION")?.version ?? null) ===
    target.tag;
  const fresh =
    h.health !== null &&
    onTarget &&
    h.digest === target.digest &&
    t - checked <= HEALTH_STALE_MS &&
    (!inFlight || !Number.isFinite(started) || checked > started);
  const label = h.check
    ? `${h.check}: ${h.reason ?? h.health}`
    : String(h.health);

  if (fresh) {
    // Observed, not wall-clock: how long checks have agreed (the monitor
    // restarts since whenever the health value changes), so one check
    // followed by silence never satisfies a window.
    const since = Number.isFinite(msOf(h.since)) ? msOf(h.since) : checked;
    const forMs = checked - since;
    if (
      h.health === "healthy" &&
      h.observedDigest === target.digest &&
      forMs >= HEALTH_STABLE_MS
    )
      return { kind: "ready" };
    if (
      inFlight &&
      h.health === "unhealthy" &&
      Number.isFinite(started) &&
      t - started >= unhealthyWindowMs &&
      forMs >= CONFIRM_MS
    )
      return { kind: "failed", reason: `unhealthy (${label})` };
    if (
      !inFlight &&
      h.health !== "healthy" &&
      h.check !== "data" &&
      h.check !== "stopped" &&
      forMs >= DEGRADED_AFTER_MS
    )
      return { kind: "degraded", reason: label };
  }
  if (!inFlight && row.status === "stopped") {
    // Started again (the document is no longer STOPPED): never left "stopped".
    // Without health to go by, the document's rule; with undecided health, starting.
    if (!fresh || h.check === "data")
      return observeEnvironment(
        state,
        target.tag,
        row.update_started_at,
        now,
        true,
      );
    return { kind: "updating" };
  }
  if (!inFlight) return { kind: "unchanged" };
  // The reconciler always records a start time; without one an update never times out (as observeEnvironment).
  if (Number.isFinite(started) && t - started > UPDATE_TIMEOUT_MS) {
    // No recent check, or one that had no cluster data: the monitor or
    // observability is down, which says nothing about the update. Never
    // fail (and revert) on silence; keep waiting and say why.
    const noData =
      h.health === null ||
      !Number.isFinite(checked) ||
      t - checked > HEALTH_STALE_MS ||
      h.check === "data";
    if (noData)
      return {
        kind: "updating",
        reason:
          "not healthy after 20 minutes, but there is no fresh health data; waiting for it",
      };
    return {
      kind: "failed",
      reason:
        fresh && h.health !== "healthy"
          ? `not healthy after 20 minutes (${label})`
          : "not healthy after 20 minutes",
    };
  }
  return { kind: "updating" };
}
