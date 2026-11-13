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

/** One gate token per shared instance (releases phase 3 slice 5). Plaintext is never stored. */
export interface InstanceGateTokensTable {
  instance_id: string;
  app_id: string;
  /** sha256 hex of the current token: what apps/gate/check verifies. */
  token_hash: string;
  /** The current token under the app-settings transit key: what delivery decrypts (G1). */
  token_ciphertext: string;
  /** Changes with every token: the ResolvedSecret writeId, so the settings revision moves. */
  token_id: string;
  /** The token before the last rotation, accepted while previous_until is null (new one not observed running yet) or in the future. */
  previous_hash: string | null;
  previous_until: string | null;
  /** When the current token reached the tenant; null until then. */
  delivered_at: string | null;
  created_at: string;
  rotated_at: string;
}

export interface VetraAppsDB {
  instances: InstancesTable;
  instance_gate_tokens: InstanceGateTokensTable;
  plans: PlansTable;
  environment_holds: EnvironmentHoldsTable;
  app_audit: AppAuditTable;
  app_roles: AppRolesTable;
  rollouts: RolloutsTable;
  rollout_plans: RolloutPlansTable;
  rollout_steps: RolloutStepsTable;
  app_settings: AppSettingsTable;
  apps: AppsTable;
  studio_launch_secrets: StudioLaunchSecretsTable;
  app_previews: AppPreviewsTable;
  app_deployments: AppDeploymentsTable;
  github_deploy_connections: GithubDeployConnectionsTable;
  releases: ReleasesTable;
  namespace_push_robots: NamespacePushRobotsTable;
  registry_namespaces: RegistryNamespacesTable;
  instance_backups: InstanceBackupsTable;
  instance_restores: InstanceRestoresTable;
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
  /** Withdrawn by the publisher (spec 14.3): no plan may target it. Never un-withdrawn. */
  withdrawn_at?: string | null;
  withdrawn_by?: string | null;
  withdrawn_reason?: string | null;
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

/** Where a publisher setting applies (releases phase 2 slice 4): every instance, or one kind (wins over "all"). */
export type AppSettingScope = "all" | "branch" | "preview";

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
  /** A recorded release of the App (never a build); null: no instances yet. */
  target_version: string | null;
  /** manual | patches | minor | follow:<branch>. Stored; rollouts (slice 3) act on it. */
  policy: string;
  notice_hours: number;
  /** JSON rollouts/window.ts UpdateWindow; null: any time (spec 14.8). */
  update_window?: string | null;
  /** "<version>: <reason>" of the last policy rollout the check refused; null when none. */
  policy_note?: string | null;
  status: PlanStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Where an audited action came from (spec section 10). */
/**
 * An environment kept with its data while its app does not run (releases
 * phase 3 plan 9). The processor renders a held environment with no app pod
 * and no ingress, keeping its CNPG database, backups and data volumes;
 * sleeping (STOPPED) instead deletes the database.
 */
export interface EnvironmentHoldsTable {
  environment_id: string;
  reason: string;
  switchover_id: string | null;
  /** Lowercased address, or "vetra". */
  created_by: string;
  created_at: string;
}

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

/** Releases phase 3 slice 3 (spec section 7). Lowercase like every vetra-apps status. */
export type RolloutStatus =
  | "active"
  | "paused"
  | "complete"
  | "cancelled"
  | "rolled_back";
/** forward: towards the version; back: rollBackRollout returns instances to where they came from. */
export type RolloutDirection = "forward" | "back";
export type RolloutSource = "console" | "api" | "policy";

/** One move of one or more plans to a release. */
export interface RolloutsTable {
  id: string;
  app_id: string;
  version: string;
  status: RolloutStatus;
  direction: RolloutDirection;
  source: RolloutSource;
  /** Lowercased address, or "vetra" (a policy). */
  started_by: string;
  started_at: string;
  /** What holders see: the release's customer notes (else its notes) at the start. */
  notes: string | null;
  paused_at: string | null;
  paused_reason: string | null;
  finished_at: string | null;
  rolled_back_by: string | null;
  rolled_back_at: string | null;
  updated_at: string;
}

export interface RolloutPlansTable {
  rollout_id: string;
  plan_id: string;
  /** The plan's target before (null: none); rollBackRollout sets it back. */
  from_version: string | null;
  notice_hours: number;
}

export type RolloutStepStatus =
  | "pending"
  | "backing_up"
  | "applying"
  | "restoring"
  | "succeeded"
  | "failed"
  | "skipped"
  | "revert_pending"
  | "reverting"
  | "revert_failed"
  | "rolled_back";

/** One instance's move within a rollout. */
export interface RolloutStepsTable {
  id: string;
  rollout_id: string;
  app_id: string;
  plan_id: string;
  instance_id: string;
  instance_kind: "shared" | "own";
  instance_name: string;
  /** Shared instances first, then own by age (spec 7 step 4). */
  position: number;
  /** The instance's target when the rollout started: where a revert goes. */
  from_version: string | null;
  to_version: string;
  status: RolloutStepStatus;
  /** Start + notice; the plan's window applies after it. */
  due_at: string;
  /** The holder's "update now" or the publisher's retry: due at once, outside the window. */
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** The runner set the instance's target for this step; a rollback sets it back. */
  target_moved: boolean;
  attempts: number;
  error: string | null;
  /** "pinned at 1.4.2", "stopped: updated when it wakes", … */
  note: string | null;
  /** The pre_update backup taken before this step moved its instance (slice 4). */
  backup_id?: string | null;
  /** The restore this step runs: a rollback, or a failed update of a release that migrates (slice 4). */
  restore_id?: string | null;
  created_at: string;
  updated_at: string;
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
  /** `restore:<id>` while a restore owns the instance; `held:<id>` after a failed one (stays stopped). The reconciler leaves it alone. */
  maintenance?: string | null;
  /** own: the release the publisher pinned it to (spec section 7); rollouts skip it. */
  pinned_version?: string | null;
  created_at: string;
  updated_at: string;
}

/** Why an instance backup was taken (releases phase 3 slice 4). */
export type BackupReason =
  | "pre_update"
  | "daily"
  | "manual"
  | "pre_restore"
  | "pre_stop";
export type InstanceBackupStatus = "pending" | "ready" | "failed";

/**
 * One backup of a shared or own instance: a database dump and a /data
 * archive (observability's database_dumps and data_archives), taken
 * together, restored only into the instance it was taken from.
 */
export interface InstanceBackupsTable {
  id: string;
  app_id: string;
  instance_id: string;
  environment_id: string;
  tenant_id: string;
  reason: BackupReason;
  /** What the instance ran when the backup started (running_version, running_digest). */
  version: string | null;
  digest: string | null;
  dump_id: string | null;
  archive_id: string | null;
  status: InstanceBackupStatus;
  error: string | null;
  /** Dump + archive bytes (bigint). */
  size_bytes: number | null;
  /** An address, or "vetra". */
  requested_by: string;
  /** pre_update: the rollout step it was taken for. */
  rollout_step_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  expires_at: string;
}

export type RestorePurpose = "rollback" | "failed_update" | "manual";
export type InstanceRestoreStatus =
  | "safety_backup"
  | "stopping"
  | "restoring_db"
  | "restoring_data"
  | "starting"
  | "succeeded"
  | "failed";

/** A restore of an instance backup, advanced one phase per reconciler pass (backups/restore.ts). */
export interface InstanceRestoresTable {
  id: string;
  app_id: string;
  instance_id: string;
  environment_id: string;
  tenant_id: string;
  backup_id: string;
  /** The pre_restore backup of what is replaced; null until it could start. */
  safety_backup_id: string | null;
  purpose: RestorePurpose;
  /** The release the instance targets and runs afterwards; null: unchanged. */
  then_version: string | null;
  /** Restore /data too. */
  data: boolean;
  status: InstanceRestoreStatus;
  /** When the current phase began (its timeout clock). */
  phase_started_at: string;
  db_job: string | null;
  data_job: string | null;
  /** JSON { [deployment]: replicas } recorded before scaling to 0 (at least 1 each). */
  replicas: string | null;
  /** The instance was handed back with then_version. */
  target_set: boolean;
  /** The instance was held (a failed restore) when this one began: an early failure keeps it held. */
  was_held: boolean;
  error: string | null;
  /** Failed with /data possibly half restored: the instance stays stopped. */
  held: boolean;
  requested_by: string;
  rollout_step_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}
