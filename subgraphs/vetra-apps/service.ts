import { GraphQLError } from "graphql";
import type { Kysely } from "kysely";
import type { Action } from "document-model";
import {
  addPackage,
  approveChanges,
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
import { classifyEnv } from "../../processors/vetra-cloud-environment/gitops.js";
import {
  GithubHttpError,
  type GithubDeployApi,
  type GithubRepo,
  type GithubUserTokens,
} from "./github.js";
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
  /** Called after a preview was removed (sticky PR comment → Removed). Best effort. */
  onPreviewRemoved?: (
    app: AppRow,
    preview: PreviewRow,
    reason: string,
  ) => Promise<void>;
}

export const DEFAULT_PREVIEW_LIMIT = 5;
export const DEFAULT_PREVIEW_TTL_DAYS = 7;
export const PREVIEW_COMMENT_MARKER = "<!-- vetra-preview -->";
const RELEASED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);
const HARBOR_HOST = "cr.vetra.io";
const MAX_SLUG_ATTEMPTS = 10;
export const IDENTITY_EXPIRES_IN_DAYS = 365;

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
  opts: { includeDeleted?: boolean } = {},
): Promise<AppRow> {
  await assertNotWorkload(deps, caller);
  const app = await getApp(deps.db, appId);
  if (!app) throw appsError("NOT_FOUND", "App not found");
  // Soft-deleted Apps are gone for everyone except an admin read.
  if (app.status === "DELETED" && !(opts.includeDeleted && caller.isAdmin)) {
    throw appsError("NOT_FOUND", "App not found");
  }
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

/**
 * A CI caller, authenticated by the vetra-apps HTTP routes: a Renown bearer
 * for the CI audience, verified with @renown/sdk (delegation credential and
 * its proof included). `claim` is the token's `vetra` claim (C1).
 */
export interface CiIdentity {
  address: string;
  chainId: number;
  /** did:key that issued the bearer (the App identity). */
  appDid: string;
  claim: VetraClaim | null;
}

/** The App, if the CI token was issued by its identity on behalf of its owner. */
async function authorizeCi(
  deps: AppsDeps,
  ci: CiIdentity,
  appId: string,
): Promise<AppRow> {
  const app = await getApp(deps.db, appId);
  if (!app || app.status === "DELETED")
    throw appsError("NOT_FOUND", "App not found");
  if (ci.appDid !== app.identity_did) {
    throw appsError("FORBIDDEN", "Token was not issued by this App's identity");
  }
  if (ci.address.toLowerCase() !== app.owner_address) {
    throw appsError(
      "FORBIDDEN",
      "App identity does not act for this App's owner",
    );
  }
  return app;
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

/** Encrypted token columns for a set of GitHub user tokens. */
function sealUserTokens(deps: AppsDeps, key: Buffer, t: GithubUserTokens) {
  const now = deps.now().getTime();
  const at = (sec: number | null) =>
    sec === null ? null : new Date(now + sec * 1000).toISOString();
  return {
    user_token_enc: encryptSecret(key, t.accessToken),
    user_token_expires_at: at(t.expiresInSec),
    refresh_token_enc: t.refreshToken
      ? encryptSecret(key, t.refreshToken)
      : null,
    refresh_token_expires_at: t.refreshToken
      ? at(t.refreshTokenExpiresInSec)
      : null,
  };
}

export async function connectGithubDeploy(
  deps: AppsDeps,
  caller: Caller,
  code: string,
) {
  await assertNotWorkload(deps, caller);
  const github = requireGithub(deps);
  // The user token is kept (encrypted) to list repos AS THE USER later.
  const key = deps.cfg.encryptionKey;
  if (!key) throw notConfigured("VETRA_APPS_ENCRYPTION_KEY");
  if (!code.trim()) throw appsError("BAD_USER_INPUT", "Missing OAuth code");
  let tokens: GithubUserTokens;
  try {
    tokens = await github.exchangeOAuthCode(code.trim());
  } catch (err) {
    throw appsError(
      "BAD_USER_INPUT",
      `GitHub authorization failed: ${String(err)}`,
    );
  }
  const ours = (await github.listUserInstallations(tokens.accessToken)).filter(
    (i) => i.appId === deps.cfg.github!.appId,
  );
  const nowIso = deps.now().toISOString();
  const sealed = sealUserTokens(deps, key, tokens);
  for (const i of ours) {
    await deps.db
      .insertInto("github_deploy_connections")
      .values({
        owner_address: caller.address,
        installation_id: i.installationId,
        account_login: i.accountLogin,
        account_type: i.accountType,
        created_at: nowIso,
        ...sealed,
      })
      .onConflict((oc) =>
        oc.columns(["owner_address", "installation_id"]).doUpdateSet({
          account_login: i.accountLogin,
          account_type: i.accountType,
          ...sealed,
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

const notConnected = () =>
  appsError(
    "GITHUB_NOT_CONNECTED",
    "Connect GitHub (Vetra Deploy) again to continue",
  );

/**
 * The caller's GitHub user token for `installationId`, refreshed when it has
 * expired (GitHub App user tokens live 8h; the refresh token rotates). No
 * connection, no stored token, or a failed refresh → GITHUB_NOT_CONNECTED so
 * the UI re-runs the OAuth flow.
 */
async function userTokenFor(
  deps: AppsDeps,
  caller: Caller,
  installationId: string,
): Promise<string> {
  const github = requireGithub(deps);
  const key = deps.cfg.encryptionKey;
  if (!key) throw notConfigured("VETRA_APPS_ENCRYPTION_KEY");
  const row = await deps.db
    .selectFrom("github_deploy_connections")
    .selectAll()
    .where("owner_address", "=", caller.address)
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
  if (!row?.user_token_enc) throw notConnected();
  const now = deps.now().getTime();
  const fresh = (exp: string | null) =>
    exp === null || Date.parse(exp) > now + 60_000;
  try {
    if (fresh(row.user_token_expires_at))
      return decryptSecret(key, row.user_token_enc);
    if (!row.refresh_token_enc || !fresh(row.refresh_token_expires_at))
      throw notConnected();
    const oldRefresh = decryptSecret(key, row.refresh_token_enc);
    const tokens = await github.refreshUserToken(oldRefresh);
    const sealed = sealUserTokens(deps, key, tokens);
    // The same authorization backs every installation row of this caller
    // that stored this refresh token: rotate them all.
    const rows = await deps.db
      .selectFrom("github_deploy_connections")
      .select(["installation_id", "refresh_token_enc"])
      .where("owner_address", "=", caller.address)
      .execute();
    for (const r of rows) {
      let same = false;
      try {
        same =
          !!r.refresh_token_enc &&
          decryptSecret(key, r.refresh_token_enc) === oldRefresh;
      } catch {
        same = false;
      }
      if (same || r.installation_id === installationId) {
        await deps.db
          .updateTable("github_deploy_connections")
          .set(sealed)
          .where("owner_address", "=", caller.address)
          .where("installation_id", "=", r.installation_id)
          .execute();
      }
    }
    return tokens.accessToken;
  } catch (err) {
    if (err instanceof GraphQLError) throw err;
    deps.logger.warn(
      `[vetra-apps] GitHub user token refresh failed: ${String(err)}`,
    );
    throw notConnected();
  }
}

/** Repos of the installation the caller can access on GitHub (user token). */
async function userRepos(
  deps: AppsDeps,
  caller: Caller,
  installationId: string,
) {
  const github = requireGithub(deps);
  const token = await userTokenFor(deps, caller, installationId);
  try {
    return await github.listUserInstallationRepos(token, installationId);
  } catch (err) {
    if (
      err instanceof GithubHttpError &&
      (err.status === 401 || err.status === 403)
    ) {
      throw notConnected();
    }
    throw err;
  }
}

export async function githubDeployRepositories(
  deps: AppsDeps,
  caller: Caller,
  installationId: string,
): Promise<GithubRepo[]> {
  await assertNotWorkload(deps, caller);
  return userRepos(deps, caller, installationId);
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
    .where("status", "!=", "DELETED")
    .orderBy("created_at", "desc")
    .execute();
  return rows.map(normalizeApp);
}

export async function appForOwner(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  opts: { includeDeleted?: boolean } = {},
) {
  return loadAppForOwner(deps, caller, appId, opts);
}

/**
 * First free slug for `name`. Every row counts, DELETED ones included, so a
 * slug (and its Harbor project app-<slug>) is never handed out twice.
 */
async function uniqueSlug(
  deps: AppsDeps,
  name: string,
  alsoTaken: Set<string> = new Set(),
): Promise<string> {
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
  for (const t of alsoTaken) taken.add(t);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function renownAuthorizeUrl(deps: AppsDeps, app: AppRow): string {
  const returnUrl = `${deps.cfg.vetraAppUrl}/user/apps/${app.id}?identity=1`;
  // Ask for a long-lived delegation (Renown's default is 7 days): CI stops
  // deploying when it expires (see runIdentityExpirySweepOnce).
  return `${deps.cfg.renownWebUrl}/?app=${encodeURIComponent(app.identity_did)}&returnUrl=${encodeURIComponent(returnUrl)}&expiresInDays=${IDENTITY_EXPIRES_IN_DAYS}`;
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
  // Only a repo the USER can access on GitHub (not merely the installation).
  const repo = (await userRepos(deps, caller, input.installationId)).find(
    (r) => r.id === String(input.repositoryId),
  );
  if (!repo) {
    throw appsError(
      "FORBIDDEN",
      "You do not have access to this repository on GitHub",
    );
  }
  const existing = await deps.db
    .selectFrom("apps")
    .select("id")
    .where("repository_id", "=", repo.id)
    .where("status", "!=", "DELETED")
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

  // Harbor 409 = someone else's project: never reuse it, take the next suffix.
  let slug: string | null = null;
  const conflicts = new Set<string>();
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = await uniqueSlug(deps, name, conflicts);
    if (await deps.harbor.createProject(`app-${candidate}`)) {
      slug = candidate;
      break;
    }
    conflicts.add(candidate);
  }
  if (!slug) {
    throw appsError(
      "BAD_USER_INPUT",
      "Could not reserve a Harbor project for this name; pick another name",
    );
  }
  const harborProject = `app-${slug}`;
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
      harbor_robot_id: robot.id,
      identity_expires_at: null,
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
      await deps.envs.execute(envId, [link]);
      if (wasReady) await deps.envs.execute(envId, [approveChanges({})]);
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
      ]);
      await deps.envs.execute(envId, [approveChanges({})]);
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

/**
 * Re-check the owner's delegation of the App identity. The newest valid
 * credential → ACTIVE with its expiry; none (never signed, expired or
 * revoked) → PENDING_IDENTITY. A DISCONNECTED App keeps its status (only the
 * expiry is refreshed).
 */
export async function confirmAppIdentity(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  const app = await loadAppForOwner(deps, caller, appId);
  if (!deps.renown) throw notConfigured("Renown workload identities");
  const delegation = await deps.renown.getDelegation({
    address: app.owner_address,
    chainId: app.owner_chain_id,
    did: app.identity_did,
  });
  const status =
    app.status === "DISCONNECTED"
      ? app.status
      : delegation
        ? "ACTIVE"
        : "PENDING_IDENTITY";
  await deps.db
    .updateTable("apps")
    .set({
      status,
      identity_expires_at: delegation?.expiresAt ?? null,
      updated_at: deps.now().toISOString(),
    })
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
  // Superseded deployments → GitHub deployment status `inactive`.
  for (const d of superseded) await notifyChanged(deps, d.id);
  if (deps.onPreviewRemoved) {
    try {
      await deps.onPreviewRemoved(app, preview, reason);
    } catch (err) {
      deps.logger.warn(
        `[vetra-apps] preview-removed feedback failed: ${String(err)}`,
      );
    }
  }
}

export async function deletePreviewsOfApp(
  deps: AppsDeps,
  app: AppRow,
  reason: string,
  opts: { strict?: boolean } = {},
) {
  for (const p of await listPreviews(deps.db, app.id)) {
    try {
      await deletePreview(deps, app, p, reason);
    } catch (err) {
      // strict: stop and let the caller keep its state (never orphan envs)
      if (opts.strict) throw err;
      deps.logger.warn(
        `[vetra-apps] deleting preview ${p.environment_id} failed: ${String(err)}`,
      );
    }
  }
}

/**
 * Soft delete. The row stays (status DELETED) so its slug and Harbor project
 * are never reused. Previews are deleted first (any failure aborts with the
 * App untouched — no orphans); the production env is deleted on request,
 * otherwise kept WITH its link so its FUSION image stays allowed and the site
 * stays up. CI is cut off: the Harbor robot and the Renown workload identity
 * are deleted.
 */
export async function deleteApp(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  deleteEnvironments: boolean,
): Promise<boolean> {
  const app = await loadAppForOwner(deps, caller, appId);
  await deletePreviewsOfApp(deps, app, "app deleted", { strict: true });
  if (deleteEnvironments) {
    const prod = await deps.envs.getState(app.production_environment_id);
    if (prod?.app?.appId === app.id)
      await deps.envs.delete(app.production_environment_id);
  }
  if (app.harbor_robot_id !== null) {
    if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
    await deps.harbor.deleteRobot(app.harbor_robot_id);
  }
  if (!deps.renown) throw notConfigured("Renown workload identities");
  try {
    await deps.renown.deleteWorkloadIdentity(app.identity_did);
  } catch (err) {
    if (!/NOT_FOUND/.test(String(err))) throw err;
  }
  const nowIso = deps.now().toISOString();
  await deps.db
    .updateTable("app_deployments")
    .set({ status: "SUPERSEDED", updated_at: nowIso, error: "app deleted" })
    .where("app_id", "=", app.id)
    .where("status", "in", ACTIVE_DEPLOYMENT_STATUSES)
    .execute();
  await deps.db
    .updateTable("apps")
    .set({ status: "DELETED", harbor_robot_secret_enc: "", updated_at: nowIso })
    .where("id", "=", app.id)
    .execute();
  deps.logger.info(
    `[vetra-apps] deleted App ${app.slug} (${app.id}); slug stays reserved`,
  );
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

function registryCredentials(deps: AppsDeps, app: AppRow) {
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

/** Owner / admin (GraphQL). CI uses {@link ciRegistryCredentials}. */
export async function appRegistryCredentials(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  return registryCredentials(deps, await loadAppForOwner(deps, caller, appId));
}

/** CI route: push/pull robot of the App's Harbor project. */
export async function ciRegistryCredentials(
  deps: AppsDeps,
  ci: CiIdentity,
  appId: string,
) {
  return registryCredentials(deps, await authorizeCi(deps, ci, appId));
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
  await assertNotWorkload(deps, caller);
  const d = await getDeployment(deps.db, deploymentId);
  if (!d) return null;
  await loadAppForOwner(deps, caller, d.app_id);
  return d;
}

/** CI route: a deployment of the token's own App (others read as missing). */
export async function ciDeployment(
  deps: AppsDeps,
  ci: CiIdentity,
  deploymentId: string,
): Promise<DeploymentRow | null> {
  const d = await getDeployment(deps.db, deploymentId);
  if (!d) return null;
  const app = await getApp(deps.db, d.app_id);
  if (!app) return null;
  try {
    await authorizeCi(deps, ci, app.id);
  } catch {
    return null;
  }
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

const PRODUCTION_EVENTS = new Set(["push", "workflow_dispatch"]);

/**
 * A CI token may only deploy what its own run was minted for (C1 claim):
 * PRODUCTION ← refClass PRODUCTION, a push/workflow_dispatch run of
 * refs/heads/<productionBranch>; PREVIEW ← refClass PREVIEW, a pull_request
 * run of refs/pull/<prNumber>/merge (pull_request_target & co. are refused).
 */
function assertClaimAllows(
  app: AppRow,
  claim: VetraClaim | null,
  kind: AppDeploymentKind,
  prNumber: number | null,
): VetraClaim {
  if (!claim) throw appsError("FORBIDDEN", "Token carries no vetra claim");
  if (claim.repositoryId !== app.repository_id) {
    throw appsError("FORBIDDEN", "Token was minted for another repository");
  }
  if (kind === "PRODUCTION") {
    const want = `refs/heads/${app.production_branch}`;
    if (
      claim.refClass !== "PRODUCTION" ||
      !PRODUCTION_EVENTS.has(claim.eventName ?? "") ||
      claim.ref !== want
    ) {
      throw appsError(
        "FORBIDDEN",
        `Token for ${claim.ref} (${claim.refClass ?? "?"}, ${claim.eventName ?? "?"}) cannot deploy PRODUCTION`,
      );
    }
  } else {
    const want = `refs/pull/${prNumber}/merge`;
    if (
      claim.refClass !== "PREVIEW" ||
      claim.eventName !== "pull_request" ||
      claim.ref !== want
    ) {
      throw appsError(
        "FORBIDDEN",
        `Token for ${claim.ref} (${claim.refClass ?? "?"}, ${claim.eventName ?? "?"}) cannot deploy PR #${prNumber}`,
      );
    }
  }
  return claim;
}

function normalizePrNumber(input: DeployAppInput): number | null {
  if (input.kind !== "PREVIEW") return null;
  const n = input.prNumber ?? null;
  if (n === null || !Number.isInteger(n) || n < 1) {
    throw appsError("BAD_USER_INPUT", "PREVIEW deployments need a prNumber");
  }
  return n;
}

/**
 * True only when GitHub definitely says the PR is not open. GitHub not
 * configured or unreachable → false: deploys are never blocked on a GitHub
 * outage (the sweeper catches a missed close later).
 */
export async function isPullRequestClosed(
  deps: AppsDeps,
  app: AppRow,
  prNumber: number,
): Promise<boolean> {
  if (!deps.github) return false;
  try {
    const state = await deps.github.getPullRequestState(
      app.installation_id,
      app.repository_full_name,
      prNumber,
    );
    return state !== "open";
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] PR state of ${app.repository_full_name}#${prNumber} unavailable: ${String(err)}`,
    );
    return false;
  }
}

/** A PREVIEW deploy that is not applied (closed PR): an audit row, SUPERSEDED. */
async function recordSkippedDeployment(
  deps: AppsDeps,
  app: AppRow,
  req: {
    prNumber: number | null;
    gitRef: string;
    sha: string;
    runUrl: string | null;
    actorGithub: string | null;
    actorDid: string | null;
    packages: { name: string; version: string }[];
    imageTag: string | null;
    reason: string;
  },
): Promise<DeploymentRow> {
  const id = deps.newId();
  const nowIso = deps.now().toISOString();
  const preview =
    req.prNumber !== null
      ? await getPreview(deps.db, app.id, req.prNumber)
      : null;
  await deps.db
    .insertInto("app_deployments")
    .values({
      id,
      app_id: app.id,
      environment_id: preview?.environment_id ?? null,
      kind: "PREVIEW",
      pr_number: req.prNumber,
      git_ref: req.gitRef,
      sha: req.sha,
      packages: JSON.stringify(req.packages),
      image_tag: req.imageTag,
      status: "SUPERSEDED",
      actor_did: req.actorDid,
      actor_github: req.actorGithub,
      run_url: req.runUrl,
      error: req.reason,
      github_deployment_id: null,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute();
  deps.logger.info(
    `[vetra-apps] skipped preview deploy for ${app.slug}: ${req.reason}`,
  );
  return (await getDeployment(deps.db, id))!;
}

async function deployChecked(
  deps: AppsDeps,
  app: AppRow,
  input: DeployAppInput,
  prNumber: number | null,
  actor: { did: string | null; github: string | null; gitRef: string },
): Promise<DeploymentRow> {
  if (input.kind !== "PRODUCTION" && input.kind !== "PREVIEW") {
    throw appsError("BAD_USER_INPUT", "kind must be PRODUCTION or PREVIEW");
  }
  if (app.status !== "ACTIVE")
    throw appsError("APP_NOT_ACTIVE", `App is ${app.status}`);
  if (!actor.gitRef) throw appsError("BAD_USER_INPUT", "gitRef is required");
  if (typeof input.sha !== "string" || !SHA.test(input.sha)) {
    throw appsError("BAD_USER_INPUT", "sha must be a git commit sha");
  }
  if (!Array.isArray(input.packages))
    throw appsError("BAD_USER_INPUT", "packages must be a list");
  validatePackages(input.packages);
  if (input.kind === "PREVIEW" && !app.previews_enabled) {
    throw appsError("PREVIEWS_DISABLED", "Previews are disabled for this App");
  }
  let runUrl = input.runUrl?.trim() || null;
  if (runUrl && !/^https:\/\/github\.com\//.test(runUrl)) runUrl = null;
  const productionState = await deps.envs.getState(
    app.production_environment_id,
  );
  const image = resolveImage(app, input.imageTag, productionState);
  // A PR's CI run can finish after the PR was merged/closed (and after the
  // pull_request.closed webhook removed its preview): never (re)create or
  // update a preview for a closed PR. Record the run as SUPERSEDED instead.
  if (
    input.kind === "PREVIEW" &&
    (await isPullRequestClosed(deps, app, prNumber!))
  ) {
    return recordSkippedDeployment(deps, app, {
      prNumber,
      gitRef: actor.gitRef,
      sha: input.sha.toLowerCase(),
      runUrl,
      actorGithub: actor.github,
      actorDid: actor.did,
      packages: input.packages.map((p) => ({
        name: p.name,
        version: p.version,
      })),
      imageTag: image ? `${image.repository}:${image.tag}` : null,
      reason: `pull request #${prNumber} is closed`,
    });
  }
  return performDeploy(deps, app, productionState, {
    kind: input.kind,
    prNumber,
    gitRef: actor.gitRef,
    sha: input.sha.toLowerCase(),
    runUrl,
    actorGithub: actor.github,
    actorDid: actor.did,
    packages: input.packages.map((p) => ({ name: p.name, version: p.version })),
    image,
  });
}

/** Owner / admin (GraphQL, manual redeploy). App identities are refused. */
export async function deployApp(
  deps: AppsDeps,
  caller: Caller,
  input: DeployAppInput,
): Promise<DeploymentRow> {
  const app = await loadAppForOwner(deps, caller, input.appId);
  const prNumber = normalizePrNumber(input);
  return deployChecked(deps, app, input, prNumber, {
    did: `did:pkh:eip155:${caller.chainId}:${caller.address}`,
    github: input.actorGithub?.trim() || null,
    gitRef: (input.gitRef ?? "").trim(),
  });
}

/** CI route: deploy as the App identity, bounded by the token's vetra claim. */
export async function ciDeployApp(
  deps: AppsDeps,
  ci: CiIdentity,
  input: DeployAppInput,
): Promise<DeploymentRow> {
  const app = await authorizeCi(deps, ci, input.appId);
  const prNumber = normalizePrNumber(input);
  const claim = assertClaimAllows(app, ci.claim, input.kind, prNumber);
  return deployChecked(deps, app, input, prNumber, {
    did: ci.appDid,
    github: claim.actor ?? (input.actorGithub?.trim() || null),
    gitRef: claim.ref,
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
    // Same rule as the gitops render: explicit isSecret, else the legacy
    // secret-name heuristic (…_API_KEY, …_PASSWORD, …). Previews get no secrets.
    .filter((e) => classifyEnv(e) !== "secret")
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
    // Content first, APPROVE in its own call: a rejected action throws here
    // and the half-applied batch is never approved/shipped.
    if (actions.length > 0) await deps.envs.execute(envId, actions);
    if (
      createActions.length > 0 ||
      content.length > 0 ||
      settled === "DRAFT" ||
      settled === "CHANGES_PENDING"
    ) {
      await deps.envs.execute(envId, [approveChanges({})]);
    }
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
