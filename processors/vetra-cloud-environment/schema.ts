export interface Environments {
  id: string;
  name: string | null;
  subdomain: string | null;
  tenantId: string | null;
  customDomain: string | null;
  packages: string | null;
  services: string | null;
  status: string | null;
  deployingSince: string | null;
  /** EthereumAddress (lowercased) of the user who first signed an action on this document. */
  createdBy: string | null;
  /**
   * EthereumAddress (lowercased) read from document state's `owner` field.
   * Set when the user (or backfill) dispatches SET_OWNER on the document.
   * Used by `myEnvironments` resolver to scope listings per-user.
   */
  owner: string | null;
  /**
   * Release channel the environment is subscribed to for auto-updates
   * (DEV, STAGING, LATEST, or null for off). Mirrors doc state's
   * `autoUpdateChannel`. The observability subgraph's
   * `notifyNewImageRelease` mutation reads this column to find the envs
   * that should receive a new image tag when a release lands.
   */
  autoUpdateChannel: string | null;
}

/**
 * Per-(environment, prefix) bearer token for the clint announcement
 * URL. The processor mints one when it first emits the pod spec for a
 * CLINT service; the agent reads it from its env (mounted by the chart
 * from a k8s Secret) and includes it in announcement requests. The
 * observability subgraph validates incoming announcements against this
 * row.
 *
 * Token rotation: delete the row to force regeneration on next sync.
 */
export interface ClintAnnounceTokens {
  /** `${documentId}|${prefix}` — composite key. */
  id: string;
  documentId: string;
  prefix: string;
  /** Random 32-byte token, base64url-encoded. */
  token: string;
  createdAt: string;
}

export interface DB {
  environments: Environments;
  clint_announce_tokens: ClintAnnounceTokens;
}
