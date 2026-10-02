import { createAppAuth } from "@octokit/auth-app";
import type { GithubDeployConfig } from "./config.js";

/**
 * GitHub side of Vetra Apps, through the "Vetra Deploy" GitHub App:
 * OAuth code exchange (which installations may the user use), installation
 * tokens (repos, Deployments API, PR comments, setup PR).
 */

export interface GithubInstallation {
  installationId: string;
  appId: string;
  accountLogin: string;
  accountType: string;
}

export interface GithubRepo {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export type GithubDeploymentState =
  | "in_progress"
  | "success"
  | "failure"
  | "error"
  | "inactive";

/** GitHub App user-to-server tokens (access tokens expire after 8h). */
export interface GithubUserTokens {
  accessToken: string;
  expiresInSec: number | null;
  refreshToken: string | null;
  refreshTokenExpiresInSec: number | null;
}

export interface GithubDeployApi {
  /** Exchange an OAuth `code` (GitHub App user authorization) for user tokens. */
  exchangeOAuthCode(code: string): Promise<GithubUserTokens>;
  /** Trade a refresh token for new user tokens (GitHub rotates the refresh token). */
  refreshUserToken(refreshToken: string): Promise<GithubUserTokens>;
  /** Installations the user token can see (any app). */
  listUserInstallations(userToken: string): Promise<GithubInstallation[]>;
  /**
   * Repositories of `installationId` the USER can access
   * (GET /user/installations/{id}/repositories), not every repo the
   * installation covers.
   */
  listUserInstallationRepos(
    userToken: string,
    installationId: string,
  ): Promise<GithubRepo[]>;
  createDeployment(
    installationId: string,
    repoFullName: string,
    input: {
      ref: string;
      environment: string;
      transient: boolean;
      description: string;
    },
  ): Promise<string>;
  createDeploymentStatus(
    installationId: string,
    repoFullName: string,
    deploymentId: string,
    input: {
      state: GithubDeploymentState;
      environment: string;
      environmentUrl: string | null;
      logUrl: string | null;
      description: string;
    },
  ): Promise<void>;
  /** Create or update the single PR comment carrying `marker`. */
  upsertPrComment(
    installationId: string,
    repoFullName: string,
    prNumber: number,
    marker: string,
    body: string,
  ): Promise<void>;
  /** Commit `path` on `branch` (created from the default branch) and open a PR; returns its URL. */
  openPullRequestWithFile(
    installationId: string,
    repoFullName: string,
    input: {
      branch: string;
      path: string;
      content: string;
      commitMessage: string;
      title: string;
      body: string;
    },
  ): Promise<string>;
}

const API = "https://api.github.com";
type FetchLike = typeof fetch;

export class GithubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubHttpError";
  }
}

export function createGithubDeployApi(
  cfg: GithubDeployConfig,
  fetchImpl: FetchLike = fetch,
): GithubDeployApi {
  const auth = createAppAuth({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });

  const headers = (token: string, scheme = "token") => ({
    Authorization: `${scheme} ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vetra-deploy",
  });

  async function installationToken(installationId: string): Promise<string> {
    const r = await auth({
      type: "installation",
      installationId: Number(installationId),
    });
    return r.token;
  }

  async function call<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<{ status: number; data: T }> {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        ...headers(token),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && !okStatuses.includes(res.status)) {
      const detail = await res.text().catch(() => "");
      throw new GithubHttpError(
        res.status,
        `GitHub ${method} ${path} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const text = res.status === 204 ? "" : await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // accepted error statuses (404/422) may carry non-JSON bodies
        if (res.ok)
          throw new GithubHttpError(
            res.status,
            `GitHub ${method} ${path}: invalid JSON`,
          );
      }
    }
    return { status: res.status, data: data as T };
  }

  const inst = async <T>(
    installationId: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses?: number[],
  ) =>
    call<T>(
      await installationToken(installationId),
      method,
      path,
      body,
      okStatuses,
    );

  async function tokenRequest(
    params: Record<string, string>,
  ): Promise<GithubUserTokens> {
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "vetra-deploy",
      },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        ...params,
      }),
    });
    if (!res.ok) {
      throw new GithubHttpError(
        res.status,
        `OAuth token request failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
      error?: string;
    };
    if (!body.access_token) {
      throw new GithubHttpError(
        400,
        `OAuth token request failed: ${body.error ?? "no token"}`,
      );
    }
    return {
      accessToken: body.access_token,
      expiresInSec:
        typeof body.expires_in === "number" ? body.expires_in : null,
      refreshToken: body.refresh_token ?? null,
      refreshTokenExpiresInSec:
        typeof body.refresh_token_expires_in === "number"
          ? body.refresh_token_expires_in
          : null,
    };
  }

  const repoPath = (fullName: string) =>
    fullName
      .split("/")
      .map((p) => encodeURIComponent(p))
      .join("/");

  return {
    exchangeOAuthCode: (code) => tokenRequest({ code }),
    refreshUserToken: (refreshToken) =>
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),

    async listUserInstallations(userToken) {
      const out: GithubInstallation[] = [];
      for (let page = 1; page <= 10; page++) {
        const { data } = await call<{
          installations: {
            id: number;
            app_id: number;
            account: { login: string; type: string } | null;
          }[];
        }>(userToken, "GET", `/user/installations?per_page=100&page=${page}`);
        for (const i of data.installations) {
          out.push({
            installationId: String(i.id),
            appId: String(i.app_id),
            accountLogin: i.account?.login ?? "",
            accountType: i.account?.type ?? "",
          });
        }
        if (data.installations.length < 100) break;
      }
      return out;
    },

    async listUserInstallationRepos(userToken, installationId) {
      const token = userToken;
      const out: GithubRepo[] = [];
      for (let page = 1; page <= 20; page++) {
        const { data } = await call<{
          repositories: {
            id: number;
            full_name: string;
            private: boolean;
            default_branch: string;
          }[];
        }>(
          token,
          "GET",
          `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`,
        );
        for (const r of data.repositories) {
          out.push({
            id: String(r.id),
            fullName: r.full_name,
            private: r.private,
            defaultBranch: r.default_branch,
          });
        }
        if (data.repositories.length < 100) break;
      }
      return out;
    },

    async createDeployment(installationId, fullName, input) {
      const { data } = await inst<{ id: number }>(
        installationId,
        "POST",
        `/repos/${repoPath(fullName)}/deployments`,
        {
          ref: input.ref,
          environment: input.environment,
          description: input.description,
          auto_merge: false,
          required_contexts: [],
          transient_environment: input.transient,
          production_environment: !input.transient,
        },
      );
      return String(data.id);
    },

    async createDeploymentStatus(
      installationId,
      fullName,
      deploymentId,
      input,
    ) {
      await inst(
        installationId,
        "POST",
        `/repos/${repoPath(fullName)}/deployments/${encodeURIComponent(deploymentId)}/statuses`,
        {
          state: input.state,
          environment: input.environment,
          description: input.description.slice(0, 140),
          ...(input.environmentUrl
            ? { environment_url: input.environmentUrl }
            : {}),
          ...(input.logUrl ? { log_url: input.logUrl } : {}),
          auto_inactive: false,
        },
      );
    },

    async upsertPrComment(installationId, fullName, prNumber, marker, body) {
      const token = await installationToken(installationId);
      const base = `/repos/${repoPath(fullName)}/issues`;
      let existing: number | null = null;
      for (let page = 1; page <= 10 && existing === null; page++) {
        const { data } = await call<{ id: number; body?: string }[]>(
          token,
          "GET",
          `${base}/${prNumber}/comments?per_page=100&page=${page}`,
        );
        existing = data.find((c) => c.body?.includes(marker))?.id ?? null;
        if (data.length < 100) break;
      }
      const full = body.includes(marker) ? body : `${marker}\n${body}`;
      if (existing !== null) {
        await call(token, "PATCH", `${base}/comments/${existing}`, {
          body: full,
        });
      } else {
        await call(token, "POST", `${base}/${prNumber}/comments`, {
          body: full,
        });
      }
    },

    async openPullRequestWithFile(installationId, fullName, input) {
      const token = await installationToken(installationId);
      const repo = `/repos/${repoPath(fullName)}`;
      const { data: meta } = await call<{
        default_branch: string;
        owner: { login: string };
      }>(token, "GET", repo);
      const base = meta.default_branch;
      const { data: baseRef } = await call<{ object: { sha: string } }>(
        token,
        "GET",
        `${repo}/git/ref/heads/${encodeURIComponent(base)}`,
      );
      // 422 = the branch already exists (a previous setup attempt): reuse it.
      await call(
        token,
        "POST",
        `${repo}/git/refs`,
        { ref: `refs/heads/${input.branch}`, sha: baseRef.object.sha },
        [422],
      );
      const filePath = input.path
        .split("/")
        .map((p) => encodeURIComponent(p))
        .join("/");
      const { status, data: current } = await call<{ sha?: string } | null>(
        token,
        "GET",
        `${repo}/contents/${filePath}?ref=${encodeURIComponent(input.branch)}`,
        undefined,
        [404],
      );
      await call(token, "PUT", `${repo}/contents/${filePath}`, {
        message: input.commitMessage,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch: input.branch,
        ...(status !== 404 && current?.sha ? { sha: current.sha } : {}),
      });
      const created = await call<{ html_url?: string }>(
        token,
        "POST",
        `${repo}/pulls`,
        { title: input.title, head: input.branch, base, body: input.body },
        [422],
      );
      if (created.status !== 422 && created.data.html_url)
        return created.data.html_url;
      // A PR for this branch is already open: return it.
      const { data: open } = await call<{ html_url: string }[]>(
        token,
        "GET",
        `${repo}/pulls?state=open&head=${encodeURIComponent(`${meta.owner.login}:${input.branch}`)}`,
      );
      if (!open[0])
        throw new GithubHttpError(422, "could not open the setup pull request");
      return open[0].html_url;
    },
  };
}
