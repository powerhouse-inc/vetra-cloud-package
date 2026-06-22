import { createAppAuth } from "@octokit/auth-app";

/**
 * Backend-only GitHub App helpers: discover the user's installation, create the
 * product repo, and mint short-lived installation tokens. The app private key
 * is a singleton read from the environment and never leaves the backend.
 */

/** Raised when the GITHUB_APP_* environment is missing or incomplete. */
export class GithubAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppConfigError";
  }
}

/**
 * Raised when minting an installation token fails because the app is no longer
 * installed (GitHub 401/404). The caller should clear the stale binding and
 * prompt the user to re-onboard.
 */
export class ReinstallRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReinstallRequiredError";
  }
}

/** Raised when repo creation fails because the name is already taken (422). */
export class RepoAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoAlreadyExistsError";
  }
}

type AppAuth = ReturnType<typeof createAppAuth>;

let cachedAuth: AppAuth | null = null;

/**
 * Lazily build the app auth interface. `@octokit/auth-app` caches minted
 * installation tokens internally for their ~1h life, so we keep one instance.
 * Node accepts GitHub's PKCS#1 key directly; we only un-escape `\n` sequences
 * so a single-line env value works.
 */
function appAuth(): AppAuth {
  if (cachedAuth) return cachedAuth;

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!appId || !privateKey) {
    throw new GithubAppConfigError(
      "Missing GitHub App config: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set",
    );
  }

  cachedAuth = createAppAuth({ appId, privateKey });
  return cachedAuth;
}

function isUninstalled(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 401 || status === 404;
}

export type InstallationToken = {
  token: string;
  expiresAt: string;
};

/**
 * Mint a ~1h installation access token for the given installation. Throws
 * {@link ReinstallRequiredError} if the app has been uninstalled.
 */
export async function mintInstallationToken(
  installationId: string,
): Promise<InstallationToken> {
  try {
    const auth = appAuth();
    const result = await auth({
      type: "installation",
      installationId: Number(installationId),
    });
    return { token: result.token, expiresAt: result.expiresAt };
  } catch (error) {
    if (isUninstalled(error)) {
      throw new ReinstallRequiredError(
        `Installation ${installationId} is no longer accessible; the app was likely uninstalled`,
      );
    }
    throw error;
  }
}

const GITHUB_API = "https://api.github.com";

function userHeaders(userAccessToken: string): Record<string, string> {
  return {
    Authorization: `token ${userAccessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vetra-cloud",
  };
}

type UserInstallationsResponse = {
  total_count: number;
  installations: {
    id: number;
    app_id: number;
    account: { type: string } | null;
  }[];
};

/**
 * Find our app's installation on the user's personal account, from the
 * installations the user access token can see (`GET /user/installations`).
 * Returns the installation id, or null if the app is not installed there.
 */
export async function findInstallationId(
  userAccessToken: string,
): Promise<string | null> {
  const appId = Number(process.env.GITHUB_APP_ID);
  const perPage = 100;
  for (let page = 1; ; page++) {
    const response = await fetch(
      `${GITHUB_API}/user/installations?per_page=${perPage}&page=${page}`,
      { headers: userHeaders(userAccessToken) },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to list user installations: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as UserInstallationsResponse;
    const match = body.installations.find(
      (i) => i.app_id === appId && i.account?.type === "User",
    );
    if (match) return String(match.id);
    if (body.installations.length < perPage) return null;
  }
}

export type CreatedRepo = {
  fullName: string;
  url: string;
};

/**
 * Create a **blank** private repo in the user's account with their access
 * token. Blank creation is what triggers GitHub's automatic installation grant
 * (a repo created via the app's user token is added to the app's access list,
 * even under a "selected repositories" install) — so we never create from a
 * template, which is the one case that does *not* auto-grant.
 */
export async function createRepo(
  userAccessToken: string,
  name: string,
): Promise<CreatedRepo> {
  const response = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: { ...userHeaders(userAccessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  if (response.status === 422) {
    throw new RepoAlreadyExistsError(
      `A repository named "${name}" already exists`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to create repository: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    full_name: string;
    html_url: string;
  };
  return { fullName: body.full_name, url: body.html_url };
}

/**
 * Find a repo named `name` among those the installation can access, returning
 * its full name and URL, or null if the installation has no such repo.
 */
export async function findInstallationRepo(
  installationId: string,
  name: string,
): Promise<CreatedRepo | null> {
  const { token } = await mintInstallationToken(installationId);
  const perPage = 100;
  for (let page = 1; ; page++) {
    const response = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=${perPage}&page=${page}`,
      { headers: userHeaders(token) },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to list installation repositories: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as {
      total_count: number;
      repositories: { name: string; full_name: string; html_url: string }[];
    };
    const match = body.repositories.find((r) => r.name === name);
    if (match) return { fullName: match.full_name, url: match.html_url };
    if (body.repositories.length < perPage) return null;
  }
}

const GITHUB_OAUTH_HOST = "https://github.com";

function githubClientId(): string {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    throw new GithubAppConfigError(
      "Missing GitHub App config: GITHUB_APP_CLIENT_ID must be set",
    );
  }
  return clientId;
}

export type DeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

/**
 * Begin GitHub App device authorization (`POST /login/device/code`); returns the
 * `user_code`, verification URL, and `device_code`.
 */
export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const response = await fetch(`${GITHUB_OAUTH_HOST}/login/device/code`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "vetra-cloud",
    },
    body: JSON.stringify({ client_id: githubClientId() }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to start device flow: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

/** The outcome of exchanging a device_code (`POST /login/oauth/access_token`). */
export type DeviceFlowExchange =
  | { status: "authorized"; accessToken: string }
  | { status: "pending" }
  | { status: "slowDown" }
  | { status: "expired" }
  | { status: "denied" };

/**
 * Exchange a device_code for a user access token, mapping GitHub's polling
 * responses to a discriminated status.
 */
export async function exchangeDeviceCode(
  deviceCode: string,
): Promise<DeviceFlowExchange> {
  const response = await fetch(
    `${GITHUB_OAUTH_HOST}/login/oauth/access_token`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "vetra-cloud",
      },
      body: JSON.stringify({
        client_id: githubClientId(),
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to exchange device code: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    access_token?: string;
    error?: string;
  };
  if (body.access_token) {
    return { status: "authorized", accessToken: body.access_token };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slowDown" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      throw new Error(
        `Device flow exchange failed: ${body.error ?? "unknown error"}`,
      );
  }
}
