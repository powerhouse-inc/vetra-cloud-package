import type {
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentStatus,
} from "document-models/vetra-cloud-environment";
import type { EnvironmentUpdates } from "./db/schema.js";

/** "DEPLOYMENt_FAILED" is the environment model's own (misspelt) status value. */
const DEPLOYMENT_FAILED: VetraCloudEnvironmentStatus = "DEPLOYMENt_FAILED";

/** What the tracker reads off an environment document: its status and FUSION version. */
export interface ObservedEnvironment {
  status: string;
  fusionVersion: string | null;
}

export function observe(
  state: VetraCloudEnvironmentState | null,
): ObservedEnvironment | null {
  if (!state) return null;
  return {
    status: state.status,
    fusionVersion:
      state.services.find((s) => s.type === "FUSION")?.version ?? null,
  };
}

export type UpdateOutcome =
  | { status: "SUCCEEDED"; error: null }
  | { status: "FAILED"; error: string };

/**
 * Pure. Where an APPLYING update stands (spec 4.3): SUCCEEDED once the
 * environment is READY on its version; FAILED when that deployment failed,
 * or when it is not READY on it `timeoutMs` after it started (a missing
 * document, a sleep or a stuck rollout included). Otherwise null: still
 * applying. Phase 2 turns FAILED into a recovery; here it only pauses.
 */
export function updateOutcome(
  update: Pick<EnvironmentUpdates, "to_version" | "started_at">,
  env: ObservedEnvironment | null,
  now: string,
  timeoutMs: number,
): UpdateOutcome | null {
  if (env?.fusionVersion === update.to_version) {
    if (env.status === "READY") return { status: "SUCCEEDED", error: null };
    if (env.status === DEPLOYMENT_FAILED) {
      return {
        status: "FAILED",
        error: `the deployment of ${update.to_version} failed`,
      };
    }
  }
  const started =
    update.started_at === null ? Number.NaN : Date.parse(update.started_at);
  if (!Number.isNaN(started) && Date.parse(now) - started > timeoutMs) {
    return {
      status: "FAILED",
      error: `not READY on ${update.to_version} within ${Math.round(timeoutMs / 60_000)} minutes`,
    };
  }
  return null;
}
