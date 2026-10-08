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
  created_at: string;
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
 * The licensing-state ledger: sha256 of an app document's templates + terms as
 * the system last wrote them. A document whose state hashes differently was
 * changed outside Vetra and is held (see licensing-ledger.ts).
 */
export interface AppLicensingState {
  app_id: string;
  state_hash: string;
  updated_at: string;
}

export interface VetraLicensingDB {
  app_licensing_state: AppLicensingState;
  app_license_grants: AppLicenseGrants;
  app_user_environments: AppUserEnvironments;
  app_environment_limits: AppEnvironmentLimits;
  license_chain: LicenseChain;
  license_environments: LicenseEnvironments;
  app_allow_list: AppAllowList;
  invite_codes: InviteCodes;
  invite_redemptions: InviteRedemptions;
  environment_reporting_tokens: EnvironmentReportingTokens;
  licensing_migration_type_map: LicensingMigrationTypeMap;
  licensing_migration_steps: LicensingMigrationSteps;
}
