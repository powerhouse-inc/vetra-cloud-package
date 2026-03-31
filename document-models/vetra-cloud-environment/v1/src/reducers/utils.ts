const NO_PENDING_STATUSES = new Set([
  "DRAFT",
  "CHANGES_PENDING",
  "TERMINATING",
  "DESTROYED",
  "ARCHIVED",
  "STOPPED",
]);

/**
 * Transition to CHANGES_PENDING if the environment has been deployed.
 * Statuses like READY, CHANGES_PUSHED, DEPLOYING, DEPLOYMENt_FAILED
 * all indicate a deployed environment where data mutations should
 * trigger a new approve → deploy cycle.
 */
export function markPendingIfDeployed(state: { status: string }) {
  if (!NO_PENDING_STATUSES.has(state.status)) {
    state.status = "CHANGES_PENDING";
  }
}
