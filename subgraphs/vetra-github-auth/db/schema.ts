/**
 * One row per (user, environment): the binding between a Renown identity (DID),
 * the studio environment it owns, and the GitHub repo created for that
 * environment. A user gets one repo per environment. The app installation and
 * the push tokens it produces are resolved on demand at push time from the repo
 * plus the app private key, never stored here.
 */
export interface GithubInstallations {
  user_did: string;
  environment_id: string;
  repo_full_name: string;
  created_at: string;
}

/**
 * One row per user: the DID ↔ GitHub identity link, captured during the device
 * flow exchange (the only moment the caller's GitHub identity is visible).
 * Enables install-state lookups via the app JWT with no user token.
 */
export interface GithubIdentities {
  user_did: string;
  github_login: string;
  github_user_id: string;
  created_at: string;
}

export interface VetraGithubAuthDB {
  github_installations: GithubInstallations;
  github_identities: GithubIdentities;
}
