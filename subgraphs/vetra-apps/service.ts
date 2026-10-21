import { GraphQLError } from "graphql";
import { sql, type Kysely } from "kysely";
import type { Action } from "document-model";
import {
  addPackage,
  approveChanges,
  clearAppLink,
  enableService,
  initialize,
  setApexService,
  setAppLink,
  setDefaultPackageRegistry,
  setFusionConfig,
  setLabel,
  setOwner,
  setOwnerOrg,
  removePackage,
  setRuntimeConfig,
  setServiceVersion,
  wakeEnvironment,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { VetraCloudEnvironmentState } from "../../document-models/vetra-cloud-environment/index.js";
import type { VetraAppsConfig } from "./config.js";
import type {
  AppDeploymentKind,
  DeploymentTrigger,
  VetraAppsDB,
} from "./db/schema.js";
import { STUDIO_LAUNCH_KEY_INDEX } from "./db/migrations.js";
import { envUrls, type EnvGateway } from "./envs.js";
import { classifyEnv } from "../../processors/vetra-cloud-environment/gitops.js";
import {
  classifyGithubError,
  GithubHttpError,
  GithubUnavailableError,
  RepoNameTakenError,
  type GithubDeployApi,
  type GithubRepo,
  type GithubRepoInstallation,
  type GithubUserTokens,
} from "./github.js";
import type { HarborApi } from "./harbor.js";
import { isRenownConflict, type RenownApi } from "./renown.js";
import type { RenownOrgs } from "../../shared/renown-orgs.js";
import {
  canCreateOrgApp,
  canOperate,
  canView,
  isOrgMember,
} from "../../shared/org-access.js";
import { withEnvLock, withKeyLock } from "../../shared/key-lock.js";
import { isStudioAgentPackage, isStudioState } from "../../shared/studio-package.js";
import {
  assertStudioAgent,
  DELEGATION_MESSAGE,
  ensureStudioLaunchSecret,
  hasLaunchSecret,
  STUDIO_BINDING_MESSAGE,
  verifyStudioBinding,
  verifyStudioSecret,
} from "./studio-binding.js";
import {
  expectOrgHandover,
  withdrawOrgHandover,
} from "../vetra-cloud-observability/env-protection.js";
import type { ObservabilityDB } from "../vetra-cloud-observability/db/schema.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import {
  adoptOrgApps,
  adoptPersonApps,
  appResource,
  callerAccess,
  syncAppOrg,
  syncApps,
} from "./org-ownership.js";
import type { Caller, VetraClaim } from "./auth.js";
import {
  appsError,
  githubErrors,
  notConfigured,
  ORG_POLICY_TEXT,
} from "./errors.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  appRepository,
  getApp,
  getAppByIdentity,
  getDeployment,
  getPreview,
  hasCiIdentity,
  isStudioProduct,
  listPreviews,
  normalizeApp,
  parsePackages,
  updateDeployment,
  type AppRow,
  type DeploymentRow,
  type PreviewRow,
} from "./repo.js";
import {
  LOCKFILES,
  workflowTemplate,
  type PackageManager,
} from "./workflow-template.js";
import {
  mirrorAppById,
  mirrorAppRow,
  protectNewAppDocument,
  type AppDocStore,
} from "./app-document.js";
import {
  recordArtifactVersion,
  setArtifactChannel,
} from "../../document-models/vetra-app/v1/index.js";

export interface AppsLogger {
  info(msg: string): void;
  warn(msg: string): void;
  /** Unexpected failures (production logs at warn and above). Never log tokens. */
  error(msg: string): void;
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
  /** Renown organisations; null/absent: org-owned Apps are admin-only. */
  orgs?: RenownOrgs | null;
  /**
   * Cut-off for Renown lookups on the ownership-sync path (default 1.5 s);
   * after a failure Renown is skipped there for 30 s.
   */
  renownSyncTimeoutMs?: number;
  /**
   * The observability namespace, where every organisation move of an env
   * Vetra dispatches is announced first (expectOrgHandover); unannounced
   * moves are reverted by the observability protection hook.
   */
  orgHandoverDb?: Kysely<ObservabilityDB> | null;
  /**
   * Re-protects an App's vetra-app document for `owner` (and revokes every
   * other grant) when the App changes hands. Absent: no document permissions.
   */
  protectAppDoc?: ((appId: string, owner: string) => Promise<void>) | null;
  /** The Vetra service identity (VETRA_SERVICE_ADDRESS) owning org documents. */
  serviceOwner?: string;
  /**
   * The reactor surface the app documents live on. Absent = no mirroring; reads
   * are served from the table either way in this step.
   */
  docs?: AppDocStore | null;
  /**
   * The single-key path of the secrets service, for a Studio's launch secret
   * (rotateStudioLaunchSecret). Null/absent: OpenBao is not configured.
   */
  studioSecrets?: Pick<SecretsService, "ensureSecret" | "setManagedSecret"> | null;
  /**
   * Whether a generic subdomain would collide with an existing env's hosts
   * (ensureStudioProduct puts a product at <slug>.vetra.io). Absent: only the
   * reserved names and the Apps' own slugs are avoided.
   */
  subdomainTaken?: ((subdomain: string) => Promise<boolean>) | null;
  /**
   * Called (not awaited) right after a Studio deployment was recorded
   * PENDING, to apply it without waiting for the watcher's next pass.
   */
  onDeploymentQueued?: (deploymentId: string) => void;
  /**
   * The GitHub connections a Studio made the old way (vetra-github-auth's
   * `github_installations` rows for that Studio environment), read when its
   * product carries the repository over (adoptStudioRepository). Absent: no
   * Studio repository is carried over.
   */
  studioGithubConnections?:
    | ((studioEnvironmentId: string) => Promise<StudioGithubConnection[]>)
    | null;
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

export interface AppAccessOptions {
  includeDeleted?: boolean;
  /** "view": any member of the owning org; "operate" (default): publishers. */
  need?: "view" | "operate";
}

/**
 * Owner-level access: the personal owner signed in as themselves, a member
 * with publisher capability for an org-owned App (any member to view), or an
 * admin. The App's ownership is first reconciled with Renown (syncAppOrg). A
 * token of any App identity (CI) is refused here — CI may only deploy, fetch
 * its registry credentials and read its deployments. That keeps a PR-branch
 * token from e.g. rolling back production or editing the App.
 */
async function loadAppForOwner(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  opts: AppAccessOptions = {},
): Promise<AppRow> {
  await assertNotWorkload(deps, caller);
  const app = await getApp(deps.db, appId);
  if (!app) throw appsError("NOT_FOUND", "App not found");
  // Soft-deleted Apps are gone for everyone except an admin read.
  if (app.status === "DELETED" && !(opts.includeDeleted && caller.isAdmin)) {
    throw appsError("NOT_FOUND", "App not found");
  }
  const synced = await syncAppOrg(deps, app);
  const check = opts.need === "view" ? canView : canOperate;
  if (
    !(await check(deps.orgs ?? null, callerAccess(caller), appResource(synced)))
  ) {
    throw appsError("FORBIDDEN", "Not allowed to manage this App");
  }
  return synced;
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

/**
 * The App, if the CI token was issued by its identity on behalf of someone
 * who acts for it: the owner of a personal App, or (Ruling 12) an address with
 * publisher capability for an org App right now — the creator included, so
 * leaving the org stops their CI tokens. Ownership is reconciled with Renown
 * first, so CI sees a transfer too; a Renown outage refuses org Apps only.
 */
async function authorizeCi(
  deps: AppsDeps,
  ci: CiIdentity,
  appId: string,
): Promise<AppRow> {
  const found = await getApp(deps.db, appId);
  if (!found || found.status === "DELETED")
    throw appsError("NOT_FOUND", "App not found");
  if (ci.appDid !== found.identity_did || !hasCiIdentity(found)) {
    throw appsError("FORBIDDEN", "Token was not issued by this App's identity");
  }
  const app = await syncAppOrg(deps, found);
  const ciAddress = ci.address.toLowerCase();
  const actsFor = app.owner_org_id
    ? await canOperate(
        deps.orgs ?? null,
        { address: ciAddress, isAdmin: false },
        appResource(app),
      )
    : ciAddress === app.owner_address;
  if (!actsFor) {
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

function requireRepository(app: AppRow) {
  const repo = appRepository(app);
  if (!repo) throw appsError("BAD_USER_INPUT", "This App has no repository");
  return repo;
}

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

const notConnected = () => githubErrors.notConnected();

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
    if (
      err instanceof GithubUnavailableError ||
      (err instanceof GithubHttpError && err.status >= 500)
    )
      throw githubErrors.unavailable();
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

/**
 * Personal Apps (owner_org_id IS NULL), or with `orgId` the organisation's
 * Apps (members and admins only; Apps Renown lists for it are adopted first).
 */
/**
 * The caller's Apps (or an organisation's). Studio products, with or
 * without a GitHub repository, are listed only with `includeStudioProducts`:
 * Apps pages that predate them read `repository` as always present and treat
 * every App as deployed by its CI (vetra.io adds the flag when it handles
 * them, Task 4.6).
 */
export async function myApps(
  deps: AppsDeps,
  caller: Caller,
  orgId?: string | null,
  opts: { includeStudioProducts?: boolean | null } = {},
): Promise<AppRow[]> {
  const apps = await listMyApps(deps, caller, orgId);
  return opts.includeStudioProducts
    ? apps
    : apps.filter((a) => hasCiIdentity(a));
}

async function listMyApps(
  deps: AppsDeps,
  caller: Caller,
  orgId?: string | null,
): Promise<AppRow[]> {
  await assertNotWorkload(deps, caller);
  const org = orgId?.trim() || null;
  if (org) {
    if (!(await isOrgMember(deps.orgs ?? null, callerAccess(caller), org))) {
      throw appsError("FORBIDDEN", "Not a member of this organisation");
    }
    await adoptOrgApps(deps, org);
    const rows = await deps.db
      .selectFrom("apps")
      .selectAll()
      .where("owner_org_id", "=", org)
      .where("status", "!=", "DELETED")
      .orderBy("created_at", "desc")
      .execute();
    // Apps transferred out of the org at Renown drop out of the list.
    const synced = await syncApps(deps, rows.map(normalizeApp));
    return synced.filter((a) => a.owner_org_id === org);
  }
  // Apps transferred to the caller at Renown join the list.
  await adoptPersonApps(deps, caller.address);
  const rows = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("owner_address", "=", caller.address)
    .where("owner_org_id", "is", null)
    .where("status", "!=", "DELETED")
    .orderBy("created_at", "desc")
    .execute();
  const synced = await syncApps(deps, rows.map(normalizeApp));
  return synced.filter(
    (a) => a.owner_org_id === null && a.owner_address === caller.address,
  );
}

export async function appForOwner(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  opts: AppAccessOptions = {},
) {
  return loadAppForOwner(deps, caller, appId, opts);
}

/**
 * First free slug for `name`. Every row counts, DELETED ones included, so a
 * slug (and its Harbor project app-<slug>) is never handed out twice. The
 * studio app's slug is reserved: it has no row, and no app may take it.
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
  taken.add(deps.cfg.studioAppSlug);
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
  /** Create the App for this Renown organisation (Ruling 10). */
  orgId?: string | null;
}

const IDENTITY_OWNED_ELSEWHERE =
  "This repository's Renown identity belongs to another owner; delete the old App or ask its creator";

export async function createApp(
  deps: AppsDeps,
  caller: Caller,
  input: CreateAppInput,
): Promise<AppRow> {
  const name = await assertCreatePreconditions(
    deps,
    caller,
    input.name,
    input.orgId?.trim() || null,
  );
  const orgId = input.orgId?.trim() || null;
  requireGithub(deps);
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

  // Attaching an existing env: caller must operate it, it must be standalone
  // and personal or of the App's own organisation.
  let attachEnvState: VetraCloudEnvironmentState | null = null;
  if (input.productionEnvironmentId) {
    attachEnvState = await deps.envs.getState(input.productionEnvironmentId);
    if (!attachEnvState) throw appsError("NOT_FOUND", "Environment not found");
    const envOrg = attachEnvState.ownerOrgId ?? null;
    if (envOrg !== null && envOrg !== orgId) {
      throw appsError(
        "BAD_USER_INPUT",
        orgId
          ? "Environment belongs to another organisation"
          : "This environment belongs to an organisation; create the App there",
      );
    }
    const mayAttach = await canOperate(
      deps.orgs ?? null,
      { address: caller.address, isAdmin: false },
      { owner: attachEnvState.owner ?? null, ownerOrgId: envOrg, appDid: null },
    );
    if (!mayAttach) {
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

  // The workload identity first (R2), so a refusal leaves nothing behind.
  const did = await registerAppIdentity(deps, deps.renown!, {
    repositoryId: repo.id,
    repository: repo.fullName,
    productionBranch,
    ownerAddress: caller.address,
    chainId: caller.chainId,
    orgId,
  });

  // Everything made from here on is undone when a later step fails, so a
  // retry (in another organisation, or personally) is not blocked.
  // Both checked by assertCreatePreconditions.
  const harbor = deps.harbor!;
  const made: CreateMade = {
    project: null,
    robotId: null,
    appId: null,
    announced: null,
    repo: null,
    envId: null,
  };
  let appId: string;
  let slug: string;
  let envId: string;
  let step = "reserving the Harbor project";
  try {
    slug = await reserveSlugAndProject(deps, harbor, name, made, new Set());
    const harborProject = `app-${slug}`;
    step = "creating the Harbor robot";
    const robot = await harbor.createPushRobot(harborProject);
    made.robotId = robot.id;

    appId = deps.newId();
    // The apps row goes in before the env actions: the gitops render resolves
    // the App's Harbor project from it (see app-image-project.ts).
    step = "creating the production environment";
    if (attachEnvState) {
      envId = input.productionEnvironmentId!;
    } else {
      envId = await deps.envs.create();
      made.envId = envId;
    }
    made.appId = appId;
    step = "recording the App";
    await insertAppRow(deps, {
      appId,
      slug,
      name,
      caller,
      orgId,
      did,
      robot,
      installationId: input.installationId,
      repo,
      productionBranch,
      harborProject,
      productionEnvironmentId: envId,
    });
    step = "provisioning the production environment";
    await provisionProductionEnv(
      deps,
      caller,
      {
        envId,
        appId,
        name,
        harborProject,
        productionBranch,
        orgId,
        attach: attachEnvState ? { state: attachEnvState } : null,
      },
      made,
    );
  } catch (err) {
    const cleanedUp = await undoFailedCreate(
      deps,
      harbor,
      deps.renown,
      did,
      made,
    );
    const account = repo.fullName.split("/")[0] ?? repo.fullName;
    // The customer's own repository is never changed by createApp.
    throw createFailure(deps, "createApp", step, account, err, {
      repoRolledBack: false,
      cleanedUp,
    });
  }
  deps.logger.info(
    `[vetra-apps] created App ${slug} (${appId}) for ${repo.fullName}, env ${envId}`,
  );
  const created = (await getApp(deps.db, appId))!;
  await mirrorAppRow(deps, created);
  return created;
}

export interface CreateStudioAppInput {
  name: string;
  /** The Vetra Studio env the App is built in; recorded, never app-linked. */
  studioEnvironmentId: string;
  /** The caller's connected Vetra Deploy installation; the repo is created in its account. */
  installationId: string;
  orgId?: string | null;
}

const STUDIO_WORKFLOW_PATH = ".github/workflows/vetra.yml";
const STUDIO_PRODUCTION_BRANCH = "main";
/** The partial unique index: one live App per Studio (db/migrations.ts). */
const STUDIO_APP_INDEX = "apps_studio_env_live";

const studioAlreadyAnApp = () =>
  appsError("BAD_USER_INPUT", "This Studio is already an App");

/** A Postgres unique violation (23505) on `constraint`. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== "23505") return false;
  return (
    e.constraint === constraint ||
    (typeof e.message === "string" && e.message.includes(constraint))
  );
}

/**
 * Turn a Vetra Studio into an App: a private repository in the account of the
 * caller's connected GitHub installation, created with the caller's user token
 * (same word as the slug and the Harbor project), its Renown
 * identity, Harbor robot, a new production env, the VETRA_APP_ID variable and
 * the deploy workflow (committed with [skip ci]). The Studio env is recorded
 * on the row and never app-linked: CI must never deploy into it. Everything
 * made is undone when a step fails.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export async function createStudioApp(
  deps: AppsDeps,
  caller: Caller,
  input: CreateStudioAppInput,
): Promise<AppRow> {
  const github = requireGithub(deps);
  const orgId = input.orgId?.trim() || null;
  const name = await assertCreatePreconditions(deps, caller, input.name, orgId);

  const studioId = input.studioEnvironmentId;
  const studio = await deps.envs.getState(studioId);
  if (!studio || !studio.packages.some((p) => isStudioAgentPackage(p.name)))
    throw appsError("BAD_USER_INPUT", "Not a Vetra Studio");
  // As createApp's attach: a Studio of an organisation makes only that
  // organisation's App.
  const studioOrg = studio.ownerOrgId ?? null;
  if (studioOrg !== null && studioOrg !== orgId) {
    throw appsError(
      "BAD_USER_INPUT",
      orgId
        ? "Environment belongs to another organisation"
        : "This environment belongs to an organisation; create the App there",
    );
  }
  const mayUse = await canOperate(
    deps.orgs ?? null,
    { address: caller.address, isAdmin: false },
    {
      owner: studio.owner ?? null,
      ownerOrgId: studioOrg,
      appDid: null,
    },
  );
  if (!mayUse) throw appsError("FORBIDDEN", "You do not own this Studio");
  if (RELEASED_STATUSES.has(studio.status))
    throw appsError("BAD_USER_INPUT", "Studio is terminated");

  // The installation must be one of the caller's own connections; its account
  // is where the repository goes.
  const installationId = input.installationId;
  const connection = await deps.db
    .selectFrom("github_deploy_connections")
    .select(["account_login", "account_type"])
    .where("owner_address", "=", caller.address)
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
  if (!connection) throw notConnected();
  const userToken = await userTokenFor(deps, caller, installationId);
  let repositorySelection: "all" | "selected";
  try {
    repositorySelection =
      await github.getInstallationRepositorySelection(installationId);
  } catch (err) {
    // 404: the Vetra Deploy app is no longer installed there.
    if (err instanceof GithubHttpError && err.status === 404)
      throw notConnected();
    throw classifyGithubError(err, connection.account_login) ?? err;
  }

  // One create per Studio at a time in this process (the check, the repo and
  // the row); the partial unique index backs it up across replicas. Not the
  // env lock: the org sync holds that one on the Studio.
  return withKeyLock(`studio-app:${studioId}`, () =>
    createStudioAppLocked(deps, caller, {
      github,
      installationId,
      account: {
        login: connection.account_login,
        type: connection.account_type,
      },
      userToken,
      repositorySelection,
      orgId,
      name,
      studioId,
    }),
  );
}

/**
 * One attempt at a Studio product's repository: private, `repoName` in
 * `account`, described as "<name> — built with Vetra Studio", created with
 * the user's token. `made.repo` is set as soon as GitHub made it, so the
 * caller's undo removes it when a check here (or a later step) fails.
 * RepoNameTakenError is passed on for the caller to take the next suffix.
 */
async function createStudioRepo(
  github: GithubDeployApi,
  ctx: {
    userToken: string;
    account: { login: string; type: string };
    installationId: string;
    repositorySelection: "all" | "selected";
  },
  repoName: string,
  productName: string,
  made: Pick<CreateMade, "repo">,
  autoInit: boolean,
): Promise<GithubRepo> {
  const { userToken, account, installationId, repositorySelection } = ctx;
  const repo = await github.createRepoAsUser(
    userToken,
    account,
    repoName,
    `${productName.replace(CONTROL_CHARS, " ")} — built with Vetra Studio`.slice(
      0,
      350,
    ),
    { autoInit },
  );
  // An all-repositories installation covers the new repo at once; a
  // selected one only once it is added.
  made.repo = {
    id: repo.id,
    fullName: repo.fullName,
    installationId,
    userToken,
    inInstallation: repositorySelection === "all",
  };
  if (repo.private !== true)
    throw new Error(`${repo.fullName} was created as a public repository`);
  // /user/repos creates under the token's own user: it must be the
  // connected personal account.
  const repoOwner = repo.fullName.split("/")[0] ?? "";
  if (
    account.type === "User" &&
    repoOwner.toLowerCase() !== account.login.toLowerCase()
  )
    throw appsError(
      "FORBIDDEN",
      `GitHub created the repository under ${repoOwner}, not ${account.login}; connect GitHub as ${account.login}`,
    );
  return repo;
}

async function createStudioAppLocked(
  deps: AppsDeps,
  caller: Caller,
  ctx: {
    github: GithubDeployApi;
    installationId: string;
    account: { login: string; type: string };
    userToken: string;
    repositorySelection: "all" | "selected";
    orgId: string | null;
    name: string;
    studioId: string;
  },
): Promise<AppRow> {
  const {
    github,
    installationId,
    account,
    userToken,
    repositorySelection,
    orgId,
    name,
    studioId,
  } = ctx;
  const taken = await deps.db
    .selectFrom("apps")
    .select("id")
    .where("studio_environment_id", "=", studioId)
    .where("status", "!=", "DELETED")
    .executeTakeFirst();
  if (taken) throw studioAlreadyAnApp();

  // Both checked by assertCreatePreconditions.
  const harbor = deps.harbor!;
  const renown = deps.renown!;
  const productionBranch = STUDIO_PRODUCTION_BRANCH;
  const made: CreateMade = {
    project: null,
    robotId: null,
    appId: null,
    announced: null,
    repo: null,
    envId: null,
  };
  let did: string | null = null;
  let appId: string;
  let slug = "";
  let envId: string;
  // What is under way, for the log when it fails.
  let step = "reserving the Harbor project";
  try {
    // Slug, Harbor project and repository name are the same word; a taken
    // repository name releases the project and takes the next suffix.
    let repo: GithubRepo | null = null;
    const conflicts = new Set<string>();
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !repo; attempt++) {
      step = "reserving the Harbor project";
      slug = await reserveSlugAndProject(deps, harbor, name, made, conflicts);
      step = "creating the GitHub repository";
      try {
        repo = await createStudioRepo(
          github,
          { userToken, account, installationId, repositorySelection },
          slug,
          name,
          made,
          // The workflow is committed onto GitHub's initial commit.
          true,
        );
      } catch (err) {
        // Other GitHub refusals are mapped below, after the undo.
        if (!(err instanceof RepoNameTakenError)) throw err;
        conflicts.add(slug);
        await harbor.deleteProject(made.project!);
        made.project = null;
      }
    }
    if (!repo) throw githubErrors.repoExists();
    const harborProject = made.project!;
    // The installation token calls below (variable, workflow commit, later
    // deploys) need the repo inside the installation.
    if (repositorySelection === "selected") {
      step = "adding the repository to the GitHub app installation";
      await github.addRepoToInstallation(userToken, installationId, repo.id);
      made.repo!.inInstallation = true;
    }

    step = "registering the Renown identity";
    did = await registerAppIdentity(deps, renown, {
      repositoryId: repo.id,
      repository: repo.fullName,
      productionBranch,
      ownerAddress: caller.address,
      chainId: caller.chainId,
      orgId,
    });
    step = "creating the Harbor robot";
    const robot = await harbor.createPushRobot(harborProject);
    made.robotId = robot.id;

    appId = deps.newId();
    // The repository is complete before the env exists: provisioning approves
    // the env (it renders and runs), so it is the last step, as in createApp.
    step = "setting the repository variable";
    await github.setRepoVariable(
      installationId,
      repo.fullName,
      "VETRA_APP_ID",
      appId,
    );
    step = "committing the deploy workflow";
    await github.commitFile(installationId, repo.fullName, {
      path: STUDIO_WORKFLOW_PATH,
      content: workflowTemplate(appId, productionBranch, {
        packageManager: "pnpm",
        declaresPackageManager: false,
      }),
      message: "chore: add the Vetra deploy workflow [skip ci]",
    });

    // The row goes in before the env actions (see createApp).
    step = "creating the production environment";
    envId = await deps.envs.create();
    made.envId = envId;
    made.appId = appId;
    step = "recording the App";
    await insertAppRow(deps, {
      appId,
      slug,
      name,
      caller,
      orgId,
      did,
      robot,
      installationId,
      repo,
      productionBranch,
      harborProject,
      productionEnvironmentId: envId,
      studioEnvironmentId: studioId,
    });
    step = "provisioning the production environment";
    await provisionProductionEnv(
      deps,
      caller,
      {
        envId,
        appId,
        name,
        harborProject,
        productionBranch,
        orgId,
        attach: null,
      },
      made,
    );
  } catch (err) {
    const cleanedUp = await undoFailedCreate(deps, harbor, renown, did, made);
    // Another replica made this Studio's App meanwhile.
    if (isUniqueViolation(err, STUDIO_APP_INDEX)) throw studioAlreadyAnApp();
    throw createFailure(deps, "createStudioApp", step, account.login, err, {
      repoRolledBack: made.repo !== null,
      cleanedUp,
    });
  }
  deps.logger.info(
    `[vetra-apps] created Studio App ${slug} (${appId}) in ${made.repo?.fullName}, studio ${studioId}, env ${envId}`,
  );
  const created = (await getApp(deps.db, appId))!;
  await mirrorAppRow(deps, created);
  return created;
}

// ---------------------------------------------------------------------------
// Studio products without GitHub (Task 2.2)
// ---------------------------------------------------------------------------

export interface EnsureStudioProductInput {
  studioEnvironmentId: string;
  name: string;
  /**
   * An existing env of the Studio's owner that becomes the product's
   * production env instead of a new one (§6.6: an env set up before versions).
   */
  adoptEnvironmentId?: string | null;
}

/**
 * How the request authenticates: the owner in person, or the Studio's agent
 * (it sent STUDIO_SECRET_HEADER; `secret` is null when the header was empty).
 */
export type StudioProductAuth =
  | { kind: "owner" }
  | { kind: "agent"; secret: string | null };

export const STUDIO_SECRET_PENDING_MESSAGE =
  "This Studio is getting ready to publish. Try again after it restarts.";

/** identity_did of a Studio product made by its owner, until its agent first calls (no caller can present it). */
export const STUDIO_PRODUCT_IDENTITY_PREFIX = "vetra-studio-product:";

/** Days a Studio product may stay never launched before the sweep removes it (D8, F32). */
export const UNLAUNCHED_STUDIO_APP_DAYS = 14;

/**
 * Generic subdomains a product may never take: platform hosts under
 * vetra.io. A product named after one gets the next suffix.
 */
const RESERVED_SUBDOMAINS = new Set([
  "admin", "alertmanager", "api", "app", "apps", "argocd", "assets", "auth",
  "blog", "cdn", "connect", "cr", "dev", "docs", "ftp", "git", "github",
  "grafana", "harbor", "help", "id", "keycloak", "login", "mail", "minio",
  "monitoring", "mx", "ns1", "ns2", "openbao", "prometheus", "registry",
  "renown", "renown-staging", "s3", "smtp", "sso", "staging", "static",
  "status", "studio", "support", "switchboard", "vault", "vetra", "www",
]);

/** The live (not DELETED) App made from this Studio, or null. */
async function liveStudioApp(
  deps: AppsDeps,
  studioId: string,
): Promise<AppRow | null> {
  const row = await deps.db
    .selectFrom("apps")
    .selectAll()
    .where("studio_environment_id", "=", studioId)
    .where("status", "!=", "DELETED")
    .executeTakeFirst();
  return row ? normalizeApp(row) : null;
}

/**
 * The Studio the request may act for, by path. Agent: the launch secret
 * binding (verifyStudioSecret, F8); a Studio without a launch secret gets one
 * now (X22) and the call is refused with STUDIO_SECRET_PENDING, to be retried
 * once the Studio has restarted with it. Owner: no App identity, and the
 * caller owns (or, for an organisation, operates) the Studio.
 */
async function authorizeStudio(
  deps: AppsDeps,
  caller: Caller,
  studioId: string,
  auth: StudioProductAuth,
): Promise<VetraCloudEnvironmentState> {
  if (auth.kind === "agent") {
    if (!caller.appKey)
      throw appsError("DELEGATION_MISSING", DELEGATION_MESSAGE);
    if (!(await hasLaunchSecret(deps.db, studioId))) {
      const studio = await assertStudioAgent(deps, caller, studioId);
      await ensureStudioLaunchSecret(deps, studioId, studio);
      throw appsError("STUDIO_SECRET_PENDING", STUDIO_SECRET_PENDING_MESSAGE);
    }
    await verifyStudioSecret(deps, caller, auth.secret, studioId);
    return (await deps.envs.getState(studioId))!;
  }
  await assertNotWorkload(deps, caller);
  const studio = await deps.envs.getState(studioId);
  if (!studio || !isStudioState(studio))
    throw appsError("BAD_USER_INPUT", "Not a Vetra Studio");
  const mayUse = await canOperate(
    deps.orgs ?? null,
    { address: caller.address, isAdmin: false },
    {
      owner: studio.owner ?? null,
      ownerOrgId: studio.ownerOrgId ?? null,
      appDid: null,
    },
  );
  if (!mayUse) throw appsError("FORBIDDEN", "You do not own this Studio");
  return studio;
}

/**
 * The Studio's existing App, checked for the caller: the agent must still act
 * for it (verifyStudioBinding's App check), the owner as for any App. A
 * product without GitHub is bound to the agent's current key (identity_did),
 * so the owner-only paths go on refusing it (assertNotWorkload).
 */
async function existingStudioProduct(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
  auth: StudioProductAuth,
): Promise<AppRow> {
  if (auth.kind === "owner") return loadAppForOwner(deps, caller, app.id);
  const synced = await syncAppOrg(deps, app);
  if (
    !(await canOperate(
      deps.orgs ?? null,
      callerAccess({ ...caller, isAdmin: false }),
      appResource(synced),
    ))
  ) {
    throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
  }
  return bindAgentIdentity(deps, caller, synced);
}

/** Point a product without GitHub at the agent's key (no-op when it already is, or for a GitHub App). */
async function bindAgentIdentity(
  deps: AppsDeps,
  caller: Caller,
  app: AppRow,
): Promise<AppRow> {
  const key = caller.appKey!;
  // A Studio product follows its agent's key, on GitHub or not (D15: it has
  // no CI identity); an App deployed by CI keeps its workload identity.
  if (!isStudioProduct(app) || app.identity_did === key) return app;
  const other = await getAppByIdentity(deps.db, key);
  if (other && other.id !== app.id && other.status !== "DELETED")
    throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
  await deps.db
    .updateTable("apps")
    .set({ identity_did: key, updated_at: deps.now().toISOString() })
    .where("id", "=", app.id)
    .execute();
  deps.logger.info(
    `[vetra-apps] Studio product ${app.slug} (${app.id}) bound to its agent's key`,
  );
  const bound = (await getApp(deps.db, app.id))!;
  await mirrorAppRow(deps, bound);
  return bound;
}

/**
 * A Studio's product: its App, without a repository, and a production env at
 * <slug>.vetra.io with Connect at the apex (or an adopted env of the same
 * owner). Idempotent per Studio: an existing live App is returned as it is
 * (its name and address never change here, D19); the partial unique index
 * apps_studio_env_live guards it across replicas. Callable by the Studio's
 * agent (launch secret binding) and by the owner. The App is ACTIVE at once:
 * there is no CI identity to confirm. Its identity_did is the agent's key, so
 * the owner-only paths refuse the agent (assertNotWorkload). No Harbor robot
 * and no Renown workload identity are made; the Harbor project is reserved
 * as for every App. Everything made is undone when a step fails.
 */
export async function ensureStudioProduct(
  deps: AppsDeps,
  caller: Caller,
  input: EnsureStudioProductInput,
  auth: StudioProductAuth,
): Promise<AppRow> {
  const studioId = input.studioEnvironmentId.trim();
  if (!studioId)
    throw appsError("BAD_USER_INPUT", "studioEnvironmentId is required");
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw appsError("BAD_USER_INPUT", "Name must be 1-100 characters");
  const studio = await authorizeStudio(deps, caller, studioId, auth);
  if (RELEASED_STATUSES.has(studio.status))
    throw appsError("BAD_USER_INPUT", "Studio is terminated");

  return withKeyLock(`studio-app:${studioId}`, async () => {
    const existing = await liveStudioApp(deps, studioId);
    if (existing) return existingStudioProduct(deps, caller, existing, auth);
    try {
      return await createStudioProduct(deps, caller, {
        studioId,
        studio,
        name,
        adoptEnvironmentId: input.adoptEnvironmentId?.trim() || null,
        identityDid:
          auth.kind === "agent"
            ? caller.appKey!
            : `${STUDIO_PRODUCT_IDENTITY_PREFIX}${studioId}`,
      });
    } catch (err) {
      // Another replica made this Studio's App meanwhile: that one is it.
      if (!isUniqueViolation(err, STUDIO_APP_INDEX)) throw err;
      const made = await liveStudioApp(deps, studioId);
      if (!made) throw err;
      return existingStudioProduct(deps, caller, made, auth);
    }
  });
}

/** The env named by adoptEnvironmentId, when it may become the product's production env (F28). */
async function adoptableEnv(
  deps: AppsDeps,
  studioId: string,
  studio: VetraCloudEnvironmentState,
  envId: string,
): Promise<VetraCloudEnvironmentState> {
  const refuse = (why: string) =>
    appsError("ADOPT_NOT_ALLOWED", `This environment cannot become the product's: ${why}`);
  if (envId === studioId) throw refuse("it is the Studio itself");
  const state = await deps.envs.getState(envId);
  if (!state) throw refuse("it does not exist");
  if (isStudioState(state)) throw refuse("it is a Studio");
  if (RELEASED_STATUSES.has(state.status)) throw refuse("it is terminated");
  const studioOrg = studio.ownerOrgId ?? null;
  const envOrg = state.ownerOrgId ?? null;
  const sameOwner =
    studioOrg !== null
      ? envOrg === studioOrg
      : envOrg === null &&
        !!state.owner &&
        state.owner.toLowerCase() === (studio.owner ?? "").toLowerCase();
  if (!sameOwner) throw refuse("it belongs to someone else");
  // Never another App's env: linked to a live App, or recorded as one's
  // production or preview env.
  if (state.app?.appId) {
    const linked = await getApp(deps.db, state.app.appId);
    if (linked && linked.status !== "DELETED")
      throw refuse("it belongs to another App");
  }
  const usedAsProduction = await deps.db
    .selectFrom("apps")
    .select("id")
    .where("production_environment_id", "=", envId)
    .where("status", "!=", "DELETED")
    .executeTakeFirst();
  const usedAsPreview = await deps.db
    .selectFrom("app_previews")
    .select("app_id")
    .where("environment_id", "=", envId)
    .executeTakeFirst();
  if (usedAsProduction || usedAsPreview)
    throw refuse("it belongs to another App");
  return state;
}

/** Slug + Harbor project app-<slug> for a product; a new env's subdomain is the slug, so it must be free too. */
async function reserveProductSlug(
  deps: AppsDeps,
  harbor: HarborApi,
  name: string,
  made: CreateMade,
  checkSubdomain: boolean,
): Promise<string> {
  const conflicts = new Set<string>(RESERVED_SUBDOMAINS);
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS * 3; attempt++) {
    const candidate = await uniqueSlug(deps, name, conflicts);
    if (
      checkSubdomain &&
      deps.subdomainTaken &&
      (await deps.subdomainTaken(candidate))
    ) {
      conflicts.add(candidate);
      continue;
    }
    if (await harbor.createProject(`app-${candidate}`)) {
      made.project = `app-${candidate}`;
      return candidate;
    }
    conflicts.add(candidate);
  }
  throw appsError(
    "BAD_USER_INPUT",
    "Could not reserve an address for this name; pick another name",
  );
}

async function createStudioProduct(
  deps: AppsDeps,
  caller: Caller,
  ctx: {
    studioId: string;
    studio: VetraCloudEnvironmentState;
    name: string;
    adoptEnvironmentId: string | null;
    identityDid: string;
  },
): Promise<AppRow> {
  const { studioId, studio, name, adoptEnvironmentId, identityDid } = ctx;
  // An agent key already bound to another live App never gets a second one.
  const holder = await getAppByIdentity(deps.db, identityDid);
  if (holder && holder.status !== "DELETED")
    throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
  if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
  const harbor = deps.harbor;
  // An organisation's Studio makes the organisation's App; the env is handed
  // over with an announced move.
  const orgId = studio.ownerOrgId ?? null;
  if (orgId && !deps.orgHandoverDb)
    throw notConfigured("The organisation hand-over store");
  const ownerAddress = orgId
    ? (studio.owner ?? caller.address).toLowerCase()
    : caller.address;
  const adopted = adoptEnvironmentId
    ? await adoptableEnv(deps, studioId, studio, adoptEnvironmentId)
    : null;

  const made: CreateMade = {
    project: null,
    robotId: null,
    appId: null,
    announced: null,
    repo: null,
    envId: null,
  };
  let linkedAdopted = false;
  let step = "reserving the address";
  let slug = "";
  let envId = "";
  const appId = deps.newId();
  try {
    slug = await reserveProductSlug(deps, harbor, name, made, !adopted);
    const harborProject = made.project!;
    step = "creating the production environment";
    if (adopted) {
      envId = adoptEnvironmentId!;
    } else {
      envId = await deps.envs.create();
      made.envId = envId;
    }
    // The row goes in before the env actions (see createApp).
    step = "recording the App";
    const nowIso = deps.now().toISOString();
    await deps.db
      .insertInto("apps")
      .values({
        id: appId,
        slug,
        name,
        owner_address: ownerAddress,
        owner_chain_id: caller.chainId,
        status: "ACTIVE",
        installation_id: null,
        repository_id: null,
        repository_full_name: null,
        production_branch: STUDIO_PRODUCTION_BRANCH,
        production_environment_id: envId,
        // The Studio's own preview is the preview (spec §6.4).
        previews_enabled: false,
        preview_limit: DEFAULT_PREVIEW_LIMIT,
        preview_ttl_days: DEFAULT_PREVIEW_TTL_DAYS,
        harbor_project: harborProject,
        harbor_robot_name: "",
        harbor_robot_id: null,
        harbor_robot_secret_enc: "",
        identity_did: identityDid,
        identity_expires_at: null,
        owner_org_id: orgId,
        studio_environment_id: studioId,
        product_drive_id: null,
        launched_at: null,
        adopted_at: adopted ? nowIso : null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute();
    made.appId = appId;
    step = "provisioning the production environment";
    linkedAdopted = !!adopted;
    await provisionProductionEnv(
      deps,
      caller,
      {
        envId,
        appId,
        name,
        harborProject,
        productionBranch: STUDIO_PRODUCTION_BRANCH,
        orgId,
        attach: adopted ? { state: adopted } : null,
        subdomain: slug,
        ownerAddress,
        connectAtApex: true,
      },
      made,
    );
  } catch (err) {
    // An adopted env is never deleted: only the link made here is taken back.
    if (linkedAdopted) {
      await deps.envs
        .execute(envId, [clearAppLink({})])
        .catch((e: unknown) =>
          deps.logger.error(
            `[vetra-apps] unlinking adopted env ${envId} after a failed ensureStudioProduct failed: ${String(e)}`,
          ),
        );
    }
    const cleanedUp = await undoFailedCreate(deps, harbor, null, null, made);
    if (err instanceof GraphQLError || isUniqueViolation(err, STUDIO_APP_INDEX))
      throw err;
    deps.logger.error(
      `[vetra-apps] ensureStudioProduct failed while ${step}: ${String(err)}${cleanedUp ? "" : " (cleanup incomplete)"}`,
    );
    throw githubErrors.deploySetupFailed({ repoRolledBack: false, cleanedUp });
  }
  deps.logger.info(
    `[vetra-apps] created Studio product ${slug} (${appId}), studio ${studioId}, env ${envId}${adopted ? " (adopted)" : ""}`,
  );
  const created = (await getApp(deps.db, appId))!;
  await mirrorAppRow(deps, created);
  return created;
}

/**
 * The Studio's live App, or null: for its agent (launch secret binding) or
 * for whoever may view the App.
 */
export async function studioProductFor(
  deps: AppsDeps,
  caller: Caller,
  studioEnvironmentId: string,
  auth: StudioProductAuth,
): Promise<AppRow | null> {
  const studioId = studioEnvironmentId.trim();
  if (!studioId) return null;
  if (auth.kind === "agent") {
    await verifyStudioSecret(deps, caller, auth.secret, studioId);
    const app = await liveStudioApp(deps, studioId);
    if (!app) return null;
    await verifyStudioBinding(deps, caller, auth.secret, app);
    return app;
  }
  await assertNotWorkload(deps, caller);
  const app = await liveStudioApp(deps, studioId);
  if (!app) return null;
  try {
    return await loadAppForOwner(deps, caller, app.id, { need: "view" });
  } catch (err) {
    if (err instanceof GraphQLError && err.extensions.code === "FORBIDDEN")
      return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Studio products on GitHub (Task 4.1, D14/D15)
// ---------------------------------------------------------------------------

export interface AttachStudioRepositoryInput {
  appId: string;
  /** One of the caller's connected Vetra Deploy installations: its account gets the repository. */
  installationId: string;
  /** The repository name wanted (slugified); default: the product's slug. */
  name?: string | null;
}

/** GitHub hands out installation tokens for one hour; the reported expiry never says more. */
export const STUDIO_PUSH_TOKEN_MAX_MS = 3_600_000;

export interface StudioPushToken {
  token: string;
  expiresAt: string;
  remoteUrl: string;
}

const isRefusal = (err: unknown, status: number) =>
  err instanceof GithubHttpError && err.status === status && !err.rateLimited;
const namesOrgPolicy = (err: unknown) =>
  err instanceof GithubHttpError &&
  !err.rateLimited &&
  err.reasons.some((r) => ORG_POLICY_TEXT.test(r));

/**
 * The customer's words for a refusal in an organisation account (spec §8):
 * a policy (named by GitHub, or repository creation kept to owners, which
 * GitHub answers 403 to an active member) → ORG_POLICY; Vetra not installed
 * there or the caller not a member (404) → INSUFFICIENT_PERMISSION. Null:
 * not an organisation refusal.
 */
function orgRefusal(err: unknown, org: string): GraphQLError | null {
  if (namesOrgPolicy(err) || isRefusal(err, 403))
    return githubErrors.studioOrgPolicy(org);
  if (isRefusal(err, 404)) return githubErrors.studioOrgNotInstalled(org);
  return null;
}

/**
 * Keep a copy of a Studio product's code on GitHub (D14): a private
 * repository named after the product's slug (or `name`; taken → -2, -3, …),
 * described "<name> — built with Vetra Studio", in the account of one of the
 * caller's connected installations — their own account or an organisation.
 * The owner in person only (the agent's key is refused as every App
 * identity). For an organisation, the caller must be an active member right
 * now and Vetra installed there; GitHub itself decides whether members may
 * create repositories. No deploy workflow, repository variable or CI identity
 * is made (D15): the Studio launches the product, the repository is its
 * mirror. The App stays its owner's; the account login and type are
 * recorded. A product whose repository GitHub took away may connect again
 * (a new repository; the old one is never deleted). Nothing else about the
 * product changes, and a refusal leaves it as it was.
 */
export async function attachStudioRepository(
  deps: AppsDeps,
  caller: Caller,
  input: AttachStudioRepositoryInput,
  auth: StudioProductAuth = { kind: "owner" },
): Promise<AppRow> {
  // The owner in person: never through the Studio-agent path (any key that
  // presents the launch secret header), never with a key an App is bound to
  // (loadAppForOwner → assertNotWorkload, DELETED Apps' keys included).
  if (auth.kind === "agent")
    throw appsError(
      "FORBIDDEN",
      "Only you can connect GitHub, from your browser",
    );
  const github = requireGithub(deps);
  const found = await loadAppForOwner(deps, caller, input.appId);
  if (!isStudioProduct(found))
    throw appsError(
      "BAD_USER_INPUT",
      "Only a Studio product connects GitHub this way",
    );
  const installationId = input.installationId.trim();
  const connection = await deps.db
    .selectFrom("github_deploy_connections")
    .select(["account_login", "account_type"])
    .where("owner_address", "=", caller.address)
    .where("installation_id", "=", installationId)
    .executeTakeFirst();
  if (!connection) throw notConnected();
  const account = {
    login: connection.account_login,
    type: connection.account_type,
  };
  const inOrg = account.type === "Organization";
  const repoBase = slugify(input.name?.trim() || found.slug);
  const userToken = await userTokenFor(deps, caller, installationId);

  if (inOrg) {
    let membership: { state: string; role: string } | null | undefined;
    try {
      membership = await github.getOrgMembership(userToken, account.login);
    } catch (err) {
      if (namesOrgPolicy(err)) throw githubErrors.studioOrgPolicy(account.login);
      // The app may not read memberships: GitHub decides at creation.
      if (!isRefusal(err, 403))
        throw classifyGithubError(err, account.login) ?? err;
      membership = undefined;
    }
    if (membership === null || (membership && membership.state !== "active"))
      throw githubErrors.studioOrgNotInstalled(account.login);
  }

  let repositorySelection: "all" | "selected";
  try {
    repositorySelection =
      await github.getInstallationRepositorySelection(installationId);
  } catch (err) {
    // 404: Vetra is no longer installed on that account.
    if (isRefusal(err, 404))
      throw inOrg
        ? githubErrors.studioOrgNotInstalled(account.login)
        : notConnected();
    throw classifyGithubError(err, account.login) ?? err;
  }

  const studioId = found.studio_environment_id!;
  return withKeyLock(`studio-app:${studioId}`, async () => {
    const app = (await getApp(deps.db, found.id))!;
    if (appRepository(app) && !app.repository_disconnected_at)
      throw appsError(
        "BAD_USER_INPUT",
        "This product's code is already on GitHub",
      );
    const made: Pick<CreateMade, "repo"> = { repo: null };
    let step = "creating the GitHub repository";
    try {
      let repo: GithubRepo | null = null;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !repo; attempt++) {
        const repoName = attempt === 0 ? repoBase : `${repoBase}-${attempt + 1}`;
        try {
          repo = await createStudioRepo(
            github,
            { userToken, account, installationId, repositorySelection },
            repoName,
            app.name,
            made,
            // Empty: the Studio's first mirror push fast-forwards (no README commit).
            false,
          );
        } catch (err) {
          if (!(err instanceof RepoNameTakenError)) throw err;
        }
      }
      if (!repo) throw githubErrors.repoExists();
      if (repositorySelection === "selected") {
        step = "adding the repository to the GitHub app installation";
        await github.addRepoToInstallation(userToken, installationId, repo.id);
        made.repo!.inInstallation = true;
      }
      step = "recording the repository";
      const recorded = await deps.db
        .updateTable("apps")
        .set({
          installation_id: installationId,
          repository_id: repo.id,
          repository_full_name: repo.fullName,
          repository_account_login: account.login,
          repository_account_type: account.type,
          repository_disconnected_at: null,
          repository_connected_by: caller.address,
          updated_at: deps.now().toISOString(),
        })
        .where("id", "=", app.id)
        // Another replica may have recorded a repository meanwhile.
        .where((eb) =>
          eb.or([
            eb("repository_id", "is", null),
            eb("repository_disconnected_at", "is not", null),
          ]),
        )
        .returning("id")
        .executeTakeFirst();
      if (!recorded) {
        const winner = (await getApp(deps.db, app.id))!;
        // Never deleted (repositories are never removed automatically).
        deps.logger.info(
          `[vetra-apps] Studio product ${app.slug} (${app.id}) was connected to ${winner.repository_full_name ?? "a repository"} meanwhile; ${repo.fullName} is not used`,
        );
        return winner;
      }
    } catch (err) {
      const cleanedUp = made.repo
        ? await undoStudioRepo(deps, github, made.repo)
        : true;
      if (err instanceof GraphQLError) throw err;
      const refusal = inOrg ? orgRefusal(err, account.login) : null;
      if (refusal) {
        deps.logger.warn(
          `[vetra-apps] attachStudioRepository refused in ${account.login} while ${step}: ${String(err)}`,
        );
        throw refusal;
      }
      throw createFailure(
        deps,
        "attachStudioRepository",
        step,
        account.login,
        err,
        { repoRolledBack: made.repo !== null, cleanedUp },
      );
    }
    deps.logger.info(
      `[vetra-apps] Studio product ${app.slug} (${app.id}) keeps its code in ${made.repo!.fullName}`,
    );
    const attached = (await getApp(deps.db, app.id))!;
    await mirrorAppRow(deps, attached);
    return attached;
  });
}

/** A GitHub connection a Studio made the old way (vetra-github-auth). */
export interface StudioGithubConnection {
  /** Whose connection it is (did:pkh:<network>:<chain>:<address>). */
  userDid: string;
  repoFullName: string;
}

/** The address a did:pkh names, lowercased ("" for any other DID). */
const didAddress = (did: string) =>
  did.startsWith("did:pkh:") ? (did.split(":").pop() ?? "").toLowerCase() : "";

/**
 * The repository the owner's old Studio GitHub connection (vetra-github-auth)
 * made for this product's Studio, as Vetra Deploy reaches it, or null:
 * no such connection (only the product owner's own counts), Vetra Deploy is
 * not installed on that account or does not reach the repository, another
 * App already uses it, or (an organisation's repository) the owner has not
 * connected Vetra Deploy there or is no longer an active member. Refusals
 * and failures are logged and leave the product as it is.
 */
async function legacyStudioRepository(
  deps: AppsDeps,
  github: GithubDeployApi,
  app: AppRow,
): Promise<GithubRepoInstallation | null> {
  const lookup = deps.studioGithubConnections;
  if (!lookup || !app.studio_environment_id) return null;
  const ownerAddress = app.owner_address.toLowerCase();
  let connection: StudioGithubConnection | undefined;
  try {
    connection = (await lookup(app.studio_environment_id)).find(
      (c) => didAddress(c.userDid) === ownerAddress,
    );
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] Studio product ${app.slug} (${app.id}): could not read its Studio's GitHub connection: ${String(err)}`,
    );
    return null;
  }
  if (!connection) return null;
  const name = connection.repoFullName;
  try {
    const found = await github.findRepoInstallation(name);
    if (!found) {
      deps.logger.info(
        `[vetra-apps] Studio product ${app.slug} (${app.id}): Vetra Deploy does not reach ${name} yet; its Studio keeps pushing the old way`,
      );
      return null;
    }
    const taken = await deps.db
      .selectFrom("apps")
      .select("id")
      .where("repository_id", "=", found.repo.id)
      .where("status", "!=", "DELETED")
      .where("id", "!=", app.id)
      .executeTakeFirst();
    if (taken) {
      deps.logger.info(
        `[vetra-apps] Studio product ${app.slug} (${app.id}): ${found.repo.fullName} is already used by another App; not carried over`,
      );
      return null;
    }
    if (found.accountType === "Organization")
      await assertOwnerStillInOrg(
        deps,
        github,
        {
          ...app,
          repository_account_login: found.accountLogin,
          repository_connected_by: app.owner_address,
        },
        found.installationId,
      );
    return found;
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] Studio product ${app.slug} (${app.id}): could not carry ${name} over: ${String(err)}`,
    );
    return null;
  }
}

/**
 * Carry a Studio's existing GitHub repository over to its product (spec §8
 * "One app, not two"): when the product has never had a repository, the
 * owner's old Studio connection (vetra-github-auth) has one and Vetra Deploy
 * reaches it, that repository is recorded on the App as
 * attachStudioRepository records a new one (installation, repository,
 * account login and type, repository_connected_by = the owner). Nothing is
 * created, moved or deleted on GitHub. Triggered by the Studio's agent
 * (D20 binding): explicitly, or by its first push token request
 * (studioPushToken), so no customer action is needed. Until it is carried
 * over the Studio keeps pushing with its old connection. Returns the App,
 * changed or not.
 */
export async function adoptStudioRepository(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  secret: string | null,
): Promise<AppRow> {
  const app = await studioAppFor(deps, caller, appId, secret);
  if (!isStudioProduct(app))
    throw appsError(
      "BAD_USER_INPUT",
      "This App is deployed from its own repository; the Studio does not push to it",
    );
  return carryStudioRepositoryOver(deps, app);
}

/** adoptStudioRepository after the binding: the App, with the repository recorded when one was carried over. */
async function carryStudioRepositoryOver(
  deps: AppsDeps,
  app: AppRow,
): Promise<AppRow> {
  // Once a product has had a repository (even one GitHub took away), the
  // owner decides from its settings.
  if (app.repository_id || !deps.github) return app;
  const github = deps.github;
  const studioId = app.studio_environment_id!;
  return withKeyLock(`studio-app:${studioId}`, async () => {
    const current = (await getApp(deps.db, app.id)) ?? app;
    if (current.repository_id) return current;
    const found = await legacyStudioRepository(deps, github, current);
    if (!found) return current;
    const recorded = await deps.db
      .updateTable("apps")
      .set({
        installation_id: found.installationId,
        repository_id: found.repo.id,
        repository_full_name: found.repo.fullName,
        repository_account_login: found.accountLogin,
        repository_account_type: found.accountType,
        repository_disconnected_at: null,
        repository_connected_by: current.owner_address,
        updated_at: deps.now().toISOString(),
      })
      .where("id", "=", current.id)
      // Another replica may have recorded a repository meanwhile.
      .where("repository_id", "is", null)
      .returning("id")
      .executeTakeFirst();
    const after = (await getApp(deps.db, current.id))!;
    if (!recorded) return after;
    deps.logger.info(
      `[vetra-apps] Studio product ${after.slug} (${after.id}) carried its Studio's repository ${found.repo.fullName} over`,
    );
    await mirrorAppRow(deps, after);
    return after;
  });
}

/**
 * Before a push token for an organisation's repository: whoever connected it
 * (repository_connected_by; the App's owner on rows without it) must still be
 * an active member of it, checked with their GitHub user token for the
 * repository's installation. A
 * 403 that names no policy means the app may not read memberships: GitHub's
 * own checks then decide, logged at warn.
 */
async function assertOwnerStillInOrg(
  deps: AppsDeps,
  github: GithubDeployApi,
  app: AppRow,
  installationId: string,
): Promise<void> {
  const org = app.repository_account_login ?? "";
  const userToken = await userTokenFor(
    deps,
    {
      address: app.repository_connected_by ?? app.owner_address,
      chainId: app.owner_chain_id,
      appKey: null,
      isAdmin: false,
    },
    installationId,
  );
  let membership: { state: string; role: string } | null;
  try {
    membership = await github.getOrgMembership(userToken, org);
  } catch (err) {
    if (namesOrgPolicy(err)) throw githubErrors.studioOrgPolicy(org);
    if (!isRefusal(err, 403))
      throw classifyGithubError(err, org) ?? err;
    deps.logger.warn(
      `[vetra-apps] push token for App ${app.slug} (${app.id}): GitHub did not let Vetra read the connecting user's membership of ${org}; left to GitHub`,
    );
    return;
  }
  if (membership?.state !== "active")
    throw githubErrors.studioOrgNotInstalled(org);
}

/**
 * A short-lived token the Studio's agent pushes its product's code with
 * (D20 binding: verifyStudioSecret + verifyStudioBinding through
 * studioAppFor). An installation token limited to the App's one repository
 * with contents:write; GitHub issues it for an hour, and the reported expiry
 * never says more. Another Studio, the owner's browser or a wrong secret get
 * STUDIO_BINDING; a product without (or no longer with) a repository
 * GITHUB_NOT_CONNECTED. The token is never logged.
 */
export async function studioPushToken(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  secret: string | null,
): Promise<StudioPushToken> {
  const bound = await studioAppFor(deps, caller, appId, secret);
  if (!isStudioProduct(bound))
    throw appsError(
      "BAD_USER_INPUT",
      "This App is deployed from its own repository; the Studio does not push to it",
    );
  // The first push token request carries the Studio's old repository over.
  const app = await carryStudioRepositoryOver(deps, bound);
  const repo = appRepository(app);
  if (!repo || app.repository_disconnected_at) throw notConnected();
  const github = requireGithub(deps);
  if (app.repository_account_type === "Organization")
    await assertOwnerStillInOrg(deps, github, app, repo.installationId);
  let minted: { token: string; expiresAt: string };
  try {
    minted = await github.createRepoPushToken(
      repo.installationId,
      repo.repositoryId,
    );
  } catch (err) {
    // The installation is gone or no longer covers the repository.
    if (isRefusal(err, 403) || isRefusal(err, 404) || isRefusal(err, 422)) {
      deps.logger.warn(
        `[vetra-apps] no push token for App ${app.slug} (${app.id}): GitHub refused (${(err as GithubHttpError).status})`,
      );
      throw notConnected();
    }
    throw classifyGithubError(err, repo.fullName.split("/")[0] ?? "") ?? err;
  }
  const cap = deps.now().getTime() + STUDIO_PUSH_TOKEN_MAX_MS;
  const given = Date.parse(minted.expiresAt);
  const expiresAt = new Date(
    Number.isNaN(given) ? cap : Math.min(given, cap),
  ).toISOString();
  return {
    token: minted.token,
    expiresAt,
    remoteUrl: `https://github.com/${repo.fullName}.git`,
  };
}

/** A full git commit sha (SHA-1 or SHA-256 repositories), as a push names it. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The Studio's agent announces the commit it is about to push to GitHub
 * (D15, called before the push): the push webhook then knows it as the
 * Studio's own. Stored on the App's latest PRODUCTION deployment
 * (`app_deployments.mirror_sha`) and on the App (`apps.mirror_sha`, for a
 * product that has not launched yet). D20 binding via studioAppFor.
 */
export async function recordStudioMirror(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  sha: string,
  secret: string | null,
): Promise<boolean> {
  if (typeof sha !== "string" || !FULL_SHA.test(sha))
    throw appsError("BAD_USER_INPUT", "sha must be a full git commit sha");
  const app = await studioAppFor(deps, caller, appId, secret);
  if (!isStudioProduct(app))
    throw appsError(
      "BAD_USER_INPUT",
      "This App is deployed from its own repository; the Studio does not push to it",
    );
  const mirror = sha.toLowerCase();
  const nowIso = deps.now().toISOString();
  await deps.db.transaction().execute(async (trx) => {
    const latest = await trx
      .selectFrom("app_deployments")
      .select("id")
      .where("app_id", "=", app.id)
      .where("kind", "=", "PRODUCTION")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (latest)
      await trx
        .updateTable("app_deployments")
        .set({ mirror_sha: mirror })
        .where("id", "=", latest.id)
        .execute();
    await trx
      .updateTable("apps")
      .set({ mirror_sha: mirror, updated_at: nowIso })
      .where("id", "=", app.id)
      .execute();
  });
  return true;
}

/**
 * The Studio's agent brought the changes made on GitHub in (they are in what
 * it pushed): `apps.external_changes_sha` is cleared. D20 binding.
 */
export async function clearExternalChanges(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  secret: string | null,
): Promise<boolean> {
  const app = await studioAppFor(deps, caller, appId, secret);
  if (app.external_changes_sha) {
    await deps.db
      .updateTable("apps")
      .set({ external_changes_sha: null, updated_at: deps.now().toISOString() })
      .where("id", "=", app.id)
      .execute();
    deps.logger.info(
      `[vetra-apps] changes made on GitHub brought into ${app.slug}`,
    );
  }
  return true;
}

/**
 * The checks before anything is made: workload refusal, name, org role and
 * the Harbor/Renown/encryption/hand-over configuration. Returns the trimmed
 * name.
 */
async function assertCreatePreconditions(
  deps: AppsDeps,
  caller: Caller,
  rawName: string,
  orgId: string | null,
): Promise<string> {
  await assertNotWorkload(deps, caller);
  const name = rawName.trim();
  if (!name || name.length > 100)
    throw appsError("BAD_USER_INPUT", "Name must be 1-100 characters");
  // OWNER/ADMIN, or PUBLISHER with every app in scope; admins get no bypass,
  // and a Renown outage refuses (fail closed).
  if (
    orgId &&
    !(await canCreateOrgApp(deps.orgs ?? null, callerAccess(caller), orgId))
  ) {
    throw appsError(
      "FORBIDDEN",
      "Creating Apps in this organisation needs the publisher role with access to all its apps",
    );
  }
  if (!deps.harbor) throw notConfigured("Harbor (HARBOR_APPS_ADMIN_*)");
  if (!deps.renown) throw notConfigured("Renown workload identities");
  if (!deps.cfg.encryptionKey) throw notConfigured("VETRA_APPS_ENCRYPTION_KEY");
  // An org App's env is handed over with an announced move; without the
  // announcement store the move would be reverted.
  if (orgId && !deps.orgHandoverDb)
    throw notConfigured("The organisation hand-over store");
  return name;
}

/**
 * Reserve a unique slug and its Harbor project (`app-<slug>`; sets
 * made.project). Harbor 409 = someone else's project: never reuse it, take the
 * next suffix.
 */
async function reserveSlugAndProject(
  deps: AppsDeps,
  harbor: HarborApi,
  name: string,
  made: CreateMade,
  conflicts: Set<string>,
): Promise<string> {
  let slug: string | null = null;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const candidate = await uniqueSlug(deps, name, conflicts);
    if (await harbor.createProject(`app-${candidate}`)) {
      slug = candidate;
      made.project = `app-${candidate}`;
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
  return slug;
}

interface InsertAppRowInput {
  appId: string;
  slug: string;
  name: string;
  caller: Caller;
  orgId: string | null;
  did: string;
  robot: { id: number; name: string; secret: string };
  installationId: string;
  repo: { id: string; fullName: string };
  productionBranch: string;
  harborProject: string;
  productionEnvironmentId: string;
  /** The Vetra Studio env the App is created from (never app-linked). */
  studioEnvironmentId?: string | null;
}

/** The apps row, in PENDING_IDENTITY (the identity delegation comes later). */
async function insertAppRow(
  deps: AppsDeps,
  input: InsertAppRowInput,
): Promise<void> {
  const nowIso = deps.now().toISOString();
  const encryptionKey = deps.cfg.encryptionKey!;
  await deps.db
    .insertInto("apps")
    .values({
      id: input.appId,
      slug: input.slug,
      name: input.name,
      owner_address: input.caller.address,
      owner_chain_id: input.caller.chainId,
      status: "PENDING_IDENTITY",
      installation_id: input.installationId,
      repository_id: input.repo.id,
      repository_full_name: input.repo.fullName,
      production_branch: input.productionBranch,
      production_environment_id: input.productionEnvironmentId,
      previews_enabled: true,
      preview_limit: DEFAULT_PREVIEW_LIMIT,
      preview_ttl_days: DEFAULT_PREVIEW_TTL_DAYS,
      harbor_project: input.harborProject,
      harbor_robot_name: input.robot.name,
      harbor_robot_id: input.robot.id,
      identity_expires_at: null,
      // Set from the start: the app document is protected for the Vetra
      // service identity the moment it exists (appDocumentRowOwner).
      owner_org_id: input.orgId,
      studio_environment_id: input.studioEnvironmentId ?? null,
      harbor_robot_secret_enc: encryptSecret(encryptionKey, input.robot.secret),
      identity_did: input.did,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .execute();
}

interface ProvisionInput {
  envId: string;
  appId: string;
  name: string;
  harborProject: string;
  productionBranch: string;
  orgId: string | null;
  /** The existing env being attached (null: a new env is initialised). */
  attach: { state: VetraCloudEnvironmentState } | null;
  /** genericSubdomain of a new env (default: generated from its id). */
  subdomain?: string;
  /** Owner of a new env (default: the caller). */
  ownerAddress?: string;
  /** A Studio product: Switchboard and Connect enabled, Connect at the apex. */
  connectAtApex?: boolean;
}

/** What makes an env serve a Studio product: Switchboard + Connect, Connect at the apex. */
function productServiceActions(state: VetraCloudEnvironmentState | null): Action[] {
  const actions: Action[] = [];
  for (const [type, prefix] of [
    ["SWITCHBOARD", "switchboard"],
    ["CONNECT", "connect"],
  ] as const) {
    const svc = state?.services.find((s) => s.type === type);
    if (!svc?.enabled)
      actions.push(enableService({ type, prefix: svc?.prefix || prefix }));
  }
  if (state?.apexService !== "CONNECT")
    actions.push(setApexService({ type: "CONNECT" }));
  return actions;
}

/**
 * Link the production env to the App and dispatch its actions: an attached
 * env gets the link (and the org hand-over); a new one is initialised, owned,
 * linked and approved.
 */
async function provisionProductionEnv(
  deps: AppsDeps,
  caller: Caller,
  input: ProvisionInput,
  made: CreateMade,
): Promise<void> {
  const { attach, orgId } = input;
  const link = setAppLink({
    appId: input.appId,
    role: "PRODUCTION",
    prNumber: null,
    gitRef: `refs/heads/${input.productionBranch}`,
    imageProject: input.harborProject,
  });
  // An org App's env is handed to the org (the creator its first operator;
  // the operator sync refills the list). The move is announced first,
  // inside the env lock, so the observability protection keeps it.
  const handOver =
    orgId && !(attach && attach.state.ownerOrgId)
      ? [setOwnerOrg({ ownerOrgId: orgId, operators: [caller.address] })]
      : [];
  const targetEnv = input.envId;
  const dispatch = (actions: Action[]) =>
    withEnvLock(targetEnv, async () => {
      if (handOver.length > 0) {
        await expectOrgHandover(deps.orgHandoverDb!, targetEnv, orgId);
        made.announced = { envId: targetEnv, orgId };
      }
      await deps.envs.execute(targetEnv, actions);
    });
  if (attach) {
    const wasReady = attach.state.status === "READY";
    // The link widens the FUSION allowlist, so it re-renders; re-approve only
    // a settled env (never ship an owner's unapproved pending edits).
    await dispatch([
      link,
      ...handOver,
      ...(input.connectAtApex ? productServiceActions(attach.state) : []),
    ]);
    if (wasReady) await deps.envs.execute(input.envId, [approveChanges({})]);
  } else {
    await dispatch([
      setLabel({ label: input.name }),
      initialize({
        genericSubdomain: input.subdomain ?? deps.generateSubdomain(input.envId),
        genericBaseDomain: "vetra.io",
        defaultPackageRegistry: deps.cfg.productionRegistry,
      }),
      setOwner({ address: input.ownerAddress ?? caller.address }),
      ...handOver,
      link,
      enableService({ type: "SWITCHBOARD", prefix: "switchboard" }),
      enableService({ type: "CONNECT", prefix: "connect" }),
      ...(input.connectAtApex ? [setApexService({ type: "CONNECT" })] : []),
    ]);
    await deps.envs.execute(input.envId, [approveChanges({})]);
  }
}

/**
 * Register the repository's workload identity for `orgId` (null: personally).
 * Renown is idempotent per repository and returns an existing identity
 * unchanged, whoever it belongs to; another address gets CONFLICT (M11). An
 * identity of another owner (person vs organisation, or another organisation)
 * would make the App's profile unclaimable. When no live App uses it, it is
 * an orphan of this same address (a failed or deleted App): it is deleted and
 * registered once more. Otherwise, or when Renown hands it back unchanged,
 * the create is refused.
 */
async function registerAppIdentity(
  deps: AppsDeps,
  renown: RenownApi,
  input: {
    repositoryId: string;
    repository: string;
    productionBranch: string;
    ownerAddress: string;
    chainId: number;
    orgId: string | null;
  },
): Promise<string> {
  const { orgId, ...rest } = input;
  const register = async () => {
    try {
      return await renown.registerWorkloadIdentity({
        ...rest,
        ...(orgId ? { ownerOrgId: orgId } : {}),
      });
    } catch (err) {
      if (isRenownConflict(err))
        throw appsError("BAD_USER_INPUT", IDENTITY_OWNED_ELSEWHERE);
      throw err;
    }
  };
  const matches = (r: { ownerOrgId: string | null }) =>
    (r.ownerOrgId ?? null) === orgId;
  const first = await register();
  if (matches(first)) return first.did;
  if (
    (await identityInUse(deps, first.did)) ||
    (await identityHasProfile(deps, first.did))
  ) {
    throw appsError("BAD_USER_INPUT", IDENTITY_OWNED_ELSEWHERE);
  }
  deps.logger.warn(
    `[vetra-apps] re-registering the orphaned identity ${first.did} of ${input.repository} for ${orgId ?? input.ownerAddress}`,
  );
  await renown.deleteWorkloadIdentity(first.did);
  const second = await register();
  if (!matches(second))
    throw appsError("BAD_USER_INPUT", IDENTITY_OWNED_ELSEWHERE);
  return second.did;
}

/**
 * Whether the identity still has a Renown app profile (its listing and
 * licences may live on although no Vetra App uses it), or that cannot be
 * told: such an identity is never deleted to be re-registered (m9).
 */
async function identityHasProfile(
  deps: AppsDeps,
  did: string,
): Promise<boolean> {
  if (!deps.orgs) return false;
  try {
    return (await deps.orgs.appPublisher(did)) !== null;
  } catch {
    return true;
  }
}

/** Whether a live (not DELETED) App uses the identity. */
async function identityInUse(deps: AppsDeps, did: string): Promise<boolean> {
  const row = await deps.db
    .selectFrom("apps")
    .select("id")
    .where("identity_did", "=", did)
    .where("status", "!=", "DELETED")
    .executeTakeFirst();
  return !!row;
}

interface CreateMade {
  project: string | null;
  robotId: number | null;
  appId: string | null;
  /** The announced organisation move (withdrawn on failure). */
  announced: { envId: string; orgId: string | null } | null;
  /**
   * The repository created for a Studio App. Deleted with the installation
   * token once the installation covers it, else with the user's token.
   */
  repo: {
    id: string;
    fullName: string;
    installationId: string;
    userToken: string;
    inInstallation: boolean;
  } | null;
  /** The production env document made for the App (never an attached one). */
  envId: string | null;
}

/**
 * The error a failed (and undone) create reports: refusals as they are, a
 * GitHub failure as its customer code (logged at warn), anything else as
 * DEPLOY_SETUP_FAILED, logged at error level with the step.
 */
function createFailure(
  deps: AppsDeps,
  what: string,
  step: string,
  account: string,
  err: unknown,
  outcome: { repoRolledBack: boolean; cleanedUp: boolean },
): GraphQLError {
  if (err instanceof GraphQLError) return err;
  const mapped = classifyGithubError(err, account);
  if (mapped) {
    deps.logger.warn(
      `[vetra-apps] ${what} failed while ${step}: ${String(err)}`,
    );
    return mapped;
  }
  deps.logger.error(
    `[vetra-apps] ${what} failed while ${step}: ${String(err)}`,
  );
  return githubErrors.deploySetupFailed(outcome);
}

/**
 * Undo a createApp/createStudioApp that failed: the apps row, the
 * production env document it made, the announcement, the robot, the project, the Studio App repository, and the
 * identity (when registered, null: not yet) when no live App uses it. Best
 * effort: every failure is logged, none is thrown; false when any step
 * failed (something may be left behind).
 */
async function undoFailedCreate(
  deps: AppsDeps,
  harbor: HarborApi,
  renown: RenownApi | null,
  did: string | null,
  made: CreateMade,
): Promise<boolean> {
  let cleanedUp = true;
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      cleanedUp = false;
      deps.logger.error(
        `[vetra-apps] cleaning up a failed createApp: ${what} failed: ${String(err)}`,
      );
    }
  };
  const { appId, announced, robotId, project } = made;
  if (appId)
    await step("deleting the row", () =>
      deps.db.deleteFrom("apps").where("id", "=", appId).execute(),
    );
  const { envId } = made;
  if (envId)
    await step("deleting the production env", () => deps.envs.delete(envId));
  if (announced && deps.orgHandoverDb) {
    const db = deps.orgHandoverDb;
    await step("withdrawing the hand-over", () =>
      withdrawOrgHandover(db, announced.envId, announced.orgId),
    );
  }
  if (robotId !== null)
    await step("deleting the robot", () => harbor.deleteRobot(robotId));
  if (project)
    await step("deleting the Harbor project", () =>
      harbor.deleteProject(project),
    );
  if (made.repo && deps.github) {
    if (!(await undoStudioRepo(deps, deps.github, made.repo)))
      cleanedUp = false;
  }
  if (did !== null && renown)
    await step("deleting the identity", async () => {
      if (!(await identityInUse(deps, did)))
        await renown.deleteWorkloadIdentity(did);
    });
  return cleanedUp;
}

/**
 * Delete a Studio App repository made by a failed create. A user token only
 * reaches what both the user and the app can access, so a repo not yet in a
 * selected installation is first added to it, then deleted with the
 * installation token; the user-token delete is the last resort. A 404 is
 * never taken as done here: we just created the repo, so it means we could
 * not reach it, and it is logged for removal by hand. Never throws; false
 * when the repository could not be deleted.
 */
async function undoStudioRepo(
  deps: AppsDeps,
  github: GithubDeployApi,
  repo: NonNullable<CreateMade["repo"]>,
): Promise<boolean> {
  const warn = (what: string, err: unknown) =>
    deps.logger.warn(
      `[vetra-apps] cleaning up a failed createStudioApp: ${what} failed: ${String(err)}`,
    );
  let deleted = false;
  try {
    if (!repo.inInstallation)
      await github.addRepoToInstallation(
        repo.userToken,
        repo.installationId,
        repo.id,
      );
    deleted = await github.deleteRepo(repo.installationId, repo.fullName);
  } catch (err) {
    warn(`deleting ${repo.fullName} with the installation token`, err);
  }
  if (!deleted && !repo.inInstallation) {
    try {
      deleted = await github.deleteRepoAsUser(repo.userToken, repo.fullName);
    } catch (err) {
      warn(`deleting ${repo.fullName} with the user token`, err);
    }
  }
  if (!deleted)
    deps.logger.warn(
      `[vetra-apps] could not delete the GitHub repository ${repo.fullName} after a failed createStudioApp; remove it by hand`,
    );
  return deleted;
}

/**
 * Re-check the delegation of the App identity.
 *
 * Personal App: the owner's. The newest valid credential → ACTIVE with its
 * expiry; none (never signed, expired or revoked) → PENDING_IDENTITY.
 *
 * Org App: the caller's (any operator may authorise it, Ruling 12). One
 * operator's lookup never speaks for the others, so it only upgrades
 * (PENDING_IDENTITY → ACTIVE) or extends the expiry; a caller without a
 * delegation, or with a shorter one, changes nothing. Expiry is left to the
 * identity-expiry sweep.
 *
 * A DISCONNECTED App keeps its status either way.
 */
export async function confirmAppIdentity(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
) {
  const app = await loadAppForOwner(deps, caller, appId);
  // A Studio product without GitHub has no CI workload identity to confirm:
  // its identity is the Studio agent's key, checked on every agent call.
  if (!hasCiIdentity(app)) return app;
  if (!deps.renown) throw notConfigured("Renown workload identities");
  const delegation = await deps.renown.getDelegation({
    address: app.owner_org_id ? caller.address : app.owner_address,
    chainId: app.owner_org_id ? caller.chainId : app.owner_chain_id,
    did: app.identity_did,
  });
  let status: AppRow["status"] =
    app.status === "DISCONNECTED"
      ? app.status
      : delegation
        ? "ACTIVE"
        : "PENDING_IDENTITY";
  let expiresAt = delegation?.expiresAt ?? null;
  if (app.owner_org_id) {
    if (!delegation) return app;
    if (app.status === "ACTIVE" || app.status === "DISCONNECTED") {
      status = app.status;
      expiresAt = laterExpiry(app.identity_expires_at, expiresAt);
    }
  }
  await deps.db
    .updateTable("apps")
    .set({
      status,
      identity_expires_at: expiresAt,
      updated_at: deps.now().toISOString(),
    })
    .where("id", "=", app.id)
    .execute();
  const confirmed = (await getApp(deps.db, app.id))!;
  await mirrorAppRow(deps, confirmed);
  return confirmed;
}

/** The later of two expiries; null (no expiry) is the latest. */
function laterExpiry(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return Date.parse(b) > Date.parse(a) ? b : a;
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
    if (!hasCiIdentity(app))
      throw appsError(
        "BAD_USER_INPUT",
        appRepository(app)
          ? "A Studio product launches from its Studio, not from a branch"
          : "This App has no repository",
      );
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
  const updated = (await getApp(deps.db, app.id))!;
  await mirrorAppRow(deps, updated);
  return updated;
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
  // A Studio product registered no workload identity (its identity is the
  // Studio agent's key, on GitHub or not): nothing to delete at Renown.
  if (hasCiIdentity(app)) {
    if (!deps.renown) throw notConfigured("Renown workload identities");
    try {
      await deps.renown.deleteWorkloadIdentity(app.identity_did);
    } catch (err) {
      if (!/NOT_FOUND/.test(String(err))) throw err;
    }
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
  await mirrorAppById(deps, app.id);
  deps.logger.info(
    `[vetra-apps] deleted App ${app.slug} (${app.id}); slug stays reserved`,
  );
  return true;
}

/**
 * What toolchain the generated workflow must set up. The lockfile decides, since
 * it is what the install actually needs; a repository with no package.json gets
 * no setup and no install/build/publish steps at all.
 *
 * Probing is best-effort: if GitHub cannot be read we fall back to pnpm, which
 * is what the workflow assumed unconditionally before.
 */
export async function detectRepoToolchain(
  github: GithubDeployApi,
  installationId: string,
  repoFullName: string,
): Promise<{
  packageManager: PackageManager | null;
  declaresPackageManager: boolean;
}> {
  const read = (path: string) =>
    github.getRepoFile(installationId, repoFullName, path).catch(() => null);

  const pkg = await read("package.json");
  if (pkg === null)
    return { packageManager: null, declaresPackageManager: false };

  let declaresPackageManager = false;
  try {
    declaresPackageManager =
      typeof (JSON.parse(pkg) as { packageManager?: unknown })
        .packageManager === "string";
  } catch {
    // An unparseable package.json still means there is a Node project here.
  }

  for (const [lockfile, manager] of LOCKFILES) {
    if ((await read(lockfile)) !== null)
      return { packageManager: manager, declaresPackageManager };
  }
  // A package.json with no lockfile: pnpm remains the house default.
  return { packageManager: "pnpm", declaresPackageManager };
}

export async function openAppSetupPullRequest(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
): Promise<string> {
  const app = await loadAppForOwner(deps, caller, appId);
  const repository = requireRepository(app);
  // D15: no deploy workflow for a Studio product; its Studio launches it.
  if (isStudioProduct(app))
    throw appsError(
      "BAD_USER_INPUT",
      "A Studio product launches from its Studio; it needs no deploy workflow",
    );
  const github = requireGithub(deps);
  const repo = await detectRepoToolchain(
    github,
    repository.installationId,
    repository.fullName,
  );
  return github.openPullRequestWithFile(
    repository.installationId,
    repository.fullName,
    {
      branch: "vetra/setup",
      path: ".github/workflows/vetra.yml",
      content: workflowTemplate(app.id, app.production_branch, repo),
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
  if (!app.harbor_robot_secret_enc)
    throw appsError("BAD_USER_INPUT", "This App has no registry robot");
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
  const app = await loadAppForOwner(deps, caller, appId, { need: "view" });
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
  await loadAppForOwner(deps, caller, d.app_id, { need: "view" });
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
  trigger: DeploymentTrigger;
  /** did:pkh of the owner the deployment is made for. */
  onBehalfOf: string | null;
  versionNumber: number | null;
  /** Packages to uninstall with it (a restore after a failed Studio launch). */
  removePackages?: string[];
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
  // A Studio product without GitHub has no CI: no claim can match it.
  if (!app.repository_id || claim.repositoryId !== app.repository_id) {
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
  const repo = appRepository(app);
  if (!deps.github || !repo) return false;
  try {
    const state = await deps.github.getPullRequestState(
      repo.installationId,
      repo.fullName,
      prNumber,
    );
    return state !== "open";
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] PR state of ${repo.fullName}#${prNumber} unavailable: ${String(err)}`,
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
    trigger: DeploymentTrigger;
    onBehalfOf: string | null;
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
      trigger: req.trigger,
      on_behalf_of: req.onBehalfOf,
      version_number: null,
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
  actor: {
    did: string | null;
    github: string | null;
    gitRef: string;
    trigger: DeploymentTrigger;
    onBehalfOf: string | null;
  },
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
  if (input.kind === "PREVIEW" && !appRepository(app)) {
    throw appsError(
      "PREVIEWS_DISABLED",
      "Previews come from pull requests; this App has no repository",
    );
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
      trigger: actor.trigger,
      onBehalfOf: actor.onBehalfOf,
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
    trigger: actor.trigger,
    onBehalfOf: actor.onBehalfOf,
    versionNumber: null,
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
  const did = ownerDid(caller);
  return deployChecked(deps, app, input, prNumber, {
    did,
    github: input.actorGithub?.trim() || null,
    gitRef: (input.gitRef ?? "").trim(),
    trigger: "OWNER",
    onBehalfOf: did,
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
    trigger: "CI",
    onBehalfOf: `did:pkh:eip155:${ci.chainId}:${ci.address}`,
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
    actorDid: ownerDid(caller),
    packages: parsePackages(source.packages),
    image: source.image_tag ? splitImage(source.image_tag) : null,
    trigger: "OWNER",
    onBehalfOf: ownerDid(caller),
    versionNumber: source.version_number ?? null,
  });
}

/** The did:pkh of a signed-in person (or of the owner an agent key acts for). */
function ownerDid(caller: Pick<Caller, "chainId" | "address">): string {
  return `did:pkh:eip155:${caller.chainId}:${caller.address}`;
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
  // An org App's preview belongs to the org from its first action; the move
  // is announced before it is dispatched (performDeploy, minutes at most).
  // Checked first, so a misconfiguration evicts no preview.
  if (app.owner_org_id && !deps.orgHandoverDb)
    throw notConfigured("The organisation hand-over store");
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
  if (app.owner_org_id)
    await expectOrgHandover(deps.orgHandoverDb!, envId, app.owner_org_id);
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
    ...(app.owner_org_id
      ? [
          setOwnerOrg({
            ownerOrgId: app.owner_org_id,
            operators: productionState?.orgOperators ?? [],
          }),
        ]
      : []),
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
  for (const name of req.removePackages ?? []) {
    if (state?.packages.some((p) => p.name === name))
      actions.push(removePackage({ packageName: name }));
  }
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

interface DeployTarget {
  envId: string;
  /** The env's state now; null = a preview created in the same batch. */
  state: VetraCloudEnvironmentState | null;
  createActions: Action[];
  fusionEnvTemplate: FusionEnvInput[];
}

/** The production env, checked: it exists and is linked to the App as its production env. */
function assertProductionEnv(
  app: AppRow,
  state: VetraCloudEnvironmentState | null,
): VetraCloudEnvironmentState {
  if (!state) throw appsError("NOT_FOUND", "Production environment not found");
  if (state.app?.appId !== app.id || state.app.role !== "PRODUCTION") {
    throw appsError(
      "BAD_USER_INPUT",
      "Production environment is not linked to this App",
    );
  }
  return state;
}

/** One app_deployments row from a request (no write). */
function deploymentRow(
  id: string,
  appId: string,
  envId: string,
  req: DeployRequest,
  status: DeploymentRow["status"],
  nowIso: string,
): DeploymentRow {
  return {
    id,
    app_id: appId,
    environment_id: envId,
    kind: req.kind,
    pr_number: req.prNumber,
    git_ref: req.gitRef,
    sha: req.sha,
    packages: JSON.stringify(req.packages),
    image_tag: req.image ? `${req.image.repository}:${req.image.tag}` : null,
    status,
    actor_did: req.actorDid,
    actor_github: req.actorGithub,
    run_url: req.runUrl,
    error: null,
    github_deployment_id: null,
    trigger: req.trigger,
    on_behalf_of: req.onBehalfOf,
    version_number: req.versionNumber,
    pre_apply_packages: null,
    mirror_sha: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** A newer deployment of the same env wins: the env's other pending/under-way rows → SUPERSEDED. */
async function supersedeOthers(
  db: Kysely<VetraAppsDB>,
  envId: string,
  id: string,
  nowIso: string,
): Promise<string[]> {
  const superseded = await db
    .updateTable("app_deployments")
    .set({ status: "SUPERSEDED", updated_at: nowIso })
    .where("environment_id", "=", envId)
    .where("id", "!=", id)
    .where("status", "in", ACTIVE_DEPLOYMENT_STATUSES)
    .returning("id")
    .execute();
  return superseded.map((r) => r.id);
}

/**
 * Bring the env to the deployment's packages + image and approve; the row
 * goes DEPLOYING, or FAILED with the reason. Returns whether it was applied.
 */
async function applyToEnv(
  deps: AppsDeps,
  app: AppRow,
  id: string,
  target: DeployTarget,
  req: DeployRequest,
): Promise<boolean> {
  const { envId, state, createActions, fusionEnvTemplate } = target;
  const registry =
    req.kind === "PRODUCTION"
      ? deps.cfg.productionRegistry
      : deps.cfg.previewRegistry;
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
    return true;
  } catch (err) {
    // A new org preview whose hand-over never landed leaves no announcement.
    const orgId = app.owner_org_id;
    if (createActions.length > 0 && orgId && deps.orgHandoverDb) {
      await withdrawOrgHandover(deps.orgHandoverDb, envId, orgId).catch(
        (e: unknown) =>
          deps.logger.warn(
            `[vetra-apps] withdrawing the hand-over of preview env ${envId} failed: ${String(e)}`,
          ),
      );
    }
    await updateDeployment(
      deps.db,
      id,
      {
        status: "FAILED",
        error: String(err instanceof Error ? err.message : err).slice(0, 1000),
      },
      deps.now().toISOString(),
    );
    return false;
  }
}

async function performDeploy(
  deps: AppsDeps,
  app: AppRow,
  productionState: VetraCloudEnvironmentState | null,
  req: DeployRequest,
): Promise<DeploymentRow> {
  const nowIso = deps.now().toISOString();
  const id = deps.newId();

  let target: DeployTarget;
  if (req.kind === "PRODUCTION") {
    target = {
      envId: app.production_environment_id,
      state: assertProductionEnv(app, productionState),
      createActions: [],
      fusionEnvTemplate: [],
    };
  } else {
    const ensured = await ensurePreview(
      deps,
      app,
      req.prNumber!,
      req.gitRef,
      productionState,
    );
    const envId = ensured.preview.environment_id;
    target = {
      envId,
      state: ensured.created ? null : await deps.envs.getState(envId),
      createActions: ensured.createActions,
      fusionEnvTemplate: ensured.fusionEnvTemplate,
    };
  }

  await deps.db
    .insertInto("app_deployments")
    .values(deploymentRow(id, app.id, target.envId, req, "PENDING", nowIso))
    .execute();
  for (const s of await supersedeOthers(deps.db, target.envId, id, nowIso))
    await notifyChanged(deps, s);

  await applyToEnv(deps, app, id, target, req);
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

// ---------------------------------------------------------------------------
// Studio agent: launch, roll back, product drive (D20)
// ---------------------------------------------------------------------------

/** Deployments the watcher applies (recorded PENDING by the Studio-agent path). */
export const QUEUED_TRIGGERS: DeploymentTrigger[] = [
  "STUDIO_LAUNCH",
  "STUDIO_ROLLBACK",
];

/** actor_github of the deployment that puts the previous version back after a failed Studio launch. */
export const RESTORE_ACTOR = "restore";

/** Packages a Studio publishes: the product's scope on the stack registry. */
export const STUDIO_PACKAGE_SCOPE = "@vetra-apps/";

const GIT_TAG = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DRIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_VERSION_NUMBER = 1_000_000;

export interface LaunchStudioVersionInput {
  appId: string;
  versionNumber: number;
  sha: string;
  gitTag: string;
  packages: { name: string; version: string }[];
}

/**
 * The App the Studio's agent acts on: it must be the App of the agent's own
 * Studio, with the owner's delegation current (verifyStudioBinding). An
 * unknown App reads as any other App (STUDIO_BINDING). Returns the row with
 * its ownership reconciled.
 */
async function studioAppFor(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  secret: string | null,
): Promise<AppRow> {
  if (!caller.appKey) throw appsError("DELEGATION_MISSING", DELEGATION_MESSAGE);
  const app = await getApp(deps.db, appId);
  if (!app) throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
  await verifyStudioBinding(deps, caller, secret, app);
  return (await getApp(deps.db, app.id)) ?? app;
}

/** The product's production env, ready to take a deployment. */
async function studioProductionEnv(
  deps: AppsDeps,
  app: AppRow,
): Promise<VetraCloudEnvironmentState> {
  if (app.status !== "ACTIVE")
    throw appsError("APP_NOT_ACTIVE", `App is ${app.status}`);
  const state = assertProductionEnv(
    app,
    await deps.envs.getState(app.production_environment_id),
  );
  if (RELEASED_STATUSES.has(state.status))
    throw appsError("BAD_USER_INPUT", `The live app is ${state.status}`);
  return state;
}

/**
 * The launch of (app, version, sha) a retry gets back: one still pending or
 * under way, or a READY one that is still what runs on the production env
 * (no later deployment other than FAILED/SUPERSEDED ones). A READY one that
 * is no longer live (a Go back came after it) is not: the launch is new.
 */
async function findStudioLaunch(
  db: Kysely<VetraAppsDB>,
  app: AppRow,
  versionNumber: number,
  sha: string,
): Promise<DeploymentRow | null> {
  const rows = await db
    .selectFrom("app_deployments")
    .selectAll()
    .where("app_id", "=", app.id)
    .where("trigger", "=", "STUDIO_LAUNCH")
    .where("version_number", "=", versionNumber)
    .where("sha", "=", sha)
    .where("status", "in", ["PENDING", "DEPLOYING", "READY"])
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .execute();
  const inFlight = rows.find((r) => r.status !== "READY");
  if (inFlight) return inFlight;
  const ready = rows[0];
  if (!ready || ready.environment_id !== app.production_environment_id)
    return null;
  const later = await db
    .selectFrom("app_deployments")
    .select("id")
    .where("environment_id", "=", app.production_environment_id)
    .where("id", "!=", ready.id)
    .where("created_at", ">=", ready.created_at)
    .where("status", "not in", ["FAILED", "SUPERSEDED"])
    .executeTakeFirst();
  return later ? null : ready;
}

/**
 * Record a Studio deployment PENDING on the production env (superseding the
 * env's pending/under-way ones) and hand it to the watcher. A launch first
 * marks the App launched (launched_at, kept from the first launch), in the
 * same transaction and only while the App is not DELETED (X26): the
 * unlaunched-product sweep never removes an App whose launch is recorded.
 */
async function queueStudioDeployment(
  deps: AppsDeps,
  app: AppRow,
  req: DeployRequest,
): Promise<DeploymentRow> {
  const nowIso = deps.now().toISOString();
  const id = deps.newId();
  const envId = app.production_environment_id;
  const superseded = await deps.db.transaction().execute(async (trx) => {
    if (req.trigger === "STUDIO_LAUNCH") {
      const live = await trx
        .updateTable("apps")
        .set({
          launched_at: sql<string>`coalesce(${sql.ref("launched_at")}, ${nowIso})`,
        })
        .where("id", "=", app.id)
        .where("status", "!=", "DELETED")
        .returning("id")
        .executeTakeFirst();
      if (!live) throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
    }
    await trx
      .insertInto("app_deployments")
      .values(deploymentRow(id, app.id, envId, req, "PENDING", nowIso))
      .execute();
    return supersedeOthers(trx, envId, id, nowIso);
  });
  for (const s of superseded) await notifyChanged(deps, s);
  await notifyChanged(deps, id);
  try {
    deps.onDeploymentQueued?.(id);
  } catch (err) {
    deps.logger.warn(
      `[vetra-apps] starting deployment ${id} failed (the watcher retries): ${String(err)}`,
    );
  }
  deps.logger.info(
    `[vetra-apps] ${req.trigger} of ${app.slug}${req.versionNumber !== null ? ` version ${req.versionNumber}` : ""} recorded (${id})`,
  );
  return (await getDeployment(deps.db, id))!;
}

/**
 * The Studio's agent puts version `versionNumber` of its own product live
 * (D20): a PRODUCTION deployment, trigger STUDIO_LAUNCH, actor = the agent's
 * key, on behalf of the owner. Only recorded here (PENDING, returned at
 * once); the deployment watcher applies it. Idempotent on (appId,
 * versionNumber, sha): a retry gets the same deployment while it is pending,
 * under way or READY; after a FAILED one it is tried again.
 */
export async function launchStudioVersion(
  deps: AppsDeps,
  caller: Caller,
  input: LaunchStudioVersionInput,
  secret: string | null,
): Promise<DeploymentRow> {
  const versionNumber = input.versionNumber;
  if (
    !Number.isInteger(versionNumber) ||
    versionNumber < 1 ||
    versionNumber > MAX_VERSION_NUMBER
  ) {
    throw appsError("BAD_USER_INPUT", "versionNumber must be a positive integer");
  }
  if (typeof input.sha !== "string" || !SHA.test(input.sha))
    throw appsError("BAD_USER_INPUT", "sha must be a git commit sha");
  const gitTag = typeof input.gitTag === "string" ? input.gitTag.trim() : "";
  if (!GIT_TAG.test(gitTag))
    throw appsError("BAD_USER_INPUT", "gitTag must be a git tag name");
  if (!Array.isArray(input.packages) || input.packages.length === 0)
    throw appsError("BAD_USER_INPUT", "packages must list the product's packages");
  validatePackages(input.packages);
  for (const p of input.packages) {
    if (!p.name.startsWith(STUDIO_PACKAGE_SCOPE)) {
      throw appsError(
        "BAD_USER_INPUT",
        `Package '${p.name}' is not under ${STUDIO_PACKAGE_SCOPE}`,
      );
    }
  }

  const app = await studioAppFor(deps, caller, input.appId, secret);
  await studioProductionEnv(deps, app);
  const sha = input.sha.toLowerCase();
  const existing = await findStudioLaunch(deps.db, app, versionNumber, sha);
  if (existing) return existing;
  try {
    return await queueStudioDeployment(deps, app, {
      kind: "PRODUCTION",
      prNumber: null,
      gitRef: `refs/tags/${gitTag}`,
      sha,
      runUrl: null,
      actorGithub: null,
      actorDid: caller.appKey,
      packages: input.packages.map((p) => ({ name: p.name, version: p.version })),
      image: null,
      trigger: "STUDIO_LAUNCH",
      onBehalfOf: ownerDid(caller),
      versionNumber,
    });
  } catch (err) {
    // A concurrent retry recorded it first: that one is it.
    if (!isUniqueViolation(err, STUDIO_LAUNCH_KEY_INDEX)) throw err;
    const made = await findStudioLaunch(deps.db, app, versionNumber, sha);
    if (!made) throw err;
    return made;
  }
}

/**
 * The Studio's agent makes a READY production deployment of its own product
 * live again (D20, "Go back"): a new PRODUCTION deployment with the same
 * packages, trigger STUDIO_ROLLBACK. Recorded PENDING; the watcher applies
 * it. Only the env's packages change: no document, version or env is
 * rewritten or deleted.
 */
export async function rollbackStudioVersion(
  deps: AppsDeps,
  caller: Caller,
  deploymentId: string,
  secret: string | null,
): Promise<DeploymentRow> {
  if (!caller.appKey) throw appsError("DELEGATION_MISSING", DELEGATION_MESSAGE);
  const source = await getDeployment(deps.db, deploymentId);
  // An unknown id reads as another App's: the same refusal.
  if (!source) throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
  const app = await studioAppFor(deps, caller, source.app_id, secret);
  if (
    source.kind !== "PRODUCTION" ||
    source.status !== "READY" ||
    source.environment_id !== app.production_environment_id
  ) {
    throw appsError(
      "BAD_USER_INPUT",
      "Only a version that went live can be made live again",
    );
  }
  await studioProductionEnv(deps, app);
  return queueStudioDeployment(deps, app, {
    kind: "PRODUCTION",
    prNumber: null,
    gitRef: source.git_ref,
    sha: source.sha,
    runUrl: null,
    actorGithub: null,
    actorDid: caller.appKey,
    packages: parsePackages(source.packages),
    image: source.image_tag ? splitImage(source.image_tag) : null,
    trigger: "STUDIO_ROLLBACK",
    onBehalfOf: ownerDid(caller),
    versionNumber: source.version_number ?? null,
  });
}

/**
 * A deployment of the agent's own product (X23). An unknown id is refused
 * like another App's (STUDIO_BINDING), so nothing tells them apart.
 */
export async function studioDeploymentFor(
  deps: AppsDeps,
  caller: Caller,
  deploymentId: string,
  secret: string | null,
): Promise<DeploymentRow | null> {
  if (!caller.appKey) throw appsError("DELEGATION_MISSING", DELEGATION_MESSAGE);
  const d = await getDeployment(deps.db, deploymentId);
  if (!d) throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
  await studioAppFor(deps, caller, d.app_id, secret);
  return d;
}

/**
 * The runtime config with `drive` first among Connect's default drives, or
 * null when it is already there. A corrupt stored config is replaced.
 */
export function withDefaultDrive(
  raw: string | null | undefined,
  drive: { url: string; name: string },
): string | null {
  const asObject = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? { ...(v as Record<string, unknown>) }
      : {};
  let config: Record<string, unknown> = {};
  if (raw && raw.trim()) {
    try {
      config = asObject(JSON.parse(raw));
    } catch {
      config = {};
    }
  }
  const connect = asObject(config.connect);
  const drives = asObject(connect.drives);
  const list: unknown[] = Array.isArray(drives.defaultDrives)
    ? drives.defaultDrives
    : [];
  if (list.some((d) => asObject(d).url === drive.url)) return null;
  drives.defaultDrives = [{ url: drive.url, name: drive.name }, ...list];
  connect.drives = drives;
  config.connect = connect;
  return JSON.stringify(config);
}

/**
 * Point the production env's Connect at the product drive: the drive on the
 * env's own Switchboard becomes Connect's first default drive
 * (runtimeConfig connect.drives.defaultDrives → PH_CONNECT_CONFIG_JSON), so
 * <slug>.vetra.io opens the product. Idempotent; approved like a deploy.
 */
async function pointConnectAtDrive(
  deps: AppsDeps,
  app: AppRow,
  driveId: string,
): Promise<void> {
  const envId = app.production_environment_id;
  await withEnvLock(envId, async () => {
    const state = await studioProductionEnv(deps, app);
    const switchboard = envUrls(state).switchboard;
    if (!switchboard)
      throw appsError("BAD_USER_INPUT", "The live app has no Switchboard");
    const config = withDefaultDrive(state.runtimeConfig, {
      url: `${switchboard}/d/${driveId}`,
      name: app.name,
    });
    if (config === null) return;
    const after = await deps.envs.execute(envId, [
      ...(state.status === "STOPPED" ? [wakeEnvironment({})] : []),
      setRuntimeConfig({ config }),
    ]);
    // Approved like a deploy (system action), so the rendered Connect config ships.
    if (after.status === "CHANGES_PENDING" || after.status === "DRAFT")
      await deps.envs.execute(envId, [approveChanges({})]);
    deps.logger.info(
      `[vetra-apps] Connect of ${app.slug} opens drive ${driveId}`,
    );
  });
}

/**
 * The Studio's agent records its product's drive (F7b), once: the same id
 * again is a no-op, another id is refused with PRODUCT_DRIVE_SET. The
 * production env's Connect is pointed at it (also on a repeat, so a call
 * that failed half-way completes).
 */
export async function setStudioProductDrive(
  deps: AppsDeps,
  caller: Caller,
  appId: string,
  driveId: string,
  secret: string | null,
): Promise<AppRow> {
  const id = typeof driveId === "string" ? driveId.trim() : "";
  if (!DRIVE_ID.test(id)) throw appsError("BAD_USER_INPUT", "Invalid drive id");
  const app = await studioAppFor(deps, caller, appId, secret);
  await studioProductionEnv(deps, app);
  const driveSet = () =>
    appsError("PRODUCT_DRIVE_SET", "This product already has its drive");
  if (app.product_drive_id && app.product_drive_id !== id) throw driveSet();
  if (!app.product_drive_id) {
    const set = await deps.db
      .updateTable("apps")
      .set({ product_drive_id: id, updated_at: deps.now().toISOString() })
      .where("id", "=", app.id)
      .where("status", "!=", "DELETED")
      .where("product_drive_id", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!set) {
      const now = await getApp(deps.db, app.id);
      if (!now || now.status === "DELETED")
        throw appsError("STUDIO_BINDING", STUDIO_BINDING_MESSAGE);
      if (now.product_drive_id !== id) throw driveSet();
    } else {
      deps.logger.info(`[vetra-apps] product drive of ${app.slug}: ${id}`);
    }
  }
  await pointConnectAtDrive(deps, app, id);
  return (await getApp(deps.db, app.id))!;
}

/**
 * The packages an env had before a Studio deployment was applied, from the
 * JSON list of `name@version` entries (pre_apply_packages): name → version.
 * A name-only entry (rows recorded before versions were) maps to null: the
 * package is kept, its version left as it is. Null when nothing was recorded.
 */
export function parsePreApplyPackages(
  raw: string | null | undefined,
): Map<string, string | null> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = new Map<string, string | null>();
  for (const entry of parsed) {
    if (typeof entry !== "string" || !entry) continue;
    // The version separator is the last "@" that is not a scope's leading one.
    const at = entry.lastIndexOf("@");
    if (at > 0) out.set(entry.slice(0, at), entry.slice(at + 1) || null);
    else out.set(entry, null);
  }
  return out;
}

/** A recorded deployment back as the request it was made from. */
function requestFromRow(d: DeploymentRow): DeployRequest {
  return {
    kind: d.kind,
    prNumber: d.pr_number,
    gitRef: d.git_ref,
    sha: d.sha,
    runUrl: d.run_url,
    actorGithub: d.actor_github,
    actorDid: d.actor_did,
    packages: parsePackages(d.packages),
    image: d.image_tag ? splitImage(d.image_tag) : null,
    trigger: d.trigger ?? "OWNER",
    onBehalfOf: d.on_behalf_of ?? null,
    versionNumber: d.version_number ?? null,
  };
}

/**
 * Apply a queued Studio deployment (watcher, or right after it was
 * recorded). The row is claimed first (PENDING → DEPLOYING, one statement),
 * so it is applied once whichever replica gets to it. Returns whether this
 * call claimed it. A deployment that fails while being applied puts the
 * previous version back (restoreAfterStudioFailure).
 */
export async function applyQueuedDeployment(
  deps: AppsDeps,
  deploymentId: string,
): Promise<boolean> {
  const claimed = await deps.db
    .updateTable("app_deployments")
    .set({ status: "DEPLOYING", updated_at: deps.now().toISOString() })
    .where("id", "=", deploymentId)
    .where("status", "=", "PENDING")
    .where("trigger", "in", QUEUED_TRIGGERS)
    // A restore is applied as it is recorded (performDeploy), never here.
    .where((eb) =>
      eb.or([
        eb("actor_github", "is", null),
        eb("actor_github", "!=", RESTORE_ACTOR),
      ]),
    )
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return false;
  const app = await getApp(deps.db, claimed.app_id);
  const envId = claimed.environment_id;
  let attempted = false;
  let applied = false;
  try {
    if (!app || app.status !== "ACTIVE")
      throw new Error(`App is ${app?.status ?? "gone"}`);
    if (!envId || envId !== app.production_environment_id)
      throw new Error("the environment is no longer the App's production environment");
    const state = assertProductionEnv(app, await deps.envs.getState(envId));
    // What the env had installed before this deployment touched it: a
    // restore removes only what this deployment added on top of that.
    await deps.db
      .updateTable("app_deployments")
      .set({
        pre_apply_packages: JSON.stringify(
          state.packages.map((p) => `${p.name}@${p.version}`),
        ),
      })
      .where("id", "=", claimed.id)
      .execute();
    attempted = true;
    applied = await applyToEnv(
      deps,
      app,
      claimed.id,
      { envId, state, createActions: [], fusionEnvTemplate: [] },
      requestFromRow(claimed),
    );
  } catch (err) {
    await updateDeployment(
      deps.db,
      claimed.id,
      {
        status: "FAILED",
        error: String(err instanceof Error ? err.message : err).slice(0, 1000),
      },
      deps.now().toISOString(),
    );
  }
  await notifyChanged(deps, claimed.id);
  // Nothing reached the env (App gone, env moved): nothing to put back.
  if (attempted && !applied) {
    const failed = await getDeployment(deps.db, claimed.id);
    if (failed) await restoreAfterStudioFailure(deps, failed);
  }
  return true;
}

type Pkg = { name: string; version: string };

/** What a restore installs and removes (see restoreAfterStudioFailure). */
export function restorePlan(
  previous: Pkg[],
  failed: Pkg[],
  before: Map<string, string | null> | null,
): { packages: Pkg[]; removePackages: string[] } {
  const touched = new Set(failed.map((p) => p.name));
  const packages = new Map<string, string>();
  for (const p of previous) {
    if (!before || !touched.has(p.name)) packages.set(p.name, p.version);
  }
  const removePackages: string[] = [];
  if (before) {
    for (const f of failed) {
      if (!before.has(f.name)) {
        removePackages.push(f.name);
        continue;
      }
      // A name-only record: kept, its version left as it is.
      const version = before.get(f.name);
      if (version) packages.set(f.name, version);
    }
  }
  return {
    packages: [...packages].map(([name, version]) => ({ name, version })),
    removePackages,
  };
}

/**
 * After a Studio launch (or rollback) FAILED once it had been applied: put
 * the env back on the previous READY production deployment's packages,
 * once, so it never stays half-applied. The failed row keeps its reason.
 * The restore is a deployment of its own (trigger STUDIO_ROLLBACK, actor
 * RESTORE_ACTOR) that the watcher follows; it never restores in turn.
 * Packages the failed deployment added are removed again. Nothing happens
 * when a newer deployment of the env exists (it decides what runs), when
 * there is no earlier version (a first launch), or when the env is gone.
 */
export async function restoreAfterStudioFailure(
  deps: AppsDeps,
  failed: DeploymentRow,
): Promise<DeploymentRow | null> {
  if (
    failed.status !== "FAILED" ||
    failed.kind !== "PRODUCTION" ||
    !failed.trigger ||
    !QUEUED_TRIGGERS.includes(failed.trigger) ||
    failed.actor_github === RESTORE_ACTOR ||
    !failed.environment_id
  ) {
    return null;
  }
  const envId = failed.environment_id;
  const newer = await deps.db
    .selectFrom("app_deployments")
    .select("id")
    .where("environment_id", "=", envId)
    .where("id", "!=", failed.id)
    .where("created_at", ">=", failed.created_at)
    .executeTakeFirst();
  if (newer) return null;
  const previous = await deps.db
    .selectFrom("app_deployments")
    .selectAll()
    .where("environment_id", "=", envId)
    .where("kind", "=", "PRODUCTION")
    .where("status", "=", "READY")
    .where("created_at", "<", failed.created_at)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  const app = await getApp(deps.db, failed.app_id);
  if (!previous || !app || app.status !== "ACTIVE") {
    deps.logger.info(
      `[vetra-apps] deployment ${failed.id} failed; no earlier version to put back`,
    );
    return null;
  }
  const state = await deps.envs.getState(envId);
  if (
    envId !== app.production_environment_id ||
    !state ||
    RELEASED_STATUSES.has(state.status) ||
    state.app?.appId !== app.id ||
    state.app.role !== "PRODUCTION"
  ) {
    return null;
  }
  // Back to what the env had right before the failed deployment was applied
  // (pre_apply_packages): a package it changed goes back to its earlier
  // version, one it added is removed, one it did not touch is left alone —
  // never uninstalling or downgrading a package that was live (e.g. one a
  // newer version added and a Go back kept). The previous READY deployment's
  // other packages are re-applied as before. Nothing recorded → the previous
  // READY deployment's packages, nothing removed.
  const { packages, removePackages } = restorePlan(
    parsePackages(previous.packages),
    parsePackages(failed.packages),
    parsePreApplyPackages(failed.pre_apply_packages),
  );
  const restore = await performDeploy(deps, app, state, {
    ...requestFromRow(previous),
    packages,
    runUrl: null,
    actorGithub: RESTORE_ACTOR,
    actorDid: null,
    trigger: "STUDIO_ROLLBACK",
    onBehalfOf: failed.on_behalf_of ?? null,
    removePackages,
  });
  deps.logger.info(
    `[vetra-apps] deployment ${failed.id} of ${app.slug} failed; putting back ${previous.id}${previous.version_number ? ` (version ${previous.version_number})` : ""} as ${restore.id}`,
  );
  return restore;
}

// ---------------------------------------------------------------------------
// CI: artifact registration
// ---------------------------------------------------------------------------

export interface RecordArtifactInput {
  appId: string;
  kind: "PACKAGE" | "FUSION_IMAGE";
  name: string;
  version: string;
  reference: string;
  commitSha?: string | null;
  runId?: string | null;
  /** Channel to point at this version, when the run publishes a channel build. */
  channel?: "DEV" | "STAGING" | "LATEST" | null;
}

const ARTIFACT_KINDS = new Set(["PACKAGE", "FUSION_IMAGE"]);
const ARTIFACT_CHANNELS = new Set(["DEV", "STAGING", "LATEST"]);

/**
 * Records one published artifact on the App's document, and optionally moves a
 * channel pointer to it.
 *
 * Unlike the row mirror, this **fails loudly**. The document is the only place
 * an artifact is recorded, so swallowing the error would drop the artifact
 * silently and the template builder would never offer it.
 */
export async function ciRecordArtifact(
  deps: AppsDeps,
  ci: CiIdentity,
  input: RecordArtifactInput,
) {
  const app = await authorizeCi(deps, ci, input.appId);
  if (!ARTIFACT_KINDS.has(input.kind))
    throw appsError("BAD_USER_INPUT", "kind must be PACKAGE or FUSION_IMAGE");
  for (const [field, value] of Object.entries({
    name: input.name,
    version: input.version,
    reference: input.reference,
  })) {
    if (!value || !value.trim())
      throw appsError("BAD_USER_INPUT", `${field} is required`);
  }
  if (input.channel != null && !ARTIFACT_CHANNELS.has(input.channel))
    throw appsError("BAD_USER_INPUT", "channel must be DEV, STAGING or LATEST");
  if (!deps.docs) throw notConfigured("The App document store");

  const actions: Action[] = [
    recordArtifactVersion({
      kind: input.kind,
      name: input.name.trim(),
      version: input.version.trim(),
      reference: input.reference.trim(),
      commitSha: input.commitSha ?? null,
      runId: input.runId ?? null,
      publishedAt: deps.now().toISOString(),
    }),
  ];
  if (input.channel != null) {
    actions.push(
      setArtifactChannel({
        kind: input.kind,
        name: input.name.trim(),
        channel: input.channel,
        version: input.version.trim(),
      }),
    );
  }

  // Create-on-demand: an App registered before the document backfill ran still
  // has to be able to publish.
  const created = !(await deps.docs.exists(app.id));
  if (created) await deps.docs.create(app.id);
  await deps.docs.execute(app.id, actions);
  if (created) await protectNewAppDocument(deps.docs, app.id, deps.logger);

  deps.logger.info(
    `[vetra-apps] App ${app.slug}: recorded ${input.kind} ${input.name}@${input.version}` +
      (input.channel ? ` and pointed ${input.channel} at it` : ""),
  );
  return { appId: app.id, recorded: true as const };
}
