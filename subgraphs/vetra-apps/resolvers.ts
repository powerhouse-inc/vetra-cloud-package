import { GraphQLError } from "graphql";
import { envUrls } from "./envs.js";
import {
  bearerHasVetraClaim,
  requireCaller as requireAnyCaller,
  type AppsContext,
  type Caller,
} from "./auth.js";
import { appsError } from "./errors.js";

/**
 * GraphQL is for people (owner / admin). CI workload tokens (bearer with a
 * `vetra` claim) are refused outright; they use the HTTP routes in ci.ts.
 */
function requireCaller(ctx: AppsContext): Caller {
  const caller = requireAnyCaller(ctx);
  if (bearerHasVetraClaim(ctx)) {
    throw appsError(
      "FORBIDDEN",
      "CI tokens are only accepted by the vetra-apps CI routes",
    );
  }
  return caller;
}
import {
  appDeploymentFor,
  appDeploymentsFor,
  appForOwner,
  appRegistryCredentials,
  confirmAppIdentity,
  connectGithubDeploy,
  createApp,
  deleteApp,
  deployApp,
  githubDeployAppInfo,
  githubDeployRepositories,
  myApps,
  myGithubDeployInstallations,
  openAppSetupPullRequest,
  renownAuthorizeUrl,
  rollbackApp,
  updateApp,
  type AppsDeps,
  type CreateAppInput,
  type DeployAppInput,
  type UpdateAppInput,
} from "./service.js";
import {
  latestDeployment,
  listPreviews,
  parsePackages,
  type AppRow,
  type DeploymentRow,
} from "./repo.js";

/**
 * Resolver errors that are not GraphQLErrors (GitHub/Harbor/Renown/reactor
 * failures) are logged and surfaced with a generic message, so upstream
 * response bodies never leak to callers.
 */
async function guard<T>(
  deps: AppsDeps,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    deps.logger.warn(`[vetra-apps] ${name} failed: ${String(err)}`);
    throw new GraphQLError(`${name} failed`, {
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  }
}

/** AppDeployment fields without `urls` (shared with the CI HTTP routes). */
export function deploymentFields(d: DeploymentRow) {
  return {
    id: d.id,
    appId: d.app_id,
    environmentId: d.environment_id,
    kind: d.kind,
    prNumber: d.pr_number,
    gitRef: d.git_ref,
    sha: d.sha,
    packages: parsePackages(d.packages),
    imageTag: d.image_tag,
    status: d.status,
    actorDid: d.actor_did,
    actorGithub: d.actor_github,
    runUrl: d.run_url,
    error: d.error,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

function mapDeployment(deps: AppsDeps, d: DeploymentRow) {
  return {
    ...deploymentFields(d),
    urls: async () =>
      envUrls(
        d.environment_id ? await deps.envs.getState(d.environment_id) : null,
      ),
  };
}

function mapApp(deps: AppsDeps, app: AppRow) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    ownerAddress: app.owner_address,
    status: app.status,
    repository: {
      installationId: app.installation_id,
      repositoryId: app.repository_id,
      fullName: app.repository_full_name,
    },
    productionBranch: app.production_branch,
    productionEnvironmentId: app.production_environment_id,
    previewsEnabled: app.previews_enabled,
    previewLimit: app.preview_limit,
    previewTtlDays: app.preview_ttl_days,
    harborProject: app.harbor_project,
    identityDid: app.identity_did,
    renownAuthorizeUrl: renownAuthorizeUrl(deps, app),
    createdAt: app.created_at,
    updatedAt: app.updated_at,
    productionUrls: async () =>
      envUrls(await deps.envs.getState(app.production_environment_id)),
    previews: async () =>
      Promise.all(
        (await listPreviews(deps.db, app.id)).map(async (p) => ({
          environmentId: p.environment_id,
          prNumber: p.pr_number,
          gitRef: p.git_ref,
          prUrl: `https://github.com/${app.repository_full_name}/pull/${p.pr_number}`,
          lastDeployedAt: p.last_deployed_at,
          status:
            (await latestDeployment(deps.db, app.id, p.environment_id))
              ?.status ?? null,
          urls: envUrls(await deps.envs.getState(p.environment_id)),
        })),
      ),
    latestDeployment: async () => {
      const d = await latestDeployment(deps.db, app.id);
      return d ? mapDeployment(deps, d) : null;
    },
  };
}

export function createResolvers(deps: AppsDeps) {
  return {
    Query: {
      myApps: (_: unknown, __: unknown, ctx: AppsContext) =>
        guard(deps, "myApps", async () =>
          (await myApps(deps, requireCaller(ctx))).map((a) => mapApp(deps, a)),
        ),
      app: (_: unknown, { id }: { id: string }, ctx: AppsContext) =>
        guard(deps, "app", async () => {
          const caller = requireCaller(ctx);
          try {
            return mapApp(
              deps,
              await appForOwner(deps, caller, id, { includeDeleted: true }),
            );
          } catch (err) {
            if (
              err instanceof GraphQLError &&
              err.extensions.code === "NOT_FOUND"
            )
              return null;
            throw err;
          }
        }),
      appDeployments: (
        _: unknown,
        { appId, limit }: { appId: string; limit?: number | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "appDeployments", async () =>
          (await appDeploymentsFor(deps, requireCaller(ctx), appId, limit)).map(
            (d) => mapDeployment(deps, d),
          ),
        ),
      appDeployment: (_: unknown, { id }: { id: string }, ctx: AppsContext) =>
        guard(deps, "appDeployment", async () => {
          const d = await appDeploymentFor(deps, requireCaller(ctx), id);
          return d ? mapDeployment(deps, d) : null;
        }),
      githubDeployAppInfo: (_: unknown, __: unknown, ctx: AppsContext) =>
        guard(deps, "githubDeployAppInfo", () => {
          requireCaller(ctx);
          return Promise.resolve(githubDeployAppInfo(deps));
        }),
      myGithubDeployInstallations: (
        _: unknown,
        __: unknown,
        ctx: AppsContext,
      ) =>
        guard(deps, "myGithubDeployInstallations", () =>
          myGithubDeployInstallations(deps, requireCaller(ctx)),
        ),
      githubDeployRepositories: (
        _: unknown,
        { installationId }: { installationId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "githubDeployRepositories", () =>
          githubDeployRepositories(deps, requireCaller(ctx), installationId),
        ),
    },
    Mutation: {
      connectGithubDeploy: (
        _: unknown,
        { code }: { code: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "connectGithubDeploy", () =>
          connectGithubDeploy(deps, requireCaller(ctx), code),
        ),
      createApp: (
        _: unknown,
        { input }: { input: CreateAppInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "createApp", async () =>
          mapApp(deps, await createApp(deps, requireCaller(ctx), input)),
        ),
      confirmAppIdentity: (
        _: unknown,
        { appId }: { appId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "confirmAppIdentity", async () =>
          mapApp(
            deps,
            await confirmAppIdentity(deps, requireCaller(ctx), appId),
          ),
        ),
      updateApp: (
        _: unknown,
        { appId, input }: { appId: string; input: UpdateAppInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "updateApp", async () =>
          mapApp(deps, await updateApp(deps, requireCaller(ctx), appId, input)),
        ),
      deleteApp: (
        _: unknown,
        {
          appId,
          deleteEnvironments,
        }: { appId: string; deleteEnvironments: boolean },
        ctx: AppsContext,
      ) =>
        guard(deps, "deleteApp", () =>
          deleteApp(deps, requireCaller(ctx), appId, deleteEnvironments),
        ),
      openAppSetupPullRequest: (
        _: unknown,
        { appId }: { appId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "openAppSetupPullRequest", () =>
          openAppSetupPullRequest(deps, requireCaller(ctx), appId),
        ),
      appRegistryCredentials: (
        _: unknown,
        { appId }: { appId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "appRegistryCredentials", () =>
          appRegistryCredentials(deps, requireCaller(ctx), appId),
        ),
      deployApp: (
        _: unknown,
        { input }: { input: DeployAppInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "deployApp", async () =>
          mapDeployment(deps, await deployApp(deps, requireCaller(ctx), input)),
        ),
      rollbackApp: (
        _: unknown,
        { deploymentId }: { deploymentId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "rollbackApp", async () =>
          mapDeployment(
            deps,
            await rollbackApp(deps, requireCaller(ctx), deploymentId),
          ),
        ),
    },
  };
}
