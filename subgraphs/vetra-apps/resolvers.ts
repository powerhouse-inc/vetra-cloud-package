import { GraphQLError } from "graphql";
import { envUrls } from "./envs.js";
import {
  bearerHasVetraClaim,
  requireCaller as requireAnyCaller,
  type AppsContext,
  type Caller,
} from "./auth.js";
import { appsError, githubErrors } from "./errors.js";
import { GithubHttpError, GithubUnavailableError } from "./github.js";
import {
  hasStudioSecretHeader,
  presentedStudioSecret,
  rotateStudioLaunchSecret,
} from "./studio-binding.js";

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
  attachStudioRepository,
  clearExternalChanges,
  confirmAppIdentity,
  connectGithubDeploy,
  createApp,
  createStudioApp,
  deleteApp,
  deployApp,
  ensureStudioProduct,
  githubDeployAppInfo,
  launchStudioVersion,
  recordStudioMirror,
  rollbackStudioVersion,
  setStudioProductDrive,
  studioDeploymentFor,
  studioPushToken,
  type AttachStudioRepositoryInput,
  type LaunchStudioVersionInput,
  githubDeployRepositories,
  myApps,
  myGithubDeployInstallations,
  openAppSetupPullRequest,
  renownAuthorizeUrl,
  rollbackApp,
  studioProductFor,
  updateApp,
  type AppsDeps,
  type CreateAppInput,
  type EnsureStudioProductInput,
  type StudioProductAuth,
  type CreateStudioAppInput,
  type DeployAppInput,
  type UpdateAppInput,
} from "./service.js";
import {
  appRepository,
  latestDeployment,
  listPreviews,
  parsePackages,
  type AppRow,
  type DeploymentRow,
} from "./repo.js";

/**
 * Resolver errors that are not GraphQLErrors (GitHub/Harbor/Renown/reactor
 * failures) are logged at error level with the resolver name and surfaced
 * with a generic message, so upstream response bodies never leak to callers.
 * GitHub being down (5xx, no answer) or a revoked user token (401) get their
 * customer codes.
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
    // GitHub down or the user's token revoked: say so, whatever the resolver.
    if (
      err instanceof GithubUnavailableError ||
      (err instanceof GithubHttpError && err.status >= 500)
    ) {
      deps.logger.warn(`[vetra-apps] ${name} failed: ${String(err)}`);
      throw githubErrors.unavailable();
    }
    if (err instanceof GithubHttpError && err.status === 401) {
      deps.logger.warn(`[vetra-apps] ${name} failed: ${String(err)}`);
      throw githubErrors.notConnected();
    }
    // Production logs at warn: an unexpected failure is an error. The step
    // is the resolver name; upstream bodies stay in the log, never the reply.
    deps.logger.error(`[vetra-apps] ${name} failed: ${String(err)}`);
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
    trigger: d.trigger ?? null,
    onBehalfOf: d.on_behalf_of ?? null,
    versionNumber: d.version_number ?? null,
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

/** The Studio-agent path when the request carries the launch secret header (even empty). */
function studioAuth(ctx: AppsContext): StudioProductAuth {
  return hasStudioSecretHeader(ctx)
    ? { kind: "agent", secret: presentedStudioSecret(ctx) }
    : { kind: "owner" };
}

function mapApp(deps: AppsDeps, app: AppRow) {
  const repo = appRepository(app);
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    ownerAddress: app.owner_address,
    ownerOrgId: app.owner_org_id ?? null,
    studioEnvironmentId: app.studio_environment_id ?? null,
    status: app.status,
    repository: repo
      ? {
          ...repo,
          accountLogin: app.repository_account_login ?? null,
          accountType: app.repository_account_type ?? null,
          disconnectedAt: app.repository_disconnected_at ?? null,
        }
      : null,
    productDriveId: app.product_drive_id ?? null,
    launchedAt: app.launched_at ?? null,
    externalChangesSha: app.external_changes_sha ?? null,
    productionBranch: app.production_branch,
    productionEnvironmentId: app.production_environment_id,
    previewsEnabled: app.previews_enabled,
    previewLimit: app.preview_limit,
    previewTtlDays: app.preview_ttl_days,
    harborProject: app.harbor_project,
    identityDid: app.identity_did,
    identityExpiresAt: app.identity_expires_at ?? null,
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
          prUrl: repo
            ? `https://github.com/${repo.fullName}/pull/${p.pr_number}`
            : "",
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
      myApps: (
        _: unknown,
        {
          orgId,
          includeStudioProducts,
        }: { orgId?: string | null; includeStudioProducts?: boolean | null },
        ctx: AppsContext,
      ) =>
        guard(deps, "myApps", async () =>
          (
            await myApps(deps, requireCaller(ctx), orgId, {
              includeStudioProducts,
            })
          ).map((a) =>
            mapApp(deps, a),
          ),
        ),
      app: (_: unknown, { id }: { id: string }, ctx: AppsContext) =>
        guard(deps, "app", async () => {
          const caller = requireCaller(ctx);
          try {
            return mapApp(
              deps,
              await appForOwner(deps, caller, id, {
                includeDeleted: true,
                need: "view",
              }),
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
      studioProduct: (
        _: unknown,
        { studioEnvironmentId }: { studioEnvironmentId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "studioProduct", async () => {
          const app = await studioProductFor(
            deps,
            requireCaller(ctx),
            studioEnvironmentId,
            studioAuth(ctx),
          );
          return app ? mapApp(deps, app) : null;
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
      studioDeployment: (_: unknown, { id }: { id: string }, ctx: AppsContext) =>
        guard(deps, "studioDeployment", async () => {
          const d = await studioDeploymentFor(
            deps,
            requireCaller(ctx),
            id,
            presentedStudioSecret(ctx),
          );
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
      createStudioApp: (
        _: unknown,
        { input }: { input: CreateStudioAppInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "createStudioApp", async () =>
          mapApp(deps, await createStudioApp(deps, requireCaller(ctx), input)),
        ),
      ensureStudioProduct: (
        _: unknown,
        { input }: { input: EnsureStudioProductInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "ensureStudioProduct", async () =>
          mapApp(
            deps,
            await ensureStudioProduct(
              deps,
              requireCaller(ctx),
              input,
              studioAuth(ctx),
            ),
          ),
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
      launchStudioVersion: (
        _: unknown,
        { input }: { input: LaunchStudioVersionInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "launchStudioVersion", async () =>
          mapDeployment(
            deps,
            await launchStudioVersion(
              deps,
              requireCaller(ctx),
              input,
              presentedStudioSecret(ctx),
            ),
          ),
        ),
      rollbackStudioVersion: (
        _: unknown,
        { deploymentId }: { deploymentId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "rollbackStudioVersion", async () =>
          mapDeployment(
            deps,
            await rollbackStudioVersion(
              deps,
              requireCaller(ctx),
              deploymentId,
              presentedStudioSecret(ctx),
            ),
          ),
        ),
      setStudioProductDrive: (
        _: unknown,
        { appId, driveId }: { appId: string; driveId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "setStudioProductDrive", async () =>
          mapApp(
            deps,
            await setStudioProductDrive(
              deps,
              requireCaller(ctx),
              appId,
              driveId,
              presentedStudioSecret(ctx),
            ),
          ),
        ),
      attachStudioRepository: (
        _: unknown,
        { input }: { input: AttachStudioRepositoryInput },
        ctx: AppsContext,
      ) =>
        guard(deps, "attachStudioRepository", async () =>
          mapApp(
            deps,
            await attachStudioRepository(
              deps,
              requireCaller(ctx),
              input,
              studioAuth(ctx),
            ),
          ),
        ),
      studioPushToken: (
        _: unknown,
        { appId }: { appId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "studioPushToken", () =>
          studioPushToken(
            deps,
            requireCaller(ctx),
            appId,
            presentedStudioSecret(ctx),
          ),
        ),
      recordStudioMirror: (
        _: unknown,
        { appId, sha }: { appId: string; sha: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "recordStudioMirror", () =>
          recordStudioMirror(
            deps,
            requireCaller(ctx),
            appId,
            sha,
            presentedStudioSecret(ctx),
          ),
        ),
      clearExternalChanges: (
        _: unknown,
        { appId }: { appId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "clearExternalChanges", () =>
          clearExternalChanges(
            deps,
            requireCaller(ctx),
            appId,
            presentedStudioSecret(ctx),
          ),
        ),
      rotateStudioLaunchSecret: (
        _: unknown,
        { environmentId }: { environmentId: string },
        ctx: AppsContext,
      ) =>
        guard(deps, "rotateStudioLaunchSecret", () =>
          rotateStudioLaunchSecret(deps, requireCaller(ctx), environmentId),
        ),
    },
  };
}
