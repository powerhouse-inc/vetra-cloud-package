/** Relational tables of the vetra-apps subgraph (namespace "vetra-apps"). */

/** DELETED = soft-deleted: the row (and so its slug + Harbor project name) is kept forever. */
export type AppStatus =
  | "PENDING_IDENTITY"
  | "ACTIVE"
  | "DISCONNECTED"
  | "DELETED";
export type AppDeploymentKind = "PRODUCTION" | "PREVIEW";
/** Who started a deployment (D20); null on rows made before it was recorded. */
export type DeploymentTrigger =
  | "STUDIO_LAUNCH"
  | "STUDIO_ROLLBACK"
  | "OWNER"
  | "CI";
export type AppDeploymentStatus =
  | "PENDING"
  | "DEPLOYING"
  | "READY"
  | "FAILED"
  | "SUPERSEDED";

export interface AppsTable {
  id: string;
  /** Registry namespace (Harbor project) holding this app's images. */
  registry_namespace: string | null;
  slug: string;
  name: string;
  /** Lowercased EthereumAddress of the owner (Renown did:pkh address). */
  owner_address: string;
  owner_chain_id: number;
  status: AppStatus;
  /** GitHub repository of the App; all three null for a Studio product without GitHub (ensureStudioProduct). */
  installation_id: string | null;
  repository_id: string | null;
  repository_full_name: string | null;
  production_branch: string;
  /** JSON array of the branches / patterns besides production_branch that may publish releases (releases/branches.ts); '[]' by default. */
  release_branches?: string;
  /** Whether the reconciler runs this App's instances (releases phase 2; default false). */
  instances_enabled?: boolean;
  production_environment_id: string;
  previews_enabled: boolean;
  preview_limit: number;
  preview_ttl_days: number;
  harbor_project: string;
  harbor_robot_name: string;
  /** Harbor robot id (deleted with the App); NULL for rows created before it was recorded. */
  harbor_robot_id: number | null;
  /** AES-256-GCM ciphertext (VETRA_APPS_ENCRYPTION_KEY) of the robot secret. */
  harbor_robot_secret_enc: string;
  /** The App's Renown workload identity (did:key). */
  identity_did: string;
  /** expirationDate of the owner's delegation credential (null = unknown / never). */
  identity_expires_at: string | null;
  /** Renown organisation owning the App (null: personal). */
  owner_org_id: string | null;
  /** Renown names another publisher than owner_org_id: org members cannot operate the App until the sync reconciles it (m10). */
  org_disputed?: boolean | null;
  /** The Vetra Studio env the App was created from (null: an imported repo). One live App per Studio. */
  studio_environment_id: string | null;
  /** The live product's drive (D21), set once at first launch; null before. */
  product_drive_id?: string | null;
  /** When the product first went live (a version launched); null = never launched. */
  launched_at?: string | null;
  /** When an existing env of the owner was adopted as production (§6.6); never swept. */
  adopted_at?: string | null;
  /** GitHub account the Studio product's repository was created in (attachStudioRepository); null otherwise. */
  repository_account_login?: string | null;
  /** "User" or "Organization" (GitHub's account type) of repository_account_login. */
  repository_account_type?: string | null;
  /** Address whose GitHub connection made the Studio product's repository (push tokens re-check its org membership). */
  repository_connected_by?: string | null;
  /** When GitHub took a Studio product's repository away (uninstalled / removed); the product stays ACTIVE. */
  repository_disconnected_at?: string | null;
  /** Head sha of the latest push to the production branch made outside the Studio (D15); null = none / brought in. */
  external_changes_sha?: string | null;
  /** The sha the Studio's agent last announced it is mirroring (recordStudioMirror), kept for products with no deployment yet. */
  mirror_sha?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppPreviewsTable {
  app_id: string;
  pr_number: number;
  environment_id: string;
  git_ref: string | null;
  created_at: string;
  last_deployed_at: string;
}

export interface AppDeploymentsTable {
  id: string;
  app_id: string;
  environment_id: string | null;
  kind: AppDeploymentKind;
  pr_number: number | null;
  git_ref: string;
  sha: string;
  /** JSON [{ name, version }]. */
  packages: string;
  /** Full image reference (cr.vetra.io/<project>/<name>:<tag>) or NULL. */
  image_tag: string | null;
  status: AppDeploymentStatus;
  actor_did: string | null;
  actor_github: string | null;
  run_url: string | null;
  error: string | null;
  github_deployment_id: string | null;
  trigger?: DeploymentTrigger | null;
  /** did:pkh of the owner the deployment was made for (the agent's or CI's principal). */
  on_behalf_of?: string | null;
  /** The Studio product's version number (Studio launches and rollbacks to them). */
  version_number?: number | null;
  /** JSON package names the env had right before a Studio deployment was applied. */
  pre_apply_packages?: string | null;
  /** The sha the Studio mirrored to GitHub while this was the latest production deployment (recordStudioMirror). */
  mirror_sha?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GithubDeployConnectionsTable {
  owner_address: string;
  installation_id: string;
  account_login: string;
  account_type: string;
  created_at: string;
  /** GitHub App user token (AES-256-GCM, VETRA_APPS_ENCRYPTION_KEY) + expiry. */
  user_token_enc: string | null;
  user_token_expires_at: string | null;
  refresh_token_enc: string | null;
  refresh_token_expires_at: string | null;
}

/** One row per Studio env: the sha256 (hex) of its launch secret, never the secret. */
export interface StudioLaunchSecretsTable {
  environment_id: string;
  secret_hash: string;
  rotated_at: string;
}

export interface VetraAppsDB {
  instances: InstancesTable;
  apps: AppsTable;
  studio_launch_secrets: StudioLaunchSecretsTable;
  app_previews: AppPreviewsTable;
  app_deployments: AppDeploymentsTable;
  github_deploy_connections: GithubDeployConnectionsTable;
  releases: ReleasesTable;
  namespace_push_robots: NamespacePushRobotsTable;
  registry_namespaces: RegistryNamespacesTable;
}

export interface ReleasesTable {
  app_id: string;
  version: string;
  kind: "release" | "build";
  branch: string | null;
  pr: number | null;
  /** The verified GitHub run id (claim.runId): orders builds and releases of a branch. */
  run: number;
  commit: string;
  notes: string | null;
  customer_notes: string | null;
  image_ref: string;
  image_digest: string;
  host: string;
  /** JSON: [{ name, version }] */
  packages: string;
  /** JSON: { powerhouse?, services?, size? } */
  requires: string;
  migrates: boolean;
  /** What the image was built on, for rebuilds after base-layer fixes (spec section 8). */
  powerhouse_version: string;
  base_image: string;
  created_at: string;
}

export interface NamespacePushRobotsTable {
  robot_id: number;
  namespace: string;
  created_at: string;
}

/** The owner of a Harbor namespace; org apps by org id, personal apps by lower-cased address. */
export interface RegistryNamespacesTable {
  namespace: string;
  owner_kind: "org" | "person";
  owner_id: string;
  created_at: string;
}

/** Spec 14.7 as measured by the health monitor (instances/monitor.ts). */
export type InstanceHealth = "healthy" | "unhealthy" | "unknown";

export type InstanceKind = "branch" | "preview" | "shared" | "own";
/** `removed`: a tombstone for a deleted branch (never shown). `degraded`: ran the target healthy, is not healthy now (no update in flight). */
export type InstanceStatus =
  | "pending"
  | "updating"
  | "ready"
  | "degraded"
  | "failed"
  | "stopped"
  | "removed";

/** One running environment of an App (spec section 5). */
export interface InstancesTable {
  id: string;
  app_id: string;
  kind: InstanceKind;
  /** The branch (branch), `pr-<n>` (preview). Unique per app and kind. */
  name: string;
  branch: string | null;
  pr: number | null;
  /** DNS label: https://<host>.vetra.io. Null until a free one is found. */
  host: string | null;
  environment_id: string | null;
  target_version: string | null;
  target_digest: string | null;
  /** The release's image_ref without its tag. */
  target_repository: string | null;
  /** The release's host (PH_HOST), e.g. cli. */
  target_ph_host: string | null;
  /** releases.run of the target (bigint). */
  target_run: number | null;
  /** The target last seen ready: where a failed update goes back to. */
  running_version: string | null;
  running_digest: string | null;
  running_repository: string | null;
  /** The running digest went degraded after it ran healthy: not a revert target until healthy again. */
  running_degraded: boolean | null;
  status: InstanceStatus;
  reason: string | null;
  /** A target that failed; not retried until a newer target arrives. */
  failed_digest: string | null;
  update_started_at: string | null;
  /** Set when the instance is to be removed (the reconciler deletes its environment). */
  removed_at: string | null;
  /** "branch deleted" keeps a tombstone; anything else deletes the row. */
  removed_reason: string | null;
  /** Last health verdict; null until first checked. Written by the monitor only. */
  health: InstanceHealth | null;
  /** The check that decided it (gitops | image | crash | restarts | pod | switchboard | connect | stopped | data); null when healthy. */
  health_check: string | null;
  health_reason: string | null;
  health_checked_at: string | null;
  /** When the health value last changed (or the judged digest, or the STOPPED check was left): checks agree since then. */
  health_since: string | null;
  /** The digest that check judged (the environment's FUSION digest then). */
  health_digest: string | null;
  /** Restarts of the judged pods at that check (a rise is a crash). */
  health_restarts: number | null;
  /** What the cluster runs: the pod's imageID digest, else the environment document's. */
  observed_digest: string | null;
  observed_digest_source: "pod" | "document" | null;
  created_at: string;
  updated_at: string;
}
