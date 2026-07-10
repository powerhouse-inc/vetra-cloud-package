import { GraphQLError } from "graphql";
import { type Kysely } from "kysely";
import type { VetraGithubAuthDB } from "./db/schema.js";
import {
  getConnection,
  saveConnection,
  type GithubConnection,
} from "./db/installations.js";
import { getIdentity, saveIdentity } from "./db/identities.js";
import {
  addRepoToInstallation,
  createRepo,
  exchangeDeviceCode,
  fetchGithubUser,
  findRepoInstallationId,
  findUserAccountInstallation,
  findUserInstallation,
  findUserRepo,
  mintInstallationToken,
  ReinstallRequiredError,
  RepoAlreadyExistsError,
  startDeviceFlow,
  type DeviceFlowStart,
} from "./github-app.js";

/** A GraphQLError carrying the error code in `extensions.code` and `message`. */
function ghError(code: string): GraphQLError {
  return new GraphQLError(code, { extensions: { code } });
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
): Record<string, any> {
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
        ConnectionStatusView & { githubLogin: string | null; appInstalled: boolean }
      > => {
        const did = requireDid(ctx);
        const connection = await getConnection(db, did, environmentId);
        const identity = await getIdentity(db, did);
        const appInstalled = identity
          ? (await findUserAccountInstallation(identity.githubLogin)) !== null
          : false;
        return {
          ...toStatus(connection),
          githubLogin: identity?.githubLogin ?? null,
          appInstalled,
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
        const installationId = await findRepoInstallationId(connection.repoFullName);
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
        return startDeviceFlow();
      },

      connectGithub: async (
        _p: unknown,
        {
          deviceCode,
          repoName,
          environmentId,
        }: { deviceCode: string; repoName: string; environmentId: string },
        ctx: AuthContext,
      ): Promise<ConnectionStatusView> => {
        const did = requireDid(ctx);

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
        const userAccessToken = exchange.accessToken;

        // Identity link (did → github login): captured here because the device
        // exchange is the only moment the caller's GitHub identity is visible
        // to the backend. Best-effort — a failure must not break the connect.
        try {
          const ghUser = await fetchGithubUser(userAccessToken);
          await saveIdentity(db, did, ghUser.login, String(ghUser.id));
        } catch {
          /* best-effort */
        }

        // A user token can only act on what the app's installation can access,
        // so repo creation is impossible until the app is installed somewhere
        // the user can see. Surface that as a machine code, not a 500.
        const installation = await findUserInstallation(userAccessToken);
        if (!installation) throw ghError("APP_NOT_INSTALLED");

        let repo;
        try {
          repo = await createRepo(userAccessToken, repoName);
        } catch (error) {
          if (error instanceof RepoAlreadyExistsError) {
            const existing = await findUserRepo(userAccessToken, repoName);
            if (!existing) throw ghError("REPO_ALREADY_EXISTS");
            repo = existing;
          } else {
            throw error;
          }
        }

        // Selected-repositories installs don't include the new repo; add it so
        // push tokens resolve. Best-effort: push-time APP_NOT_INSTALLED remains
        // the enforcement if this fails.
        if (installation.repositorySelection === "selected") {
          await addRepoToInstallation(
            userAccessToken,
            installation.id,
            repo.id,
          ).catch(() => {});
        }

        const connection = await saveConnection(db, did, environmentId, repo.fullName);
        return toStatus(connection);
      },
    },
  };
}
