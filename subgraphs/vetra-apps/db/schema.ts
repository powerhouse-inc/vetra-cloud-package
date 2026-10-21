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
  apps: AppsTable;
  studio_launch_secrets: StudioLaunchSecretsTable;
  app_previews: AppPreviewsTable;
  app_deployments: AppDeploymentsTable;
  github_deploy_connections: GithubDeployConnectionsTable;
}
