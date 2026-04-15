import { NotOwnerError } from "../../gen/data-management/error.js";

type MaybeSigner = {
  context?: {
    signer?: {
      user?: { address?: string | null } | null;
    } | null;
  };
};

/**
 * Owner gate for user-facing mutations.
 *
 * - Unowned envs (state.owner == null): pass (backward compat for pre-owner docs).
 * - System-signed actions (no signer.user.address): pass. Required because the
 *   processor / observability subgraph dispatches status transitions on behalf
 *   of environments they don't "own".
 * - User-signed actions: signer.user.address.toLowerCase() must equal state.owner.
 *
 * Throws NotOwnerError if a user-signed action is from a non-owner.
 */
export function assertOwner(
  state: { owner: string | null | undefined },
  action: MaybeSigner,
) {
  if (!state.owner) return;
  const userAddr = action.context?.signer?.user?.address;
  // System-signed actions (app-only signer, no user) bypass.
  if (!userAddr) return;
  if (userAddr.toLowerCase() !== state.owner) {
    throw new NotOwnerError(
      `Signer ${userAddr} is not the owner of this environment`,
    );
  }
}

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
