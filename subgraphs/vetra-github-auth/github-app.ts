import { createAppAuth } from "@octokit/auth-app";

/** Backend GitHub App helpers: installation discovery, repo creation, and
 * short-lived installation tokens. */

/** Raised when the GITHUB_APP_* environment is missing or incomplete. */
export class GithubAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppConfigError";
  }
}

/** Raised when minting an installation token fails because the app is no longer
 * installed (GitHub 401/404). */
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

/** Lazily build (and cache) the app auth interface. Un-escapes `\n` so a
 * single-line `GITHUB_APP_PRIVATE_KEY` env value works. */
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
 * Mint a ~1h installation access token. When `repoName` is given, the token is
 * scoped to that single repository with Contents access only. Throws
 * {@link ReinstallRequiredError} if the app has been uninstalled.
 */
export async function mintInstallationToken(
  installationId: string,
  repoName?: string,
): Promise<InstallationToken> {
  try {
    const auth = appAuth();
    const result = await auth(
      repoName
        ? {
            type: "installation",
            installationId: Number(installationId),
            repositoryNames: [repoName],
            permissions: { contents: "write" },
          }
        : { type: "installation", installationId: Number(installationId) },
    );
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

export type CreatedRepo = {
  id: number;
  fullName: string;
  url: string;
};

export type UserInstallation = {
  id: string;
  repositorySelection: "all" | "selected";
};

/**
 * The caller's installation of this app, from their user token, or null if the
 * app is not installed anywhere the user can see. A user access token can only
 * act on resources its installation can access, so repo creation requires this
 * to be non-null.
 */
export async function findUserInstallation(
  userAccessToken: string,
): Promise<UserInstallation | null> {
  const response = await fetch(`${GITHUB_API}/user/installations`, {
    headers: userHeaders(userAccessToken),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to list app installations: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    installations?: { id: number; repository_selection?: string }[];
  };
  const installation = body.installations?.[0];
  if (!installation) return null;
  return {
    id: String(installation.id),
    repositorySelection:
      installation.repository_selection === "all" ? "all" : "selected",
  };
}

/**
 * Add a repo to a selected-repositories installation so the app (and its
 * installation tokens) can access it. 204 = added, 304 = already included.
 */
export async function addRepoToInstallation(
  userAccessToken: string,
  installationId: string,
  repositoryId: number,
): Promise<void> {
  const response = await fetch(
    `${GITHUB_API}/user/installations/${installationId}/repositories/${repositoryId}`,
    { method: "PUT", headers: userHeaders(userAccessToken) },
  );
  if (response.status === 204 || response.status === 304) return;
  const detail = await response.text().catch(() => "");
  throw new Error(
    `Failed to add repository to installation: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
  );
}

/** Create a blank private repo in the user's account with their access token. */
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
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to create repository: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
    );
  }
  const body = (await response.json()) as {
    id: number;
    full_name: string;
    html_url: string;
  };
  return { id: body.id, fullName: body.full_name, url: body.html_url };
}

/** The authenticated user's GitHub login and id, from their user access token. */
export async function fetchGithubUser(
  userAccessToken: string,
): Promise<{ login: string; id: number }> {
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: userHeaders(userAccessToken),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to resolve the authenticated user: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { login: string; id: number };
  return { login: body.login, id: body.id };
}

/**
 * The app's installation on `login`'s account, or null if not installed there.
 * Resolved from the app's own JWT, so it works long after any user token is
 * gone — this is what makes install state detectable across sessions.
 */
export async function findUserAccountInstallation(
  login: string,
): Promise<UserInstallation | null> {
  const auth = appAuth();
  const { token: jwt } = await auth({ type: "app" });
  const response = await fetch(
    `${GITHUB_API}/users/${encodeURIComponent(login)}/installation`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vetra-cloud",
      },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Failed to look up account installation: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as {
    id: number;
    repository_selection?: string;
  };
  return {
    id: String(body.id),
    repositorySelection:
      body.repository_selection === "all" ? "all" : "selected",
  };
}

/**
 * The id of this app's installation on `repoFullName` (`owner/repo`), or null if
 * the app is not installed on that repo. Resolved from the app's own JWT, so it
 * needs no user token.
 */
export async function findRepoInstallationId(
  repoFullName: string,
): Promise<string | null> {
  const auth = appAuth();
  const { token: jwt } = await auth({ type: "app" });
  const response = await fetch(`${GITHUB_API}/repos/${repoFullName}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "vetra-cloud",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Failed to look up repo installation: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { id: number };
  return String(body.id);
}

/**
 * Find a repo named `name` in the authenticated user's account, returning its
 * full name and URL, or null if they have no such repo.
 */
export async function findUserRepo(
  userAccessToken: string,
  name: string,
): Promise<CreatedRepo | null> {
  const userResponse = await fetch(`${GITHUB_API}/user`, {
    headers: userHeaders(userAccessToken),
  });
  if (!userResponse.ok) {
    throw new Error(
      `Failed to resolve the authenticated user: ${userResponse.status} ${userResponse.statusText}`,
    );
  }
  const { login } = (await userResponse.json()) as { login: string };
  const repoResponse = await fetch(`${GITHUB_API}/repos/${login}/${name}`, {
    headers: userHeaders(userAccessToken),
  });
  if (repoResponse.status === 404) return null;
  if (!repoResponse.ok) {
    throw new Error(
      `Failed to look up repository: ${repoResponse.status} ${repoResponse.statusText}`,
    );
  }
  const body = (await repoResponse.json()) as {
    id: number;
    full_name: string;
    html_url: string;
  };
  return { id: body.id, fullName: body.full_name, url: body.html_url };
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
