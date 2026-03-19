import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { childLogger } from "document-drive";
import type {
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentService,
} from "../../document-models/vetra-cloud-environment/index.js";

const execFileAsync = promisify(execFile);

const logger = childLogger(["gitops"]);

// ---------------------------------------------------------------------------
// Mutex — serializes syncs within a single process to avoid redundant clones
// ---------------------------------------------------------------------------

class GitMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const gitMutex = new GitMutex();
const MAX_PUSH_RETRIES = 3;

const GIT_AUTHOR_NAME = process.env.GITOPS_AUTHOR_NAME ?? "vetra-cloud-processor";
const GIT_AUTHOR_EMAIL = process.env.GITOPS_AUTHOR_EMAIL ?? "noreply@vetra.io";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface GitOpsConfig {
  /** URL of the remote gitops repo (used for ephemeral clones). */
  repoUrl: string;
  remote: string;
  branch: string;
}

function getConfig(): GitOpsConfig {
  const repoUrl = getRepoUrl();
  return {
    repoUrl,
    remote: process.env.GITOPS_REMOTE ?? "origin",
    branch: process.env.GITOPS_BRANCH ?? "main",
  };
}

/**
 * Resolve the remote repo URL.
 *
 * Supports two env-var modes:
 *  1. GITOPS_REPO_URL  — explicit URL (preferred in production)
 *  2. GITOPS_REPO_PATH — local checkout; we read the remote URL from it
 *     (backwards-compatible with existing .env files)
 *
 * When GITOPS_GITHUB_PAT is set, injects the token into https:// URLs so
 * ephemeral clones can authenticate.
 */
function getRepoUrl(): string {
  let url = process.env.GITOPS_REPO_URL;

  if (!url) {
    const repoPath = process.env.GITOPS_REPO_PATH;
    if (!repoPath) {
      throw new Error(
        "Either GITOPS_REPO_URL or GITOPS_REPO_PATH environment variable is required",
      );
    }
    const remote = process.env.GITOPS_REMOTE ?? "origin";
    url = execFileSync("git", ["-C", repoPath, "remote", "get-url", remote], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  }

  // Inject PAT for https URLs
  const pat = process.env.GITOPS_GITHUB_PAT;
  if (pat && url.startsWith("https://")) {
    const parsed = new URL(url);
    parsed.username = pat;
    parsed.password = "x-oauth-basic";
    url = parsed.toString();
  }

  return url;
}

/**
 * Redact credentials from a URL for safe logging.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(args: string[], cwd: string): Promise<string> {
  // Redact repo URLs from logged args to avoid leaking credentials
  const safeArgs = args.map((arg) =>
    arg.startsWith("https://") ? redactUrl(arg) : arg,
  );
  logger.info(`Running: git ${safeArgs.join(" ")}`);

  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Tenant ID & subdomain
// ---------------------------------------------------------------------------

export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/**
 * Build a unique infrastructure tenant ID.
 *
 * Format: `<subdomain>-<shortDocId>`
 *
 * The subdomain alone can collide (250k namespace), so we append the first 8
 * hex chars of the documentId to guarantee uniqueness.
 */
export function getTenantId(
  subdomain: string,
  documentId: string,
): string {
  const shortId = documentId.replace(/-/g, "").slice(0, 8);
  return `${subdomain}-${shortId}`;
}

// ---------------------------------------------------------------------------
// YAML escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe interpolation into a YAML value.
 * Wraps in double quotes and escapes inner backslashes, double quotes,
 * and newlines.
 */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Custom-domain ingress fragment
// ---------------------------------------------------------------------------

function generateCustomDomainIngress(
  service: string,
  customDomain: string,
): string {
  const host = service === "switchboard"
    ? customDomain
    : `${service}.${customDomain}`;
  const secretSuffix = customDomain.replace(/\./g, "-");
  return `
  additionalIngresses:
    - enabled: true
      className: traefik
      host: ${yamlQuote(host)}
      tls:
        enabled: true
        secretName: ${service}-custom-${secretSuffix}-tls
      annotations:
        cert-manager.io/cluster-issuer: letsencrypt-prod`;
}

// ---------------------------------------------------------------------------
// Values YAML generation
// ---------------------------------------------------------------------------

export function generateValuesYaml(
  state: VetraCloudEnvironmentState,
  documentId: string,
): string {
  const subdomain = state.subdomain!;
  const tenantId = getTenantId(subdomain, documentId);
  const name = toKebabCase(state.name ?? "unnamed");
  const switchboardEnabled = state.services.includes(
    "SWITCHBOARD" as VetraCloudEnvironmentService,
  );
  const connectEnabled = state.services.includes(
    "CONNECT" as VetraCloudEnvironmentService,
  );
  const disabled = state.status !== "STARTED";

  const phPackages =
    state.packages
      ?.map((p) => `${p.name}@${p.version ?? "latest"}`)
      .join(",") ?? "";

  const customDomain = state.customDomain ?? null;
  const switchboardCustomIngress = customDomain && switchboardEnabled
    ? generateCustomDomainIngress("switchboard", customDomain)
    : "";
  const connectCustomIngress = customDomain && connectEnabled
    ? generateCustomDomainIngress("connect", customDomain)
    : "";

  const tenantName = yamlQuote(state.name ?? name);
  const dbName = tenantId.replace(/-/g, "_");

  return `global:
  disabled: ${disabled}
  subdomain: ${yamlQuote(subdomain)}
  imagePullSecrets:
    enabled: true
    name: harbor-credentials
    useExisting: true
database:
  cnpg:
    enabled: true
    name: ${tenantId}-pg
    instances: 1
    storageClass: hcloud-volumes
    storageSize: 50Gi
    postgresql:
      maxConnections: "600"
      sharedBuffers: 512MB
      effectiveCacheSize: 2GB
      workMem: 32MB
    pooler:
      enabled: true
      instances: 1
      poolMode: transaction
      defaultPoolSize: 50
      maxClientConnections: 400
    backup:
      enabled: true
      destinationPath: s3://powerhouse-cnpg-backups/${tenantId}/
      endpointURL: https://hel1.your-objectstorage.com
      credentialsSecret: s3-credentials
      retentionPolicy: 180d
      useExistingSecret: true
      scheduledBackup:
        enabled: true
        schedule: 0 2 * * *
        immediate: true
    resources:
      requests:
        memory: 2Gi
        cpu: "2"
      limits:
        memory: 8Gi
        cpu: "8"
    bootstrap:
      database: ${dbName}_db
      owner: ${dbName}_user
switchboard:
  enabled: ${switchboardEnabled}
  name: switchboard
  replicaCount: 1
  image:
    repository: cr.vetra.io/powerhouse-inc-powerhouse/switchboard
    tag: staging
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3000
  ingress:
    enabled: true
    className: traefik
    tls:
      enabled: true
      secretName: switchboard-${subdomain}-vetra-io-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod${switchboardCustomIngress}
  env:
    PORT: "3000"
    NODE_ENV: production
    PH_PACKAGES: ${yamlQuote(phPackages)}
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  resources:
    requests:
      cpu: 1
      memory: 2Gi
    limits:
      cpu: 2
      memory: 4Gi
  livenessProbe:
    enabled: true
    exec:
      command:
        - /bin/sh
        - -c
        - |
          wget --post-data='{"query":"{__typename}"}' --header='Content-Type: application/json' -qO- http://localhost:3000/graphql
    initialDelaySeconds: 120
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  readinessProbe:
    enabled: true
    exec:
      command:
        - /bin/sh
        - -c
        - |
          wget --post-data='{"query":"{__typename}"}' --header='Content-Type: application/json' -qO- http://localhost:3000/graphql
    initialDelaySeconds: 60
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  autoscaling:
    enabled: false
connect:
  enabled: ${connectEnabled}
  name: connect
  replicaCount: 1
  image:
    repository: cr.vetra.io/powerhouse-inc-powerhouse/connect
    tag: staging
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3001
  ingress:
    enabled: true
    className: traefik
    tls:
      enabled: true
      secretName: connect-${subdomain}-vetra-io-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod${connectCustomIngress}
  env:
    PORT: "3001"
    NODE_ENV: production
    PH_PACKAGES: ${yamlQuote(phPackages)}
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  resources:
    requests:
      cpu: 1
      memory: 2Gi
    limits:
      cpu: 2
      memory: 4Gi
  livenessProbe:
    enabled: true
    httpGet:
      path: /health
      port: 3001
    initialDelaySeconds: 120
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  readinessProbe:
    enabled: true
    httpGet:
      path: /health
      port: 3001
    initialDelaySeconds: 60
    periodSeconds: 10
    timeoutSeconds: 5
    failureThreshold: 6
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  autoscaling:
    enabled: false
podDisruptionBudget:
  enabled: true
  minAvailable: 1
serviceMonitor:
  enabled: true
  interval: 30s
  path: /metrics
glitchtip:
  enabled: false
  environment: ${tenantId}
networkPolicy:
  enabled: false
`;
}

// ---------------------------------------------------------------------------
// Sync — ephemeral clone approach
// ---------------------------------------------------------------------------

/**
 * Sync an environment's values to the gitops repo.
 *
 * Each call creates a fresh shallow clone, writes the values file, commits,
 * and pushes. The clone is always cleaned up afterwards. This eliminates all
 * shared working-tree state issues.
 *
 * A mutex serializes syncs within the same process to avoid redundant clones.
 * Cross-process / cross-pod push races are handled by pull-rebase-retry.
 */
export async function syncEnvironment(
  state: VetraCloudEnvironmentState,
  documentId: string,
): Promise<void> {
  if (!state.name) {
    logger.warn("Environment has no name, skipping gitops sync");
    return;
  }
  if (!state.subdomain) {
    logger.warn(
      `Environment "${state.name}" has no subdomain, skipping gitops sync`,
    );
    return;
  }

  await gitMutex.acquire();
  try {
    await syncEnvironmentEphemeral(state, documentId);
  } finally {
    gitMutex.release();
  }
}

/**
 * Remove a tenant's directory from the gitops repo.
 *
 * Called when an environment document is deleted. Removes the tenant
 * directory, commits, and pushes so ArgoCD/Flux tears down the deployment.
 */
export async function deleteEnvironmentFromGitops(
  tenantId: string,
): Promise<void> {
  await gitMutex.acquire();
  try {
    await withEphemeralClone(async (cloneDir, config) => {
      const tenantDir = join(cloneDir, "tenants", tenantId);

      if (!existsSync(tenantDir)) {
        logger.info(`Tenant directory "tenants/${tenantId}" does not exist in gitops repo, nothing to remove`);
        return;
      }

      await git(["rm", "-r", `tenants/${tenantId}`], cloneDir);

      const commitMsg = `chore(${tenantId}): remove tenant — environment deleted`;
      logger.info(`Committing: ${commitMsg}`);
      await git(["commit", "-m", commitMsg], cloneDir);

      await pushWithRetry(cloneDir, config);
      logger.info(`Successfully removed tenant "${tenantId}" from gitops repo`);
    });
  } finally {
    gitMutex.release();
  }
}

async function syncEnvironmentEphemeral(
  state: VetraCloudEnvironmentState,
  documentId: string,
): Promise<void> {
  const subdomain = state.subdomain!;
  const tenantId = getTenantId(subdomain, documentId);

  logger.info(
    `Syncing environment "${tenantId}" (subdomain=${subdomain})`,
  );
  logger.info(
    `Environment state: status=${state.status}, ` +
    `services=[${state.services?.join(", ")}], ` +
    `packages=[${(state.packages?.map((p) => `${p.name}@${p.version}`).join(", ")) ?? ""}], ` +
    `subdomain=${subdomain}, customDomain=${state.customDomain ?? "unset"}`,
  );

  await withEphemeralClone(async (cloneDir, config) => {
    // Create tenant directory
    const tenantDir = join(cloneDir, "tenants", tenantId);
    mkdirSync(tenantDir, { recursive: true });

    // Write values file
    const valuesPath = join(tenantDir, "powerhouse-values.yaml");
    const yaml = generateValuesYaml(state, documentId);
    writeFileSync(valuesPath, yaml, "utf-8");
    logger.info(`Wrote values file to ${valuesPath}`);

    // Stage
    await git(["add", `tenants/${tenantId}/powerhouse-values.yaml`], cloneDir);

    const hasChanges = await git(["diff", "--cached", "--name-only"], cloneDir);
    if (!hasChanges) {
      logger.info("No changes detected in values file, skipping commit");
      return;
    }

    // Commit
    logger.info(`Changes detected: ${hasChanges}`);
    const statusLabel = state.status === "STARTED" ? "enable" : "disable";
    const commitMsg = `chore(${tenantId}): ${statusLabel} tenant — synced from vetra-cloud-environment`;
    logger.info(`Committing: ${commitMsg}`);
    await git(["commit", "-m", commitMsg], cloneDir);

    await pushWithRetry(cloneDir, config);
    logger.info(`Successfully synced and pushed environment "${tenantId}"`);
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function withEphemeralClone(
  fn: (cloneDir: string, config: GitOpsConfig) => Promise<void>,
): Promise<void> {
  const config = getConfig();
  const cloneDir = mkdtempSync(join(tmpdir(), "gitops-"));
  logger.info(`Cloning into ephemeral directory: ${cloneDir}`);

  try {
    await git(
      ["clone", "--depth", "1", "--branch", config.branch, config.repoUrl, "."],
      cloneDir,
    );

    // Set git identity for commits in this ephemeral clone
    await git(["config", "user.name", GIT_AUTHOR_NAME], cloneDir);
    await git(["config", "user.email", GIT_AUTHOR_EMAIL], cloneDir);

    await fn(cloneDir, config);
  } finally {
    logger.info(`Cleaning up ephemeral clone: ${cloneDir}`);
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.warn(`Failed to clean up ${cloneDir}: ${String(cleanupError)}`);
    }
  }
}

async function pushWithRetry(
  cloneDir: string,
  config: GitOpsConfig,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      logger.info(
        `Pushing to ${config.remote}/${config.branch} (attempt ${attempt})...`,
      );
      await git(["push", config.remote, config.branch], cloneDir);
      return;
    } catch (error) {
      if (attempt === MAX_PUSH_RETRIES) {
        throw error;
      }
      logger.warn(
        `Push attempt ${attempt} failed, pulling with rebase and retrying: ${String(error)}`,
      );
      await git(["fetch", config.remote, config.branch], cloneDir);
      try {
        await git(
          ["rebase", `${config.remote}/${config.branch}`],
          cloneDir,
        );
      } catch (rebaseError) {
        logger.warn(`Rebase failed with conflict, aborting: ${String(rebaseError)}`);
        await git(["rebase", "--abort"], cloneDir);
        throw rebaseError;
      }
    }
  }
}
