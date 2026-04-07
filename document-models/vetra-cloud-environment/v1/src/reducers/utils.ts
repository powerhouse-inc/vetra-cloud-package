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

const LB_IP = "138.199.129.93";

/**
 * Regenerate custom domain DNS records based on currently enabled services.
 * Call this whenever services change to keep DNS records in sync.
 */
export function regenerateDnsRecords(state: {
  customDomain?: {
    enabled: boolean;
    domain?: string | null;
    dnsRecords: Array<{ type: string; host: string; value: string }>;
  } | null;
  services: Array<{ type: string; prefix: string; enabled: boolean }>;
}) {
  if (!state.customDomain?.enabled || !state.customDomain.domain) return;

  const domain = state.customDomain.domain;
  state.customDomain.dnsRecords = state.services
    .filter((s) => s.enabled)
    .map((s) => ({
      type: "A",
      host: `${s.prefix}.${domain}`,
      value: LB_IP,
    }));
}
