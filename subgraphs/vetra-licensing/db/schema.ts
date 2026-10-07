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
}

export interface VetraLicensingDB {
  app_license_grants: AppLicenseGrants;
  app_user_environments: AppUserEnvironments;
  app_environment_limits: AppEnvironmentLimits;
}
