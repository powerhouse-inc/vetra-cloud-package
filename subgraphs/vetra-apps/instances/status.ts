import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";

/** A host runs its migrations before it serves: allow minutes. */
export const UPDATE_TIMEOUT_MS = 20 * 60 * 1000;

export type Observation =
  | { kind: "ready" }
  | { kind: "updating" }
  | { kind: "stopped" }
  | { kind: "failed"; reason: string };

const GONE = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

/**
 * What the environment's state says about its instance. Interim health
 * (until releases phase 2 slice 3): READY and running the target tag
 * (`<version>@<digest>`), spec section 6 step 3.
 */
export function observeEnvironment(
  state: VetraCloudEnvironmentState,
  targetTag: string,
  updateStartedAt: string | null,
  now: Date,
): Observation {
  if (state.status === "STOPPED") return { kind: "stopped" };
  if (GONE.has(state.status))
    return { kind: "failed", reason: `the environment is ${state.status}` };
  const version =
    state.services.find((s) => s.type === "FUSION")?.version ?? null;
  if (version === targetTag) {
    if (state.status === "READY") return { kind: "ready" };
    // Definite outcome for this rollout; a failure left on an old tag is not.
    if (state.status === "DEPLOYMENt_FAILED")
      return { kind: "failed", reason: "the deployment failed" };
  }
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
