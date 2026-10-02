import type { Kysely } from "kysely";
import type { Action } from "document-model";
import {
  addPackage,
  approveChanges,
  clearAppLink,
  enableService,
  initialize,
  setAppLink,
  setDefaultPackageRegistry,
  setFusionConfig,
  setLabel,
  setOwner,
  setServiceVersion,
  wakeEnvironment,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { VetraAppsConfig } from "./config.js";
import type { AppDeploymentKind, VetraAppsDB } from "./db/schema.js";
import type { EnvGateway } from "./envs.js";
import type { GithubDeployApi, GithubRepo } from "./github.js";
import type { HarborApi } from "./harbor.js";
import type { RenownApi } from "./renown.js";
import type { Caller, VetraClaim } from "./auth.js";
import { appsError, notConfigured } from "./errors.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  getApp,
  getAppByIdentity,
  getDeployment,
  getPreview,
  listPreviews,
  normalizeApp,
  parsePackages,
  updateDeployment,
  type AppRow,
  type DeploymentRow,
  type PreviewRow,
} from "./repo.js";
import { workflowTemplate } from "./workflow-template.js";

export interface AppsLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface AppsDeps {
  db: Kysely<VetraAppsDB>;
  envs: EnvGateway;
  cfg: VetraAppsConfig;
  github: GithubDeployApi | null;
  harbor: HarborApi | null;
  renown: RenownApi | null;
  generateSubdomain: (documentId: string) => string;
  now: () => Date;
  newId: () => string;
  logger: AppsLogger;
  /** Called after a deployment row changes state (GitHub feedback). Best effort. */
  onDeploymentChanged?: (deploymentId: string) => Promise<void>;
}

export const DEFAULT_PREVIEW_LIMIT = 5;
export const DEFAULT_PREVIEW_TTL_DAYS = 7;
export const PREVIEW_COMMENT_MARKER = "<!-- vetra-preview -->";
const RELEASED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);
const HARBOR_HOST = "cr.vetra.io";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** kebab-case slug for names (Harbor project names allow [a-z0-9._-]). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "app";
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_NAME =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const BRANCH =
  /^(?!\/|.*\/\/|.*\.\.|.*@\{)[A-Za-z0-9._/-]{1,200}(?<!\/|\.lock)$/;

function assertBranch(branch: string): void {
  if (!BRANCH.test(branch))
    throw appsError("BAD_USER_INPUT", `Invalid branch name '${branch}'`);
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Owner-level access: the owner signed in as themselves, or an admin. A token
 * of any App identity (CI) is refused here — CI may only deploy, fetch its
 * registry credentials and read its deployments. That keeps a PR-branch token
 * from e.g. rolling back production or editing the App.
 */
async function loadAppForOwner(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<AppRow> {
  await assertNotWorkload(deps, caller);
  const app = await getApp(deps.db, appId);
  if (!app) throw appsError("NOT_FOUND", "App not found");
  if (app.owner_address !== caller.address && !caller.isAdmin) {
    throw appsError("FORBIDDEN", "Not the owner of this App");
  }
  return app;
}

async function assertNotWorkload(
  deps: AppsDeps,
  caller: Caller,
): Promise<void> {
  if (caller.appKey && (await getAppByIdentity(deps.db, caller.appKey))) {
    throw appsError("FORBIDDEN", "App identities can only deploy");
  }
}

/** Owner / admin, or this App's own identity (CI). */
async function loadAppForDeployer(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<{ app: AppRow; viaIdentity: boolean }> {
  const app = await getApp(deps.db, appId);
  if (!app) throw appsError("NOT_FOUND", "App not found");
  if (caller.appKey && caller.appKey === app.identity_did) {
    if (caller.address !== app.owner_address) {
      throw appsError(
        "FORBIDDEN",
        "App identity does not act for this App's owner",
      );
    }
    return { app, viaIdentity: true };
  }
  await assertNotWorkload(deps, caller);
  if (app.owner_address === caller.address || caller.isAdmin)
    return { app, viaIdentity: false };
  throw appsError("FORBIDDEN", "Not allowed to deploy this App");
}

// ---------------------------------------------------------------------------
// GitHub connection
// ---------------------------------------------------------------------------

function requireGithub(deps: AppsDeps): GithubDeployApi {
  if (!deps.github || !deps.cfg.github)
    throw notConfigured("The Vetra Deploy GitHub App");
  return deps.github;
}

export function githubDeployAppInfo(deps: AppsDeps) {
  const gh = deps.cfg.github;
  if (!gh) throw notConfigured("The Vetra Deploy GitHub App");
  return {
    slug: gh.slug,
    installUrl: `https://github.com/apps/${encodeURIComponent(gh.slug)}/installations/new`,
    authorizeUrl: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(gh.clientId)}`,
  };
}

export async function connectGithubDeploy(
  deps: AppsDeps,
  caller: Caller,
  code: string,
) {
  await assertNotWorkload(deps, caller);
  const github = requireGithub(deps);
  if (!code.trim()) throw appsError("BAD_USER_INPUT", "Missing OAuth code");
  let userToken: string;
  try {
    userToken = await github.exchangeOAuthCode(code.trim());
  } catch (err) {
    throw appsError(
      "BAD_USER_INPUT",
      `GitHub authorization failed: ${String(err)}`,
    );
  }
  const ours = (await github.listUserInstallations(userToken)).filter(
    (i) => i.appId === deps.cfg.github!.appId,
  );
  const nowIso = deps.now().toISOString();
  for (const i of ours) {
    await deps.db
      .insertInto("github_deploy_connections")
      .values({
        owner_address: caller.address,
        installation_id: i.installationId,
        account_login: i.accountLogin,
        account_type: i.accountType,
        created_at: nowIso,
      })
      .onConflict((oc) =>
        oc.columns(["owner_address", "installation_id"]).doUpdateSet({
          account_login: i.accountLogin,
          account_type: i.accountType,
        }),
      )
      .execute();
  }
  return myGithubDeployInstallations(deps, caller);
}

export async function myGithubDeployInstallations(
  deps: AppsDeps,
  caller: Caller,
) {
  const rows = await deps.db
    .selectFrom("github_deploy_connections")
    .selectAll()
    .where("owner_address", "=", caller.address)
    .orderBy("account_login")
    .execute();
  return rows.map((r) => ({
    installationId: r.installation_id,
    accountLogin: r.account_login,
    accountType: r.account_type,
  }));
}

async function requireConnection(
  deps: AppsDeps,
  caller: Caller,
  installationId: string,
) {
  const row = await deps.db
    .selectFrom("github_deploy_connections")
    .select("installation_id")
    .where("owner_address", "=", caller.address)
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
  if (!row)
    throw appsError(
      "GITHUB_NOT_CONNECTED",
      "Connect this GitHub installation first",
    );
}

export async function githubDeployRepositories(
  deps: AppsDeps,
  caller: Caller,
  installationId: string,
): Promise<GithubRepo[]> {
  await assertNotWorkload(deps, caller);
  const github = requireGithub(deps);
  await requireConnection(deps, caller, installationId);
  return github.listInstallationRepos(installationId);
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export async function myApps(
  deps: AppsDeps,
  caller: Caller,
): Promise<AppRow[]> {
  await assertNotWorkload(deps, caller);
  const rows = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("owner_address", "=", caller.address)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map(normalizeApp);
}

export async function appForOwner(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  return loadAppForOwner(deps, caller, appId);
}

async function uniqueSlug(deps: AppsDeps, name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set(
    (
      await deps.db
        .selectFrom("apps")
        .select("slug")
        .where((eb) =>
          eb.or([eb("slug", "=", base), eb("slug", "like", `${base}-%`)]),
        )
        .execute()
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function renownAuthorizeUrl(deps: AppsDeps, app: AppRow): string {
  const returnUrl = `${deps.cfg.vetraAppUrl}/user/apps/${app.id}?identity=1`;
  return `${deps.cfg.renownWebUrl}/?app=${encodeURIComponent(app.identity_did)}&returnUrl=${encodeURIComponent(returnUrl)}`;
}

export interface CreateAppInput {
  name: string;
  installationId: string;
  repositoryId: string;
  productionBranch?: string | null;
  productionEnvironmentId?: string | null;
}

export async function createApp(
  deps: AppsDeps,
  caller: Caller,
  input: CreateAppInput,
): Promise<AppRow> {
  await assertNotWorkload(deps, caller);
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw appsError("BAD_USER_INPUT", "Name must be 1-100 characters");
  const github = requireGithub(deps);
  if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
  if (!deps.renown) throw notConfigured("Renown workload identities");
  if (!deps.cfg.encryptionKey) throw notConfigured("VETRA_APPS_ENCRYPTION_KEY");
  await requireConnection(deps, caller, input.installationId);

  const repo = (await github.listInstallationRepos(input.installationId)).find(
    (r) => r.id === String(input.repositoryId),
  );
  if (!repo)
    throw appsError(
      "BAD_USER_INPUT",
      "Repository is not part of this installation",
    );
  const existing = await deps.db
    .selectFrom("apps")
    .select("id")
    .where("repository_id", "=", repo.id)
    .executeTakeFirst();
  if (existing)
    throw appsError(
      "BAD_USER_INPUT",
      "This repository is already connected to an App",
    );

  const productionBranch = input.productionBranch?.trim() || "main";
  assertBranch(productionBranch);

  // Attaching an existing env: caller must own it and it must be standalone.
  let attachEnvState: VetraCloudEnvironmentState | null = null;
  if (input.productionEnvironmentId) {
    attachEnvState = await deps.envs.getState(input.productionEnvironmentId);
    if (!attachEnvState) throw appsError("NOT_FOUND", "Environment not found");
    if ((attachEnvState.owner ?? "").toLowerCase() !== caller.address) {
      throw appsError("FORBIDDEN", "You do not own this environment");
    }
    if (attachEnvState.app)
      throw appsError(
        "BAD_USER_INPUT",
        "Environment already belongs to an App",
      );
    if (RELEASED_STATUSES.has(attachEnvState.status)) {
      throw appsError("BAD_USER_INPUT", "Environment is terminated");
    }
  }

  const slug = await uniqueSlug(deps, name);
  const harborProject = `app-${slug}`;
  await deps.harbor.ensureProject(harborProject);
  const robot = await deps.harbor.createPushRobot(harborProject);
  const { did } = await deps.renown.registerWorkloadIdentity({
    repositoryId: repo.id,
    repository: repo.fullName,
    productionBranch,
    ownerAddress: caller.address,
    chainId: caller.chainId,
  });

  const appId = deps.newId();
  const link = setAppLink({
    appId,
    role: "PRODUCTION",
    prNumber: null,
    gitRef: `refs/heads/${productionBranch}`,
    imageProject: harborProject,
  });
  // The apps row goes in before the env actions: the gitops render resolves
  // the App's Harbor project from it (see app-image-project.ts).
  const attach = Boolean(input.productionEnvironmentId && attachEnvState);
  const envId = attach
    ? input.productionEnvironmentId!
    : await deps.envs.create();
  const nowIso = deps.now().toISOString();
  await deps.db
    .insertInto("apps")
    .values({
      id: appId,
      slug,
      name,
      owner_address: caller.address,
      owner_chain_id: caller.chainId,
      status: "PENDING_IDENTITY",
      installation_id: input.installationId,
      repository_id: repo.id,
      repository_full_name: repo.fullName,
      production_branch: productionBranch,
      production_environment_id: envId,
      previews_enabled: true,
      preview_limit: DEFAULT_PREVIEW_LIMIT,
      preview_ttl_days: DEFAULT_PREVIEW_TTL_DAYS,
      harbor_project: harborProject,
      harbor_robot_name: robot.name,
      harbor_robot_secret_enc: encryptSecret(
        deps.cfg.encryptionKey,
        robot.secret,
      ),
      identity_did: did,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute();
  try {
    if (attach) {
      const wasReady = attachEnvState!.status === "READY";
      // The link widens the FUSION allowlist, so it re-renders; re-approve only
      // a settled env (never ship an owner's unapproved pending edits).
      await deps.envs.execute(
        envId,
        wasReady ? [link, approveChanges({})] : [link],
      );
    } else {
      await deps.envs.execute(envId, [
        setLabel({ label: name }),
        initialize({
          genericSubdomain: deps.generateSubdomain(envId),
          genericBaseDomain: "vetra.io",
          defaultPackageRegistry: deps.cfg.productionRegistry,
        }),
        setOwner({ address: caller.address }),
        link,
        enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
        enableService({ type: "CONNECT", prefix: "connect" }),
        approveChanges({}),
      ]);
    }
  } catch (err) {
    await deps.db.deleteFrom("apps").where("id", "=", appId).execute();
    throw err;
  }
  deps.logger.info(
    `[vetra-apps] created App ${slug} (${appId}) for ${repo.fullName}, env ${envId}`,
  );
  return (await getApp(deps.db, appId))!;
}

export async function confirmAppIdentity(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  const app = await loadAppForOwner(deps, caller, appId);
  if (app.status !== "PENDING_IDENTITY") return app;
  if (!deps.renown) throw notConfigured("Renown workload identities");
  const ok = await deps.renown.hasDelegation({
    address: app.owner_address,
    chainId: app.owner_chain_id,
    did: app.identity_did,
  });
  if (!ok) return app;
  await deps.db
    .updateTable("apps")
    .set({ status: "ACTIVE", updated_at: deps.now().toISOString() })
    .where("id", "=", app.id)
    .execute();
  return (await getApp(deps.db, app.id))!;
}

export interface UpdateAppInput {
  name?: string | null;
  productionBranch?: string | null;
  previewsEnabled?: boolean | null;
  previewLimit?: number | null;
  previewTtlDays?: number | null;
}

export async function updateApp(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  input: UpdateAppInput,
): Promise<AppRow> {
  const app = await loadAppForOwner(deps, caller, appId);
  const patch: Partial<AppRow> = {};
  if (input.name != null) {
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw appsError("BAD_USER_INPUT", "Name must be 1-100 characters");
    patch.name = name;
  }
  if (input.previewLimit != null) {
    if (
      !Number.isInteger(input.previewLimit) ||
      input.previewLimit < 1 ||
      input.previewLimit > 20
    ) {
      throw appsError("BAD_USER_INPUT", "previewLimit must be 1-20");
    }
    patch.preview_limit = input.previewLimit;
  }
  if (input.previewTtlDays != null) {
    if (
      !Number.isInteger(input.previewTtlDays) ||
      input.previewTtlDays < 1 ||
      input.previewTtlDays > 90
    ) {
      throw appsError("BAD_USER_INPUT", "previewTtlDays must be 1-90");
    }
    patch.preview_ttl_days = input.previewTtlDays;
  }
  if (input.previewsEnabled != null)
    patch.previews_enabled = input.previewsEnabled;
  if (
    input.productionBranch != null &&
    input.productionBranch.trim() !== app.production_branch
  ) {
    const branch = input.productionBranch.trim();
    assertBranch(branch);
    // Renown decides which ref may mint production tokens: keep it in sync first.
    if (!deps.renown) throw notConfigured("Renown workload identities");
    await deps.renown.updateWorkloadIdentity(app.identity_did, {
      productionBranch: branch,
    });
    patch.production_branch = branch;
  }
  if (Object.keys(patch).length > 0) {
    await deps.db
      .updateTable("apps")
      .set({ ...patch, updated_at: deps.now().toISOString() })
      .where("id", "=", app.id)
      .execute();
  }
  return (await getApp(deps.db, app.id))!;
}

/**
 * Delete a preview env. Only ever deletes a document whose own App link says
 * it is a PREVIEW of this App — never a production or standalone env, even if
 * a preview row points at one by mistake.
 */
export async function deletePreview(
  deps: AppsDeps,
  app: AppRow,
  preview: PreviewRow,
  reason: string,
): Promise<void> {
  const state = await deps.envs.getState(preview.environment_id);
  if (state) {
    if (state.app?.role === "PREVIEW" && state.app.appId === app.id) {
      await deps.envs.delete(preview.environment_id);
    } else {
      deps.logger.warn(
        `[vetra-apps] refusing to delete ${preview.environment_id} for ${app.slug} PR #${preview.pr_number}: not a preview of this App`,
      );
    }
  }
  await deps.db
    .deleteFrom("app_previews")
    .where("app_id", "=", app.id)
    .where("pr_number", "=", preview.pr_number)
    .execute();
  const nowIso = deps.now().toISOString();
  const superseded = await deps.db
    .updateTable("app_deployments")
    .set({ status: "SUPERSEDED", updated_at: nowIso, error: reason })
    .where("app_id", "=", app.id)
    .where("environment_id", "=", preview.environment_id)
    .where("status", "in", ["PENDING", "DEPLOYING", "READY", "FAILED"])
    .returning("id")
    .execute();
  deps.logger.info(
    `[vetra-apps] deleted preview of ${app.slug} PR #${preview.pr_number} (${reason})`,
  );
  for (const d of superseded) await notifyChanged(deps, d.id);
}

export async function deletePreviewsOfApp(
  deps: AppsDeps,
  app: AppRow,
  reason: string,
) {
  for (const p of await listPreviews(deps.db, app.id)) {
    try {
      await deletePreview(deps, app, p, reason);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] deleting preview ${p.environment_id} failed: ${String(err)}`,
      );
    }
  }
}

export async function deleteApp(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  deleteEnvironments: boolean,
): Promise<boolean> {
  const app = await loadAppForOwner(deps, caller, appId);
  await deletePreviewsOfApp(deps, app, "app deleted");
  const prod = await deps.envs.getState(app.production_environment_id);
  if (prod?.app?.appId === app.id) {
    if (deleteEnvironments)
      await deps.envs.delete(app.production_environment_id);
    else
      await deps.envs.execute(app.production_environment_id, [
        clearAppLink({}),
      ]);
  }
  if (deps.renown) {
    try {
      await deps.renown.deleteWorkloadIdentity(app.identity_did);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] renown delete ${app.identity_did} failed: ${String(err)}`,
      );
    }
  }
  await deps.db
    .deleteFrom("app_deployments")
    .where("app_id", "=", app.id)
    .execute();
  await deps.db.deleteFrom("apps").where("id", "=", app.id).execute();
  deps.logger.info(`[vetra-apps] deleted App ${app.slug} (${app.id})`);
  return true;
}

export async function openAppSetupPullRequest(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<string> {
  const app = await loadAppForOwner(deps, caller, appId);
  const github = requireGithub(deps);
  return github.openPullRequestWithFile(
    app.installation_id,
    app.repository_full_name,
    {
      branch: "vetra/setup",
      path: ".github/workflows/vetra.yml",
      content: workflowTemplate(app.id, app.production_branch),
      commitMessage: "ci: deploy with Vetra",
      title: "Deploy with Vetra",
      body: [
        "Adds `.github/workflows/vetra.yml`, which builds, publishes and deploys this repository with",
        "[powerhouse-inc/vetra-deploy-action](https://github.com/powerhouse-inc/vetra-deploy-action):",
        "",
        `- pushes to \`${app.production_branch}\` deploy the production environment,`,
        "- pull requests get a preview environment,",
        "- `v*` tags publish a release.",
        "",
        `App: ${deps.cfg.vetraAppUrl}/user/apps/${app.id}`,
      ].join("\n"),
    },
  );
}

export async function appRegistryCredentials(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  const { app } = await loadAppForDeployer(deps, caller, appId);
  if (!deps.cfg.encryptionKey) throw notConfigured("VETRA_APPS_ENCRYPTION_KEY");
  if (app.status === "DISCONNECTED")
    throw appsError("APP_NOT_ACTIVE", "App is disconnected");
  return {
    registry: HARBOR_HOST,
    project: app.harbor_project,
    username: app.harbor_robot_name,
    password: decryptSecret(
      deps.cfg.encryptionKey,
      app.harbor_robot_secret_enc,
    ),
  };
}

export async function appDeploymentsFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  limit: number | null | undefined,
): Promise<DeploymentRow[]> {
  const app = await loadAppForOwner(deps, caller, appId);
  return deps.db
    .selectFrom("app_deployments")
    .selectAll()
    .where("app_id", "=", app.id)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(limit ?? 50, 1), 200))
    .execute();
}

export async function appDeploymentFor(
  deps: AppsDeps,
  caller: Caller,
  deploymentId: string,
): Promise<DeploymentRow | null> {
  const d = await getDeployment(deps.db, deploymentId);
  if (!d) return null;
  await loadAppForDeployer(deps, caller, d.app_id);
  return d;
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export interface DeployAppInput {
  appId: string;
  kind: AppDeploymentKind;
  prNumber?: number | null;
  gitRef: string;
  sha: string;
  runUrl?: string | null;
  actorGithub?: string | null;
  packages: { name: string; version: string }[];
  imageTag?: string | null;
}

interface DeployRequest {
  kind: AppDeploymentKind;
  prNumber: number | null;
  gitRef: string;
  sha: string;
  runUrl: string | null;
  actorGithub: string | null;
  actorDid: string | null;
  packages: { name: string; version: string }[];
  /** Full image reference, already validated. */
  image: { repository: string; tag: string } | null;
}

function validatePackages(packages: { name: string; version: string }[]) {
  if (packages.length > 50)
    throw appsError("BAD_USER_INPUT", "Too many packages");
  const seen = new Set<string>();
  for (const p of packages) {
    if (!PACKAGE_NAME.test(p.name))
      throw appsError("BAD_USER_INPUT", `Invalid package name '${p.name}'`);
    if (!PACKAGE_VERSION.test(p.version)) {
      throw appsError(
        "BAD_USER_INPUT",
        `Invalid version '${p.version}' for ${p.name}`,
      );
    }
    if (seen.has(p.name))
      throw appsError("BAD_USER_INPUT", `Duplicate package '${p.name}'`);
    seen.add(p.name);
  }
}

/**
 * `imageTag` is either a bare tag (`sha-<sha12>`; repository = the production
 * env's App image, else `cr.vetra.io/<harborProject>/app`) or a full reference
 * `cr.vetra.io/<harborProject>/<name>:<tag>`. Images outside the App's own
 * Harbor project are refused.
 */
export function resolveImage(
  app: AppRow,
  imageTag: string | null | undefined,
  productionState: VetraCloudEnvironmentState | null,
): { repository: string; tag: string } | null {
  const raw = imageTag?.trim();
  if (!raw) return null;
  const prefix = `${HARBOR_HOST}/${app.harbor_project}/`;
  if (raw.includes("/")) {
    const colon = raw.lastIndexOf(":");
    const repository = colon > 0 ? raw.slice(0, colon) : "";
    const tag = colon > 0 ? raw.slice(colon + 1) : "";
    if (
      !repository.startsWith(prefix) ||
      !IMAGE_NAME.test(repository.slice(prefix.length))
    ) {
      throw appsError("BAD_USER_INPUT", `Image must be ${prefix}<name>:<tag>`);
    }
    if (!IMAGE_TAG.test(tag))
      throw appsError("BAD_USER_INPUT", `Invalid image tag '${tag}'`);
    return { repository, tag };
  }
  if (!IMAGE_TAG.test(raw))
    throw appsError("BAD_USER_INPUT", `Invalid image tag '${raw}'`);
  const current = productionState?.fusion?.image ?? null;
  const repository = current?.startsWith(prefix) ? current : `${prefix}app`;
  return { repository, tag: raw };
}

function expectedRef(
  app: AppRow,
  kind: AppDeploymentKind,
  prNumber: number | null,
): string {
  return kind === "PRODUCTION"
    ? `refs/heads/${app.production_branch}`
    : `refs/pull/${prNumber}/merge`;
}

export async function deployApp(
  deps: AppsDeps,
  caller: Caller,
  claim: VetraClaim | null,
  input: DeployAppInput,
): Promise<DeploymentRow> {
  const { app, viaIdentity } = await loadAppForDeployer(
    deps,
    caller,
    input.appId,
  );
  const kind = input.kind;
  const prNumber = kind === "PREVIEW" ? (input.prNumber ?? null) : null;
  if (
    kind === "PREVIEW" &&
    (prNumber === null || !Number.isInteger(prNumber) || prNumber < 1)
  ) {
    throw appsError("BAD_USER_INPUT", "PREVIEW deployments need a prNumber");
  }
  let gitRef = input.gitRef.trim();
  let actorGithub = input.actorGithub?.trim() || null;
  let runUrl = input.runUrl?.trim() || null;

  if (viaIdentity) {
    // A CI token may only deploy what its own run was minted for: the
    // production branch → PRODUCTION, refs/pull/<n>/merge → that PR's preview.
    const want = expectedRef(app, kind, prNumber);
    if (!claim) {
      throw appsError("FORBIDDEN", "App identity token carries no vetra claim");
    }
    if (claim.ref !== want) {
      throw appsError(
        "FORBIDDEN",
        `Token for ${claim.ref} cannot deploy ${kind} (needs ${want})`,
      );
    }
    if (claim.repositoryId && claim.repositoryId !== app.repository_id) {
      throw appsError("FORBIDDEN", "Token was minted for another repository");
    }
    gitRef = claim.ref;
    actorGithub = claim.actor ?? actorGithub;
  }
  if (app.status !== "ACTIVE")
    throw appsError("APP_NOT_ACTIVE", `App is ${app.status}`);
  if (!gitRef) throw appsError("BAD_USER_INPUT", "gitRef is required");
  if (!SHA.test(input.sha))
    throw appsError("BAD_USER_INPUT", "sha must be a git commit sha");
  if (runUrl && !/^https:\/\/github\.com\//.test(runUrl)) runUrl = null;
  validatePackages(input.packages);
  if (kind === "PREVIEW" && !app.previews_enabled) {
    throw appsError("PREVIEWS_DISABLED", "Previews are disabled for this App");
  }
  const productionState = await deps.envs.getState(
    app.production_environment_id,
  );
  const image = resolveImage(app, input.imageTag, productionState);

  return performDeploy(deps, app, productionState, {
    kind,
    prNumber,
    gitRef,
    sha: input.sha.toLowerCase(),
    runUrl,
    actorGithub,
    actorDid: viaIdentity
      ? caller.appKey
      : `did:pkh:eip155:${caller.chainId}:${caller.address}`,
    packages: input.packages.map((p) => ({ name: p.name, version: p.version })),
    image,
  });
}

export async function rollbackApp(
  deps: AppsDeps,
  caller: Caller,
  deploymentId: string,
): Promise<DeploymentRow> {
  const source = await getDeployment(deps.db, deploymentId);
  if (!source) throw appsError("NOT_FOUND", "Deployment not found");
  const app = await loadAppForOwner(deps, caller, source.app_id);
  if (source.status !== "READY")
    throw appsError(
      "BAD_USER_INPUT",
      "Only READY deployments can be rolled back to",
    );
  if (app.status !== "ACTIVE")
    throw appsError("APP_NOT_ACTIVE", `App is ${app.status}`);
  if (source.kind === "PREVIEW") {
    const preview = await getPreview(deps.db, app.id, source.pr_number ?? -1);
    if (!preview)
      throw appsError("BAD_USER_INPUT", "That preview no longer exists");
  }
  const productionState = await deps.envs.getState(
    app.production_environment_id,
  );
  return performDeploy(deps, app, productionState, {
    kind: source.kind,
    prNumber: source.pr_number,
    gitRef: source.git_ref,
    sha: source.sha,
    runUrl: null,
    actorGithub: "rollback",
    actorDid: `did:pkh:eip155:${caller.chainId}:${caller.address}`,
    packages: parsePackages(source.packages),
    image: source.image_tag ? splitImage(source.image_tag) : null,
  });
}

function splitImage(ref: string): { repository: string; tag: string } {
  const i = ref.lastIndexOf(":");
  return { repository: ref.slice(0, i), tag: ref.slice(i + 1) };
}

async function notifyChanged(deps: AppsDeps, deploymentId: string) {
  if (!deps.onDeploymentChanged) return;
  try {
    await deps.onDeploymentChanged(deploymentId);
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] feedback for ${deploymentId} failed: ${String(err)}`,
    );
  }
}

/** Find or create the PR's preview env; evicts the least recently deployed one at the limit. */
async function ensurePreview(
  deps: AppsDeps,
  app: AppRow,
  prNumber: number,
  gitRef: string,
  productionState: VetraCloudEnvironmentState | null,
): Promise<{
  preview: PreviewRow;
  created: boolean;
  createActions: Action[];
  fusionEnvTemplate: FusionEnvInput[];
}> {
  const existing = await getPreview(deps.db, app.id, prNumber);
  if (existing) {
    if (await deps.envs.getState(existing.environment_id)) {
      return {
        preview: existing,
        created: false,
        createActions: [],
        fusionEnvTemplate: [],
      };
    }
    // The env document is gone (deleted out of band): start a fresh preview.
    await deps.db
      .deleteFrom("app_previews")
      .where("app_id", "=", app.id)
      .where("pr_number", "=", prNumber)
      .execute();
  }

  const previews = await listPreviews(deps.db, app.id);
  if (previews.length >= app.preview_limit) {
    const evict = [...previews]
      .sort((a, b) => a.last_deployed_at.localeCompare(b.last_deployed_at))
      .slice(0, previews.length - app.preview_limit + 1);
    for (const p of evict)
      await deletePreview(deps, app, p, `preview limit (${app.preview_limit})`);
  }

  const envId = await deps.envs.create();
  // Non-secret FUSION env of production as the template; previews get no secrets.
  const fusionEnvTemplate: FusionEnvInput[] = (
    productionState?.fusion?.env ?? []
  )
    .filter((e) => e.isSecret !== true)
    .map((e) => ({ name: e.name, value: e.value ?? null, isSecret: false }));
  const createActions: Action[] = [
    setLabel({ label: `${app.name} PR #${prNumber}` }),
    initialize({
      genericSubdomain: deps.generateSubdomain(envId),
      genericBaseDomain: "vetra.io",
      defaultPackageRegistry: deps.cfg.previewRegistry,
    }),
    setOwner({ address: app.owner_address }),
    setAppLink({
      appId: app.id,
      role: "PREVIEW",
      prNumber,
      gitRef,
      imageProject: app.harbor_project,
    }),
    enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
    enableService({ type: "CONNECT", prefix: "connect" }),
  ];
  const nowIso = deps.now().toISOString();
  const preview: PreviewRow = {
    app_id: app.id,
    pr_number: prNumber,
    environment_id: envId,
    git_ref: gitRef,
    created_at: nowIso,
    last_deployed_at: nowIso,
  };
  await deps.db.insertInto("app_previews").values(preview).execute();
  return { preview, created: true, createActions, fusionEnvTemplate };
}

type FusionEnvInput = {
  name: string;
  value: string | null;
  isSecret: boolean | null;
};

/**
 * Actions that bring an env to the requested packages + image. `state` null =
 * a preview being created in the same batch (fresh: no FUSION yet), whose
 * FUSION env starts from `fusionEnvTemplate`.
 */
function contentActions(
  state: VetraCloudEnvironmentState | null,
  req: DeployRequest,
  registry: string,
  fusionEnvTemplate: FusionEnvInput[],
): Action[] {
  const actions: Action[] = [];
  if (
    req.packages.length > 0 &&
    state?.defaultPackageRegistry &&
    state.defaultPackageRegistry !== registry
  ) {
    actions.push(
      setDefaultPackageRegistry({ defaultPackageRegistry: registry }),
    );
  }
  for (const p of req.packages) {
    actions.push(
      addPackage({ packageName: p.name, version: p.version, registry }),
    );
  }
  if (req.image) {
    const fusionSvc = state?.services.find((s) => s.type === "FUSION");
    if (!fusionSvc?.enabled)
      actions.push(enableService({ type: "FUSION", prefix: "fusion" }));
    const fusion = state?.fusion ?? null;
    if (!fusion || fusion.image !== req.image.repository || fusion.autoUpdate) {
      actions.push(
        setFusionConfig({
          image: req.image.repository,
          env: fusion
            ? fusion.env.map((e) => ({
                name: e.name,
                value: e.value ?? null,
                isSecret: e.isSecret ?? null,
              }))
            : fusionEnvTemplate,
          // Deploys are explicit; the Harbor poller also skips App envs.
          autoUpdate: false,
          autoUpdateTagPattern: fusion?.autoUpdateTagPattern ?? null,
        }),
      );
    }
    actions.push(setServiceVersion({ type: "FUSION", version: req.image.tag }));
  } else if (!state && fusionEnvTemplate.length > 0) {
    // New preview without an image (yet): keep the template for later deploys.
    actions.push(
      setFusionConfig({
        image: null,
        env: fusionEnvTemplate,
        autoUpdate: false,
        autoUpdateTagPattern: null,
      }),
    );
  }
  return actions;
}

async function performDeploy(
  deps: AppsDeps,
  app: AppRow,
  productionState: VetraCloudEnvironmentState | null,
  req: DeployRequest,
): Promise<DeploymentRow> {
  const nowIso = deps.now().toISOString();
  const id = deps.newId();
  const registry =
    req.kind === "PRODUCTION"
      ? deps.cfg.productionRegistry
      : deps.cfg.previewRegistry;

  let envId: string;
  let state: VetraCloudEnvironmentState | null;
  let createActions: Action[] = [];
  let fusionEnvTemplate: FusionEnvInput[] = [];
  if (req.kind === "PRODUCTION") {
    envId = app.production_environment_id;
    state = productionState;
    if (!state)
      throw appsError("NOT_FOUND", "Production environment not found");
    if (state.app?.appId !== app.id || state.app.role !== "PRODUCTION") {
      throw appsError(
        "BAD_USER_INPUT",
        "Production environment is not linked to this App",
      );
    }
  } else {
    const ensured = await ensurePreview(
      deps,
      app,
      req.prNumber!,
      req.gitRef,
      productionState,
    );
    envId = ensured.preview.environment_id;
    createActions = ensured.createActions;
    fusionEnvTemplate = ensured.fusionEnvTemplate;
    state = ensured.created ? null : await deps.envs.getState(envId);
  }

  await deps.db
    .insertInto("app_deployments")
    .values({
      id,
      app_id: app.id,
      environment_id: envId,
      kind: req.kind,
      pr_number: req.prNumber,
      git_ref: req.gitRef,
      sha: req.sha,
      packages: JSON.stringify(req.packages),
      image_tag: req.image ? `${req.image.repository}:${req.image.tag}` : null,
      status: "PENDING",
      actor_did: req.actorDid,
      actor_github: req.actorGithub,
      run_url: req.runUrl,
      error: null,
      github_deployment_id: null,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute();
  // A newer deployment of the same env wins.
  const superseded = await deps.db
    .updateTable("app_deployments")
    .set({ status: "SUPERSEDED", updated_at: nowIso })
    .where("environment_id", "=", envId)
    .where("id", "!=", id)
    .where("status", "in", ACTIVE_DEPLOYMENT_STATUSES)
    .returning("id")
    .execute();
  for (const s of superseded) await notifyChanged(deps, s.id);

  try {
    if (state && RELEASED_STATUSES.has(state.status)) {
      throw new Error(`environment is ${state.status}`);
    }
    const actions: Action[] = [...createActions];
    if (state?.status === "STOPPED") actions.push(wakeEnvironment({}));
    const content = contentActions(state, req, registry, fusionEnvTemplate);
    actions.push(...content);
    const settled = state?.status ?? "DRAFT";
    if (
      createActions.length > 0 ||
      content.length > 0 ||
      settled === "DRAFT" ||
      settled === "CHANGES_PENDING"
    ) {
      actions.push(approveChanges({}));
    }
    if (actions.length > 0) await deps.envs.execute(envId, actions);
    await updateDeployment(
      deps.db,
      id,
      { status: "DEPLOYING" },
      deps.now().toISOString(),
    );
  } catch (err) {
    await updateDeployment(
      deps.db,
      id,
      {
        status: "FAILED",
        error: String(err instanceof Error ? err.message : err).slice(0, 1000),
      },
      deps.now().toISOString(),
    );
  }
  if (req.kind === "PREVIEW") {
    await deps.db
      .updateTable("app_previews")
      .set({ last_deployed_at: deps.now().toISOString(), git_ref: req.gitRef })
      .where("app_id", "=", app.id)
      .where("pr_number", "=", req.prNumber!)
      .execute();
  }
  await notifyChanged(deps, id);
  return (await getDeployment(deps.db, id))!;
}
