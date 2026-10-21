import { GraphQLError } from "graphql";

export type AppsErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "PREVIEWS_DISABLED"
  | "APP_NOT_ACTIVE"
  | "GITHUB_NOT_CONNECTED"
  | "SERVICE_NOT_CONFIGURED"
  | StudioLaunchErrorCode
  | GithubSetupErrorCode;

/**
 * Refusals of the Studio-agent path (D20): STUDIO_BINDING when the Studio may
 * not act on this product; DELEGATION_* when the owner's permission for the
 * agent is missing or no longer current (the Studio then asks the owner).
 */
export type StudioLaunchErrorCode =
  | "STUDIO_BINDING"
  | "DELEGATION_EXPIRED"
  | "DELEGATION_MISSING"
  /**
   * The Studio had no launch secret: one was just written. The Studio's pod
   * restarts to pick it up; the agent retries after the restart.
   */
  | "STUDIO_SECRET_PENDING"
  /** ensureStudioProduct's adoptEnvironmentId names an env that may not become the product's. */
  | "ADOPT_NOT_ALLOWED"
  /** setStudioProductDrive with another drive than the one already recorded. */
  | "PRODUCT_DRIVE_SET";

/** The GitHub and deploy-setup failures a customer can act on. */
export type GithubSetupErrorCode =
  | "REPO_NAME_INVALID"
  | "REPO_EXISTS"
  | "INSUFFICIENT_PERMISSION"
  | "ORG_POLICY"
  | "GITHUB_UNAVAILABLE"
  | "DEPLOY_SETUP_FAILED";

/** GraphQL error with the code in `extensions.code`. */
export function appsError(
  code: AppsErrorCode,
  message?: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message ?? code, {
    extensions: { ...extensions, code },
  });
}

export function notConfigured(what: string): GraphQLError {
  return appsError("SERVICE_NOT_CONFIGURED", `${what} is not configured`);
}

/** Customer-readable messages, each with a next step. */
export const githubErrors = {
  repoExists: () =>
    appsError(
      "REPO_EXISTS",
      "A repository with this name already exists on GitHub. Choose another name, or connect the existing repository.",
    ),
  repoNameInvalid: (reason: string) =>
    appsError(
      "REPO_NAME_INVALID",
      `GitHub did not accept this repository name (${reason}). Choose another name.`,
      { reason },
    ),
  insufficientPermission: (account: string) =>
    appsError(
      "INSUFFICIENT_PERMISSION",
      `Vetra does not have permission to create and set up repositories in ${account} on GitHub. Install the Vetra GitHub app on ${account} with the repository Administration permission (or ask an owner of ${account} to), then try again.`,
    ),
  orgPolicy: (account: string) =>
    appsError(
      "ORG_POLICY",
      `A policy of the ${account} organisation on GitHub does not allow this. Ask an owner of the organisation to allow it, then try again.`,
    ),
  /** Connecting a Studio product to an organisation the policy of which does not allow it (spec §8). */
  studioOrgPolicy: (org: string) =>
    appsError(
      "ORG_POLICY",
      `Ask an owner of ${org} to allow Vetra, or choose your personal account`,
    ),
  /** Vetra is not installed on the organisation, or the caller is not (or no longer) a member of it. */
  studioOrgNotInstalled: (org: string) =>
    appsError(
      "INSUFFICIENT_PERMISSION",
      `Install Vetra on ${org} or choose your personal account`,
    ),
  /**
   * `reason` (studioPushToken, in extensions.reason): NEVER_CONNECTED — the
   * product never had a repository (the Studio may push with its earlier
   * connection); DISCONNECTED — GitHub took it away; TOKEN_REFUSED — the
   * repository is recorded but no token was given.
   */
  notConnected: (reason?: "NEVER_CONNECTED" | "DISCONNECTED" | "TOKEN_REFUSED") =>
    appsError(
      "GITHUB_NOT_CONNECTED",
      "Your GitHub connection has expired or was removed. Reconnect GitHub, then try again.",
      reason ? { reason } : {},
    ),
  unavailable: () =>
    appsError(
      "GITHUB_UNAVAILABLE",
      "GitHub is not responding. Try again in a minute.",
    ),
  /**
   * `repoRolledBack`: Vetra created a repository and removed it again;
   * `cleanedUp` false: an undo step failed.
   */
  deploySetupFailed: (outcome: { repoRolledBack: boolean; cleanedUp: boolean }) =>
    appsError(
      "DEPLOY_SETUP_FAILED",
      !outcome.cleanedUp
        ? "Setting up the deployment failed and some resources could not be cleaned up automatically; try again or contact support."
        : outcome.repoRolledBack
          ? "Setting up the deployment failed after the repository was created. Everything was rolled back; try again."
          : "Setting up the deployment failed. Nothing was changed; try again.",
    ),
};

/** GitHub's wording for an organisation policy (SAML, access restrictions, ...). */
export const ORG_POLICY_TEXT =
  /\bpolic(y|ies)\b|\bSAML\b|access restrictions|organi[sz]ation (has )?(enabled|restricts|forbids|disallows|requires)/i;
