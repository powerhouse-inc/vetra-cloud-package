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
  plans: PlansTable;
  app_audit: AppAuditTable;
  app_roles: AppRolesTable;
  app_settings: AppSettingsTable;
  instance_settings: InstanceSettingsTable;
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

export type CustomDomainStatus = "dns" | "issuing" | "active" | "failed";

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

/**
 * Where a publisher setting applies (releases phase 2 slice 4): every instance,
 * or one kind (wins over "all"). "plan" (phase 3 plan 7, H1): shared and own
 * instances; "all" secrets do not reach them.
 */
export type AppSettingScope = "all" | "branch" | "preview" | "plan";

/** A publisher setting of an App (spec 14.2). Secrets: value null, ciphertext set. */
export interface AppSettingsTable {
  app_id: string;
  scope: AppSettingScope;
  name: string;
  secret: boolean;
  /** Plain settings only. */
  value: string | null;
  /** Secrets only: OpenBao transit ciphertext under the `app-settings` pseudo-tenant (settings/vault.ts). */
  ciphertext: string | null;
  /** Random per write: re-setting a secret (same value or not) makes a new revision. */
  write_id: string;
  updated_at: string;
  updated_by: string;
  /** Files only (secret true, name FILE_<16 hex>): where the file is mounted (plan 7 H6). */
  mount_path?: string | null;
}

export type InstanceSettingKind = "plain" | "secret" | "file";

/**
 * A holder setting of an own instance (spec 14.2, plan 7 H2/H3). Holder-only:
 * never shown to the publisher by name. Secrets and files: value null,
 * ciphertext set (transit pseudo-tenant `instance-settings`).
 */
export interface InstanceSettingsTable {
  instance_id: string;
  /** Env name, or for files `FILE_<16 hex of sha256(mountPath)>`. */
  name: string;
  kind: InstanceSettingKind;
  /** Files only. */
  mount_path: string | null;
  /** Plain settings only. */
  value: string | null;
  ciphertext: string | null;
  /** Random per write: the revision uses it for secrets and files. */
  write_id: string;
  updated_at: string;
  updated_by: string;
}

/** shared: one instance for all holders; own: one instance per licence chain (spec section 5). */
export type PlanAccess = "shared" | "own";
export type PlanStatus = "active" | "retired";

/** What holders of one licensing term get (spec section 7; overview gap 1: a plan adopts a term by kind). */
export interface PlansTable {
  id: string;
  app_id: string;
  /** Names the shared instance; unique per App (plans/rules.ts). */
  slug: string;
  name: string;
  /** The licensing term kind adopted: its live licences are this plan's holders. Unique per App. */
  kind: string;
  access: PlanAccess;
  /** VETRA_AGENT_S … VETRA_AGENT_XXL: the FUSION size of every instance of the plan. */
  size: string;
  /** Monthly AI budget (USD) of every instance's own key; null: no AI key (plan 7 Task 10). */
  ai_budget_usd?: number | null;
  /** A recorded release of the App (never a build); null: no instances yet. */
  target_version: string | null;
  /** manual | patches | minor | follow:<branch>. Stored; rollouts (slice 3) act on it. */
  policy: string;
  notice_hours: number;
  status: PlanStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Where an audited action came from (spec section 10). */
export type AuditSource = "console" | "api" | "policy" | "system" | "ci";

/** One audited action on an App (spec section 10): who, what, when, from where. Kept 365 days. */
export interface AppAuditTable {
  id: string;
  app_id: string;
  at: string;
  /** Lowercased address, or "vetra" for Vetra itself (system, policy). */
  actor: string;
  source: AuditSource;
  /** audit/repo.ts AUDIT_ACTIONS. */
  action: string;
  /** plan:<id> | setting:<SCOPE>/<NAME> | role:<address> | instance:<id> | release:<version> */
  subject: string;
  /** JSON object; never a setting value or secret. */
  detail: string;
}

/** Per-App roles Vetra keeps itself (releases phase 3 D7; Renown has no such role). */
export type AppRoleName = "release_manager";

export interface AppRolesTable {
  app_id: string;
  /** Lowercased address. */
  address: string;
  role: AppRoleName;
  /** The App's owner when granted: org:<orgId> | user:<address>. A grant under another owner has no effect. */
  owner_scope: string;
  granted_by: string;
  granted_at: string;
}

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
  /** The App's settings revision for this kind (settings/resolve.ts): what the instance should run. */
  target_settings: string | null;
  /** The revision last seen ready together with running_digest. */
  running_settings: string | null;
  /** The revision of a failed update (with failed_digest): not retried until either changes. */
  failed_settings: string | null;
  /** The revision whose secrets were written to the instance's tenant, and when. */
  settings_delivered: string | null;
  settings_delivered_at: string | null;
  /** The revision the last health check judged (the environment's VETRA_SETTINGS_REVISION). Monitor only. */
  health_settings: string | null;
  /** The revision a ready host pod runs (its VETRA_SETTINGS_REVISION env). Monitor only. */
  observed_settings: string | null;
  /** shared/own: the plan the instance serves. */
  plan_id?: string | null;
  /** own: the holder's lowercased address (ADMINS). */
  holder_address?: string | null;
  /** own: the licence chain's root (license_chain.root_license_id, or the licence itself). */
  licence_root_id?: string | null;
  /** own: when a pass first saw the chain without a live licence. */
  licence_ended_at?: string | null;
  /** Set: the instance is to be stopped (the reconciler sleeps its environment). */
  stop_reason?: string | null;
  /** The environment was put to sleep by Vetra (woken by Vetra when stop_reason clears). */
  stopped_by_vetra?: boolean | null;
  /** shared/own: the FUSION size (VetraCloudRessourceSize) of the plan. */
  target_size?: string | null;
  /** own: the holder's custom domain, lowercased; unique where set (plan 7 Task 7). */
  custom_domain?: string | null;
  /** dns: waiting for DNS; issuing: applied, certificate pending; active: served; failed: gave up (see reason). */
  custom_domain_status?: CustomDomainStatus | null;
  /** Why `failed`, or what `dns` waits for. */
  custom_domain_reason?: string | null;
  /** When custom_domain_status last changed. */
  custom_domain_since?: string | null;
  /** active: when the daily TLS check last ran. */
  custom_domain_checked_at?: string | null;
  /** active: failed daily TLS checks in a row. */
  custom_domain_failures?: number | null;
  /** dns: the per-instance token the holder publishes at _vetra-verify.<domain> (TXT). */
  custom_domain_token?: string | null;
  created_at: string;
  updated_at: string;
}
