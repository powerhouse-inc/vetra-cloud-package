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

export interface VetraLicensingDB {
  app_user_environments: AppUserEnvironments;
  app_environment_limits: AppEnvironmentLimits;
}
