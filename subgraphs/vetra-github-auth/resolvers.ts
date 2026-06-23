import { GraphQLError } from "graphql";
import { type Kysely } from "kysely";
import type { VetraGithubAuthDB } from "./db/schema.js";
import {
  deleteConnection,
  getConnection,
  saveConnection,
  type GithubConnection,
} from "./db/installations.js";
import {
  createRepo,
  exchangeDeviceCode,
  findInstallationId,
  findInstallationRepo,
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
    installationId: string;
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
          installationId: connection.installationId,
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

      getPushToken: async (
        _p: unknown,
        { environmentId }: { environmentId: string },
        ctx: AuthContext,
      ): Promise<{ token: string; expiresAt: string }> => {
        const did = requireDid(ctx);
        const connection = await getConnection(db, did, environmentId);
        if (!connection) throw ghError("NOT_CONNECTED");
        try {
          const repoName = connection.repoFullName.split("/").pop();
          return await mintInstallationToken(connection.installationId, repoName);
        } catch (error) {
          if (error instanceof ReinstallRequiredError) {
            await deleteConnection(db, did, environmentId);
            throw ghError("REINSTALL_REQUIRED");
          }
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

        const installationId = await findInstallationId(userAccessToken);
        if (!installationId) throw ghError("APP_NOT_INSTALLED");

        let repo;
        try {
          repo = await createRepo(userAccessToken, repoName);
        } catch (error) {
          if (error instanceof RepoAlreadyExistsError) {
            const existing = await findInstallationRepo(installationId, repoName);
            if (!existing) throw ghError("REPO_ALREADY_EXISTS");
            repo = existing;
          } else {
            throw error;
          }
        }

        const connection = await saveConnection(
          db,
          did,
          environmentId,
          installationId,
          repo.fullName,
        );
        return toStatus(connection);
      },
    },
  };
}
