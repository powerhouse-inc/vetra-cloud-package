/**
 * One row per (user, environment): the binding between a Renown identity (DID)
 * and the studio environment it owns, and the GitHub App installation + product
 * repo created for that environment. A user gets one repo per environment.
 * Tokens are never stored here — they are minted on demand from
 * `installation_id` plus the app private key.
 */
export interface GithubInstallations {
  user_did: string;
  environment_id: string;
  installation_id: string;
  repo_full_name: string;
  created_at: string;
}

export interface VetraGithubAuthDB {
  github_installations: GithubInstallations;
}
