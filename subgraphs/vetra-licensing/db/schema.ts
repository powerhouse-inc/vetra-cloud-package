/** One environment, owned by one user, under one app. Upsert key of the whole design. */
export interface AppUserEnvironments {
  app_id: string;
  /** Lowercased 0x address. The DID form is normalised away at the resolver boundary. */
  user_address: string;
  environment_id: string;
  license_id: string;
  /** sha256 of the canonical rendered template; how a stale environment is recognised. */
  template_hash: string;
  created_at: string;
  updated_at: string;
}

/** Per-app ceiling on how many environments may exist. Absent row = configured default. */
export interface AppEnvironmentLimits {
  app_id: string;
  max_environments: number;
}

/**
 * A licence the publisher surface actually authorised, written by the issue path
 * after resolveOwnerApp has proved the caller owns the app.
 *
 * The keeper reads licence DOCUMENTS, and `find({type: app-owner-license})`
 * returns every such document in the reactor, whoever created it. Licence
 * documents are system-signed, so a forged one carries no signature to check.
 * This table is the provenance the documents cannot supply: a licence with no
 * row here was never authorised by the app's owner.
 */
export interface AppLicenseGrants {
  /** The licence document id. Globally unique, so it is the primary key. */
  license_id: string;
  app_id: string;
  license_type_id: string;
  /** Lowercased 0x address of the holder. */
  user_address: string;
  /** Lowercased 0x address of the owner/admin who authorised the grant. */
  issued_by: string;
  created_at: string;
  /** The term kind the licence was issued on. Null on rows written before kinds existed. */
  kind: string | null;
  /** did:pkh:eip155:1:<address>. Null on rows written before DIDs were stored. */
  user_did: string | null;
}

/** Which chain a licence belongs to. An upgrade/grace licence points at its predecessor's root. */
export interface LicenseChain {
  license_id: string;
  root_license_id: string;
  app_id: string;
  /** Project name the owner chose; becomes the environment label. */
  label: string | null;
  created_at: string;
}

/**
 * One DEDICATED environment per licence chain. Keyed on the environment;
 * root_license_id is UNIQUE and is the claim lock (one chain, one environment).
 * Supersedes app_user_environments, which stays in place, read-only.
 */
export interface LicenseEnvironments {
  environment_id: string;
  root_license_id: string;
  app_id: string;
  user_did: string;
  /** The licence currently justifying the environment (the chain head). */
  license_id: string;
  template_id: string | null;
  label: string | null;
  template_hash: string;
  /**
   * The channel every artifact of this chain's template resolves on instead
   * of the template's own (spec 4.2): 'STAGING' marks a canary. Null (or
   * absent on a row built in code before the column existed): the template's.
   */
  channel_override?: string | null;
  /** First moment the keeper saw the chain without an ACTIVE licence. */
  ended_at: string | null;
  stopped_at: string | null;
  delete_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppAllowList {
  app_id: string;
  user_did: string;
  added_at: string;
}

/** An invite code issues one term (kind) of one app. Moved from vetra-access-codes. */
export interface InviteCodes {
  code: string;
  app_id: string;
  kind: string;
  label: string | null;
  active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  /** OpenBao transit ciphertext of an attached Claude key; never returned. */
  anthropic_key_ciphertext: string | null;
  /** Monthly LLM budget (USD) for Studios of licences redeemed from this code; null = deployment default. */
  llm_budget_usd: number | null;
  created_at: string;
  /**
   * Moved from vetra-access-codes, which trimmed and lowercased every input:
   * an exact lookup that misses falls back to lower(trim(input)) on these
   * rows only. Codes created here stay exactly case-sensitive.
   */
  legacy_case_insensitive: boolean;
}

export interface InviteRedemptions {
  code: string;
  user_did: string;
  redeemed_at: string;
  access_expires: string | null;
  /** Null only while a redemption is reserved and its licence not yet issued. */
  license_id: string | null;
}

/** sha256 of the per-environment reporting token written into the environment's secrets. */
export interface EnvironmentReportingTokens {
  environment_id: string;
  token_hash: string;
  created_at: string;
}

/** Durable licence-type -> term mapping, so the migration is restartable after types are deleted. */
export interface LicensingMigrationTypeMap {
  license_type_id: string;
  app_id: string;
  kind: string;
  template_id: string;
  term_id: string;
  created_at: string;
}

export interface LicensingMigrationSteps {
  step: string;
  completed_at: string;
  detail: string | null;
}

/**
 * The licensing-state ledger: sha256 of an app document's templates + terms +
 * artifacts as the system last wrote them. A document whose state hashes differently was
 * changed outside Vetra and is held (see licensing-ledger.ts).
 */
export interface AppLicensingState {
  app_id: string;
  state_hash: string;
  updated_at: string;
}

/**
 * A system write about to be made to an app document (licensing-ledger.ts):
 * lets a later read or write record the result when the write applied but
 * recording it failed. `done_at` is set once the ledger reflects it.
 */
export interface AppLicensingIntent {
  id: string;
  app_id: string;
  /** The recorded hash the write started from. */
  base_hash: string;
  /** The document's global revision before the write. */
  base_revision: number;
  /** JSON array of the batch's action ids (server-generated). */
  action_ids: string;
  created_at: string;
  done_at: string | null;
  /**
   * Set (with done_at) when the write failed with none of its actions applied.
   * Its action ids never count as system writes when healing.
   */
  abandoned_at: string | null;
}

/**
 * The lifecycle status of a licence as the SYSTEM last wrote it (every
 * issue/activate/expire/revoke/replace goes through the licence gateway, which
 * records here after the write applied). Licence documents carry the same
 * fields, but a document can be written by others; the keeper treats a licence
 * as terminal only when this row agrees. No row: written before this table
 * existed (the migration backfills it), and the document is used.
 */
export interface LicenseLifecycle {
  license_id: string;
  status: string;
  /** The licence's end as issued; null for an open-ended licence. */
  end_at: string | null;
  replaced_by: string | null;
  updated_at: string;
}

export interface AppWarmPool {
  environment_id: string;
  app_id: string;
  template_id: string;
  template_hash: string;
  state: "WARMING" | "AVAILABLE" | "CLAIMED";
  created_at: string;
  ready_at: string | null;
  claimed_at: string | null;
  deleted_at: string | null;
  root_license_id: string | null;
  /** When a retired row's environment document was deleted (see warm-pool-db). */
  env_deleted_at: string | null;
  /** The pool size the row was created for (see warm-pool-db timeoutStreak). */
  pool_size: number | null;
  /** Set when the keeper retired the row as a WARMING timeout. */
  timed_out_at: string | null;
}

export type ReleasePolicy = "AUTO" | "GATED";
export type RolloutStatus = "ACTIVE" | "PAUSED" | "SUPERSEDED" | "COMPLETE";
export type UpdateStatus =
  | "PENDING"
  | "APPLYING"
  | "SUCCEEDED"
  | "REVERTED"
  | "RESTORED"
  | "FAILED"
  | "SUPERSEDED";

/** Per-app release policy (spec 4.1). No row: AUTO with 72 hours' notice. */
export interface AppReleaseSettings {
  app_id: string;
  policy: ReleasePolicy;
  default_notice_hours: number;
  updated_at: string;
}

/** A promotion of one FUSION artifact version to the app's customers (spec 4.3). */
export interface AppRollouts {
  id: string;
  app_id: string;
  artifact_name: string;
  version: string;
  status: RolloutStatus;
  /** Customers are updated automatically from here on (promotion + notice). */
  apply_after: string;
  /** Lowercased address of the publisher who promoted it. */
  promoted_by: string;
  promoted_at: string;
  paused_at: string | null;
  paused_reason: string | null;
}

/**
 * One FUSION version move of one environment (spec 4.3). rollout_id is null
 * for a canary's update and for every update of an AUTO app.
 */
export interface EnvironmentUpdates {
  id: string;
  rollout_id: string | null;
  environment_id: string;
  app_id: string;
  from_version: string;
  to_version: string;
  status: UpdateStatus;
  due_at: string;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  /** Phase 2 (safe apply): the dump taken before the version was set. */
  pre_update_dump_id: string | null;
  error: string | null;
  /** Set by the publisher's forceEnvironmentUpdate: applies despite a pause or an unordered version. */
  forced_at: string | null;
  created_at: string;
}

export interface VetraLicensingDB {
  app_licensing_state: AppLicensingState;
  app_licensing_intent: AppLicensingIntent;
  app_license_grants: AppLicenseGrants;
  app_user_environments: AppUserEnvironments;
  app_environment_limits: AppEnvironmentLimits;
  license_chain: LicenseChain;
  license_environments: LicenseEnvironments;
  app_warm_pool: AppWarmPool;
  app_allow_list: AppAllowList;
  invite_codes: InviteCodes;
  invite_redemptions: InviteRedemptions;
  environment_reporting_tokens: EnvironmentReportingTokens;
  licensing_migration_type_map: LicensingMigrationTypeMap;
  licensing_migration_steps: LicensingMigrationSteps;
  license_lifecycle: LicenseLifecycle;
  app_release_settings: AppReleaseSettings;
  app_rollouts: AppRollouts;
  environment_updates: EnvironmentUpdates;
}
