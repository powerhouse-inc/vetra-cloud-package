import { gql } from "graphql-tag";
import type { DocumentNode } from "graphql";

export const schema: DocumentNode = gql`
  """
  A GitHub connection for one studio environment: the repo created in the
  caller's account for that environment.
  """
  type GithubConnection {
    environmentId: String!
    repoFullName: String!
    repoUrl: String!
    createdAt: String!
  }

  """
  Whether the caller has connected GitHub for an environment, and the details.
  """
  type GithubConnectionStatus {
    connected: Boolean!
    connection: GithubConnection
  }

  """
  Everything the deploy UI needs to route the GitHub flow: the environment's
  connection (if any), the caller's linked GitHub login (captured once during
  device authorization), and whether the app is currently installed on that
  account. appInstalled is resolved live from GitHub at query time — never
  stored — so uninstalls are reflected immediately. githubLogin is null until
  the caller has authorized at least once; appInstalled is false then too.
  repoAccessible is the push-health signal for a connected environment: whether
  the app's installation can reach the connected repo, resolved live. Null when
  no connection exists or GitHub could not be reached; appInstalled true with
  repoAccessible false means the repo was dropped from a selected-repositories
  installation (e.g. after an uninstall/reinstall).
  """
  type GithubStatus {
    connected: Boolean!
    connection: GithubConnection
    githubLogin: String
    appInstalled: Boolean!
    repoAccessible: Boolean
  }

  """
  A short-lived installation access token for Git push/pull. ~1h lifetime;
  re-fetch on expiry. Never persisted server-side beyond its in-process cache.
  """
  type GithubPushToken {
    token: String!
    expiresAt: String!
  }

  """
  A pending GitHub App device authorization. Display userCode at
  verificationUri, then poll connectGithub with deviceCode until the user
  authorizes. About 15m lifetime; interval is the minimum seconds between polls.
  """
  type GithubDeviceFlow {
    deviceCode: String!
    userCode: String!
    verificationUri: String!
    expiresIn: Int!
    interval: Int!
  }

  type VetraGithubAuthQueries {
    "The caller's GitHub connection for the given environment."
    myGithubConnection(environmentId: String!): GithubConnectionStatus!
    """
    Connection, identity link, and live install state for the caller — lets the
    UI skip the install step for users who already installed the app.
    Errors: UNAUTHENTICATED if no caller.
    """
    myGithubStatus(environmentId: String!): GithubStatus!
    """
    Mint a push token for the repo bound to environmentId. The app installation
    on the repo is resolved at call time. Errors: NOT_CONNECTED if no connection
    exists for the environment; APP_NOT_INSTALLED if the app is not installed on
    the repo yet; UNAUTHENTICATED if no caller.
    """
    getPushToken(environmentId: String!): GithubPushToken!
  }

  """
  The outcome of one authorizeGithub poll: who the caller is on GitHub (null if
  the identity lookup failed) and whether the app is installed for them.
  """
  type GithubAuthorization {
    githubLogin: String
    appInstalled: Boolean!
  }

  type VetraGithubAuthMutations {
    """
    Begin GitHub App device authorization for the authenticated caller. The
    backend calls GitHub with the app's public client_id (no secret) and returns
    the user_code and URL to display plus the device_code to poll connectGithub
    with. Errors: UNAUTHENTICATED if no caller.
    """
    startGithubDeviceFlow: GithubDeviceFlow!
    """
    One poll of device authorization: exchanges the code on first success (the
    token is cached in memory, ~20 min), captures the caller's identity link,
    and reports whether the app is installed for them. Poll until it stops
    throwing AUTHORIZATION_PENDING; then, while appInstalled is false, keep
    polling — the install check runs fresh each time. Call connectGithub with
    the SAME deviceCode afterwards to create the repo. Errors:
    AUTHORIZATION_PENDING, SLOW_DOWN, DEVICE_CODE_EXPIRED, ACCESS_DENIED,
    UNAUTHENTICATED.
    """
    authorizeGithub(deviceCode: String!): GithubAuthorization!
    """
    Complete onboarding for the authenticated caller from a deviceCode obtained
    via startGithubDeviceFlow, binding the result to environmentId (one repo per
    environment). The backend exchanges the code for a user access token
    server-side (never exposed to the client or stored) and creates a blank
    private repo in the caller's account. The app MUST already be installed on
    the caller's account: a user token can only act on what the installation can
    access, so repo creation 403s without one. For selected-repositories
    installs the new repo is added to the installation automatically. Poll until
    it returns connected. On APP_NOT_INSTALLED, KEEP polling with the same
    deviceCode: the backend briefly holds the exchanged token in memory
    (~20 min, never exposed) and completes the connect on the first poll after
    the installation appears.
    Errors: AUTHORIZATION_PENDING or SLOW_DOWN while the user has not authorized
    yet (keep polling); DEVICE_CODE_EXPIRED if the code timed out; ACCESS_DENIED
    if the user declined; APP_NOT_INSTALLED if the app is not installed on the
    caller's account; REPO_ALREADY_EXISTS if the name is taken; UNAUTHENTICATED
    if no caller.
    """
    connectGithub(
      deviceCode: String!
      repoName: String!
      environmentId: String!
    ): GithubConnectionStatus!
  }

  type Query {
    VetraGithubAuth: VetraGithubAuthQueries!
  }

  type Mutation {
    VetraGithubAuth: VetraGithubAuthMutations!
  }
`;
