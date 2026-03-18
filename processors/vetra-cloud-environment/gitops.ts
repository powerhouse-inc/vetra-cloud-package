import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { childLogger } from "document-drive";
import type {
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentService,
} from "../../document-models/vetra-cloud-environment/index.js";

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

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  logger.info(`Running: git ${args.join(" ")}`);
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  }).trim();
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
// Custom-domain ingress fragment
// ---------------------------------------------------------------------------

function generateCustomDomainIngress(
  service: string,
  customDomain: string,
): string {
  return `
  additionalIngresses:
    - enabled: true
      className: traefik
      host: ${service === "switchboard" ? "" : `${service}.`}${customDomain}
      tls:
        enabled: true
        secretName: ${service}-custom-${customDomain.replace(/\./g, "-")}-tls
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

  return `global:
  disabled: ${disabled}
  subdomain: ${subdomain}
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
      database: ${tenantId.replace(/-/g, "_")}_db
      owner: ${tenantId.replace(/-/g, "_")}_user
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
    PH_PACKAGES: "${phPackages}"
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: "${state.name ?? name}"
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
    PH_PACKAGES: "${phPackages}"
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: "${state.name ?? name}"
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

async function syncEnvironmentEphemeral(
  state: VetraCloudEnvironmentState,
  documentId: string,
): Promise<void> {
  const config = getConfig();
  const subdomain = state.subdomain!;
  const tenantId = getTenantId(subdomain, documentId);

  logger.info(
    `Syncing environment "${tenantId}" (subdomain=${subdomain}) ` +
    `to gitops repo (branch=${config.branch})`,
  );
  logger.info(
    `Environment state: status=${state.status}, ` +
    `services=[${state.services?.join(", ")}], ` +
    `packages=[${(state.packages?.map((p) => `${p.name}@${p.version}`).join(", ")) ?? ""}], ` +
    `subdomain=${subdomain}, customDomain=${state.customDomain ?? "unset"}`,
  );

  // Create ephemeral shallow clone
  const cloneDir = mkdtempSync(join(tmpdir(), "gitops-"));
  logger.info(`Cloning into ephemeral directory: ${cloneDir}`);

  try {
    git(
      ["clone", "--depth", "1", "--branch", config.branch, config.repoUrl, "."],
      cloneDir,
    );

    // Create tenant directory
    const tenantDir = join(cloneDir, "tenants", tenantId);
    mkdirSync(tenantDir, { recursive: true });

    // Write values file
    const valuesPath = join(tenantDir, "powerhouse-values.yaml");
    const yaml = generateValuesYaml(state, documentId);
    writeFileSync(valuesPath, yaml, "utf-8");
    logger.info(`Wrote values file to ${valuesPath}`);

    // Stage
    git(["add", `tenants/${tenantId}/powerhouse-values.yaml`], cloneDir);

    const hasChanges = git(["diff", "--cached", "--name-only"], cloneDir);
    if (!hasChanges) {
      logger.info("No changes detected in values file, skipping commit");
      return;
    }

    // Commit
    logger.info(`Changes detected: ${hasChanges}`);
    const statusLabel = state.status === "STARTED" ? "enable" : "disable";
    const commitMsg = `chore(${tenantId}): ${statusLabel} tenant — synced from vetra-cloud-environment`;
    logger.info(`Committing: ${commitMsg}`);
    git(["commit", "-m", commitMsg], cloneDir);

    // Push with retry — handles cross-instance races
    for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
      try {
        logger.info(
          `Pushing to ${config.remote}/${config.branch} (attempt ${attempt})...`,
        );
        git(["push", config.remote, config.branch], cloneDir);
        logger.info(`Successfully synced and pushed environment "${tenantId}"`);
        return;
      } catch (error) {
        if (attempt === MAX_PUSH_RETRIES) {
          throw error;
        }
        logger.warn(
          `Push attempt ${attempt} failed, pulling with rebase and retrying: ${String(error)}`,
        );
        // Unshallow enough to rebase on top of the new remote tip
        git(["fetch", config.remote, config.branch], cloneDir);
        git(
          ["rebase", `${config.remote}/${config.branch}`],
          cloneDir,
        );
      }
    }
  } finally {
    // Always clean up the ephemeral clone
    logger.info(`Cleaning up ephemeral clone: ${cloneDir}`);
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.warn(`Failed to clean up ${cloneDir}: ${String(cleanupError)}`);
    }
  }
}
