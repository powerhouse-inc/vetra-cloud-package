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
 * Semantics:
 *  - Unowned env + user-signed action: **auto-claim** — set state.owner to the
 *    signer's address. Matches the "unowned = open to the first toucher" rule
 *    and saves users from needing a separate SET_OWNER click.
 *  - Unowned env + system-signed action (no signer.user): pass, do not claim.
 *    Lets the deployment-reconciler / processor dispatch status transitions
 *    on orphan envs without accidentally claiming them on behalf of nobody.
 *  - Owned env + system-signed action: pass (bypass).
 *  - Owned env + user-signed action: signer.user.address.toLowerCase() must
 *    equal state.owner, else NotOwnerError.
 *
 * Mutates state.owner when auto-claiming (the reducers that call this run
 * inside mutative's Draft wrapper, so direct assignment is correct).
 */
export function assertOwner(
  state: { owner: string | null | undefined },
  action: MaybeSigner,
) {
  const userAddr = action.context?.signer?.user?.address?.toLowerCase();

  if (!state.owner) {
    // Auto-claim only for user-signed actions; system actions pass through.
    if (userAddr) state.owner = userAddr;
    return;
  }

  // Owned env. System-signed actions (app-only signer, no user) bypass.
  if (!userAddr) return;
  if (userAddr !== state.owner) {
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
