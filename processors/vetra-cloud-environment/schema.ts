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
  /**
   * Document id of the Vetra Studio that produced this environment (deployed
   * a package into it). Mirrors doc state's `studioInstanceId`. NULL = the
   * studio itself, or an environment created directly by the user. Read by the
   * observability subgraph's `myEnvironments` resolver to group environments
   * under their studio.
   */
  studioInstanceId: string | null;
  /**
   * Warm-pool tracking (NULL for ordinary, non-pool environments).
   * Written by the studio-pool-keeper service and the claim subgraph.
   * WARMING | AVAILABLE | CLAIMED | FAILED.
   */
  poolState: string | null;
  /** Lowercased EthereumAddress of the caller who claimed this warm env. */
  claimedBy: string | null;
  /** ISO timestamp when the env was claimed. */
  claimedAt: string | null;
  /** vetra-cli version the warm env was built with (for version-drift recycling). */
  pinnedVersion: string | null;
}

export interface DB {
  environments: Environments;
}
