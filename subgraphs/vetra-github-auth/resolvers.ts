import { GraphQLError } from "graphql";
import { type Kysely } from "kysely";
import type { VetraGithubAuthDB } from "./db/schema.js";
import { getConnection, type GithubConnection } from "./db/installations.js";
import { getIdentity, saveIdentity } from "./db/identities.js";
import {
  exchangeDeviceCode,
  fetchGithubUser,
  findRepoInstallationId,
  findUserAccountInstallation,
  findUserInstallation,
  GithubApiError,
  mintInstallationToken,
  ORG_POLICY_TEXT,
  ReinstallRequiredError,
  RepoNameInvalidError,
  startDeviceFlow,
  type DeviceFlowStart,
} from "./github-app.js";

/**
 * A GraphQLError carrying the code in `extensions.code`; the message is the
 * code unless a customer-readable one is given.
 */
function ghError(
  code: string,
  message: string = code,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

/** The answer to the retired repository creation (connectGithub). */
export const GITHUB_MOVED_MESSAGE = "Connect GitHub from your product's settings";

/** Where failures are logged (production logs at warn and above). */
export type GithubAuthLogger = {
  warn(msg: string): void;
  error(msg: string): void;
};

/**
 * The customer-facing error for a GitHub failure (each message names the
 * next step), or null when it is not one the customer can act on.
 */
export function githubFailure(error: unknown): GraphQLError | null {
  if (error instanceof RepoNameInvalidError)
    return ghError(
      "REPO_NAME_INVALID",
      `GitHub did not accept this repository name (${error.reason}). Choose another name.`,
      { reason: error.reason },
    );
  if (!(error instanceof GithubApiError)) return null;
  const { status } = error;
  if (status === 0 || status >= 500 || status === 429 || error.rateLimited)
    return ghError(
      "GITHUB_UNAVAILABLE",
      "GitHub is not responding. Try again in a minute.",
    );
  if (status === 401)
    return ghError(
      "GITHUB_NOT_CONNECTED",
      "Your GitHub connection has expired or was removed. Reconnect GitHub, then try again.",
    );
  // Only GitHub's own wording: the message carries account and repo names.
  if (
    (status === 403 || status === 422) &&
    error.reasons.some((r) => ORG_POLICY_TEXT.test(r))
  )
    return ghError(
      "ORG_POLICY",
      "A policy of your GitHub organisation does not allow this. Ask an owner of the organisation to allow it, then try again.",
    );
  // 404: GitHub hides what the token may not reach.
  if (status === 403 || status === 404)
    return ghError(
      "INSUFFICIENT_PERMISSION",
      "Vetra does not have permission to create repositories in this GitHub account. Install the Vetra GitHub app on the account with the repository Administration permission, then try again.",
    );
  return null;
}

/**
 * Device-flow tokens by device code, held briefly so connect polling survives
 * the app-install wait (device codes are single-use — GitHub yields the token
 * exactly once). In-process only; never returned to the client or persisted.
 * Entries die on successful connect or TTL.
 */
const DEVICE_TOKEN_TTL_MS = 20 * 60 * 1000;
const DEVICE_TOKEN_CACHE_MAX = 500;
const deviceTokenCache = new Map<string, { token: string; expiresAt: number }>();

function takeValidCachedToken(deviceCode: string): string | null {
  const entry = deviceTokenCache.get(deviceCode);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    deviceTokenCache.delete(deviceCode);
    return null;
  }
  return entry.token;
}

function cacheDeviceToken(deviceCode: string, token: string): void {
  for (const [key, entry] of deviceTokenCache) {
    if (entry.expiresAt <= Date.now()) deviceTokenCache.delete(key);
  }
  if (deviceTokenCache.size >= DEVICE_TOKEN_CACHE_MAX) {
    const oldest = deviceTokenCache.keys().next().value;
    if (oldest !== undefined) deviceTokenCache.delete(oldest);
  }
  deviceTokenCache.set(deviceCode, {
    token,
    expiresAt: Date.now() + DEVICE_TOKEN_TTL_MS,
  });
}

/** Test-only: reset the device-token cache between test cases. */
export function clearDeviceTokenCache(): void {
  deviceTokenCache.clear();
}

/** Subset of the reactor-api resolver context this subgraph relies on. */
type AuthContext = {
  user?: { address: string; chainId: number; networkId: string };
};

/** Canonical did:pkh for the authenticated caller, or null if unauthenticated. */
function callerDid(ctx: AuthContext): string | null {
  const u = ctx.user;
  if (!u) return null;
  return `did:pkh:${u.networkId}:${u.chainId}:${u.address.toLowerCase()}`;
}

function requireDid(ctx: AuthContext): string {
  const did = callerDid(ctx);
  if (!did) throw ghError("UNAUTHENTICATED");
  return did;
}

type ConnectionStatusView = {
  connected: boolean;
  connection: {
    environmentId: string;
    repoFullName: string;
    repoUrl: string;
    createdAt: string;
  } | null;
};

function toStatus(connection: GithubConnection | null): ConnectionStatusView {
  return {
    connected: !!connection,
    connection: connection
      ? {
          environmentId: connection.environmentId,
          repoFullName: connection.repoFullName,
          repoUrl: `https://github.com/${connection.repoFullName}`,
          createdAt: connection.createdAt,
        }
      : null,
  };
}

export function createResolvers(
  db: Kysely<VetraGithubAuthDB>,
  logger: GithubAuthLogger = console,
): Record<string, any> {
  /**
   * A failed `what` (while `step`): refusals as they are, GitHub failures as
   * their customer code (logged at warn), anything else logged at error level
   * and answered generically, so upstream bodies never reach the caller.
   */
  function failure(what: string, step: string, error: unknown): GraphQLError {
    if (error instanceof GraphQLError) return error;
    const mapped = githubFailure(error);
    const line = `[vetra-github-auth] ${what} failed while ${step}: ${String(error)}`;
    if (mapped) {
      logger.warn(line);
      return mapped;
    }
    logger.error(line);
    return ghError("INTERNAL_SERVER_ERROR", `${what} failed`);
  }

  /**
   * The user token for a device code: from the in-process cache when an
   * earlier poll already exchanged it (codes are single-use), else via a
   * fresh exchange — which also captures the caller's identity link.
   */
  async function resolveDeviceToken(
    did: string,
    deviceCode: string,
  ): Promise<string> {
    const cached = takeValidCachedToken(deviceCode);
    if (cached) return cached;

    const exchange = await exchangeDeviceCode(deviceCode);
    if (exchange.status !== "authorized") {
      const codes = {
        pending: "AUTHORIZATION_PENDING",
        slowDown: "SLOW_DOWN",
        expired: "DEVICE_CODE_EXPIRED",
        denied: "ACCESS_DENIED",
      } as const;
      throw ghError(codes[exchange.status]);
    }
    const token = exchange.accessToken;
    cacheDeviceToken(deviceCode, token);

    // Identity link (did → github login): captured here because the device
    // exchange is the only moment the caller's GitHub identity is visible to
    // the backend. Best-effort — a failure must not break the flow.
    try {
      const ghUser = await fetchGithubUser(token);
      await saveIdentity(db, did, ghUser.login, String(ghUser.id));
    } catch {
      /* best-effort */
    }
    return token;
  }

  return {
    Query: {
      VetraGithubAuth: () => ({}),
    },
    Mutation: {
      VetraGithubAuth: () => ({}),
    },

    VetraGithubAuthQueries: {
      myGithubConnection: async (
        _p: unknown,
        { environmentId }: { environmentId: string },
        ctx: AuthContext,
      ): Promise<ConnectionStatusView> => {
        const did = requireDid(ctx);
        const connection = await getConnection(db, did, environmentId);
        return toStatus(connection);
      },

      myGithubStatus: async (
        _p: unknown,
        { environmentId }: { environmentId: string },
        ctx: AuthContext,
      ): Promise<
        ConnectionStatusView & {
          githubLogin: string | null;
          appInstalled: boolean;
          repoAccessible: boolean | null;
        }
      > => {
        const did = requireDid(ctx);
        const connection = await getConnection(db, did, environmentId);
        const identity = await getIdentity(db, did);
        // Live lookups degrade (false / null) instead of failing the whole
        // status when GitHub is unreachable.
        const appInstalled = identity
          ? await findUserAccountInstallation(identity.githubLogin)
              .then((installation) => installation !== null)
              .catch(() => false)
          : false;
        const repoAccessible = connection
          ? await findRepoInstallationId(connection.repoFullName)
              .then((id) => id !== null)
              .catch((): null => null)
          : null;
        return {
          ...toStatus(connection),
          githubLogin: identity?.githubLogin ?? null,
          appInstalled,
          repoAccessible,
        };
      },

      getPushToken: async (
        _p: unknown,
        { environmentId }: { environmentId: string },
        ctx: AuthContext,
      ): Promise<{ token: string; expiresAt: string }> => {
        const did = requireDid(ctx);
        const connection = await getConnection(db, did, environmentId);
        if (!connection) throw ghError("NOT_CONNECTED");
        let installationId: string | null;
        try {
          installationId = await findRepoInstallationId(connection.repoFullName);
        } catch (error) {
          throw failure("getPushToken", "looking up the repository installation", error);
        }
        if (!installationId) throw ghError("APP_NOT_INSTALLED");
        const repoName = connection.repoFullName.split("/").pop();
        try {
          return await mintInstallationToken(installationId, repoName);
        } catch (error) {
          if (error instanceof ReinstallRequiredError) throw ghError("APP_NOT_INSTALLED");
          throw error;
        }
      },
    },

    VetraGithubAuthMutations: {
      startGithubDeviceFlow: async (
        _p: unknown,
        _a: unknown,
        ctx: AuthContext,
      ): Promise<DeviceFlowStart> => {
        requireDid(ctx);
        try {
          return await startDeviceFlow();
        } catch (error) {
          throw failure("startGithubDeviceFlow", "starting the device flow", error);
        }
      },

      authorizeGithub: async (
        _p: unknown,
        { deviceCode }: { deviceCode: string },
        ctx: AuthContext,
      ): Promise<{ githubLogin: string | null; appInstalled: boolean }> => {
        const did = requireDid(ctx);
        let step = "authorizing with GitHub";
        try {
          const userAccessToken = await resolveDeviceToken(did, deviceCode);
          step = "looking up the GitHub app installation";
          const installation = await findUserInstallation(userAccessToken);
          const identity = await getIdentity(db, did);
          return {
            githubLogin: identity?.githubLogin ?? null,
            appInstalled: installation !== null,
          };
        } catch (error) {
          throw failure("authorizeGithub", step, error);
        }
      },

      /**
       * Retired: GitHub is connected from the product's settings now (one
       * app, not two). Nothing is exchanged, created or recorded; existing
       * connections keep getting push tokens (getPushToken) until the
       * Studio's product carries their repository over.
       */
      connectGithub: async (
        _p: unknown,
        _a: unknown,
        ctx: AuthContext,
      ): Promise<never> => {
        requireDid(ctx);
        throw ghError("GITHUB_MOVED", GITHUB_MOVED_MESSAGE);
      },
    },
  };
}
