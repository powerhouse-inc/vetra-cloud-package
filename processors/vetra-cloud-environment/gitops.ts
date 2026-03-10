import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { childLogger } from "document-drive";
import type {
  VetraCloudEnvironmentState,
  VetraCloudEnvironmentService,
} from "../../document-models/vetra-cloud-environment/index.js";

const logger = childLogger(["gitops"]);

interface GitOpsConfig {
  repoPath: string;
  remote: string;
  branch: string;
  githubPat?: string;
}

function getConfig(): GitOpsConfig {
  const repoPath = process.env.GITOPS_REPO_PATH;
  if (!repoPath) {
    throw new Error("GITOPS_REPO_PATH environment variable is required");
  }
  return {
    repoPath,
    remote: process.env.GITOPS_REMOTE ?? "origin",
    branch: process.env.GITOPS_BRANCH ?? "main",
    githubPat: process.env.GITOPS_GITHUB_PAT,
  };
}

function git(args: string[], config: GitOpsConfig): string {
  const fullArgs = ["-C", config.repoPath, ...args];
  logger.info(`Running: git ${fullArgs.join(" ")}`);
  return execFileSync("git", fullArgs, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function generateValuesYaml(
  state: VetraCloudEnvironmentState,
): string {
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

  return `global:
  disabled: ${disabled}
  imagePullSecrets:
    enabled: true
    name: harbor-credentials
    useExisting: true
database:
  cnpg:
    enabled: true
    name: ${name}-pg
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
      destinationPath: s3://powerhouse-cnpg-backups/${name}/
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
      database: ${name.replace(/-/g, "_")}_db
      owner: ${name.replace(/-/g, "_")}_user
switchboard:
  enabled: ${switchboardEnabled}
  name: switchboard
  replicaCount: 1
  image:
    repository: cr.vetra.io/vetra/switchboard
    tag: v0.0.4-staging.3
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3000
  ingress:
    enabled: true
    className: traefik
    host: switchboard.${name}.vetra.io
    tls:
      enabled: true
      secretName: switchboard-${name}-vetra-io-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
  env:
    PORT: "3000"
    NODE_ENV: production
    PH_PACKAGES: "${phPackages}"
  envConfigMap:
    TENANT_ID: ${name}
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
    repository: cr.vetra.io/vetra/connect
    tag: v0.0.4-staging.3
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3001
  ingress:
    enabled: true
    className: traefik
    host: connect.${name}.vetra.io
    tls:
      enabled: true
      secretName: connect-${name}-vetra-io-tls
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
  env:
    PORT: "3001"
    NODE_ENV: production
    PH_PACKAGES: "${phPackages}"
  envConfigMap:
    TENANT_ID: ${name}
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
  enabled: true
  dsn: ""
  environment: ${name}
networkPolicy:
  enabled: false
`;
}

export async function syncEnvironment(
  state: VetraCloudEnvironmentState,
): Promise<void> {
  if (!state.name) {
    logger.warn("Environment has no name, skipping gitops sync");
    return;
  }

  const config = getConfig();
  const name = toKebabCase(state.name);
  const tenantDir = join(config.repoPath, "tenants", name);

  logger.info(
    `Syncing environment "${name}" to gitops repo at ${config.repoPath} ` +
    `(remote=${config.remote}, branch=${config.branch})`,
  );
  logger.info(
    `Environment state: status=${state.status}, ` +
    `services=[${state.services?.join(", ")}], ` +
    `packages=[${state.packages?.map((p) => `${p.name}@${p.version}`).join(", ")}]`,
  );

  // Pull latest
  logger.info("Pulling latest from remote...");
  const pullOutput = git(["pull", config.remote, config.branch, "--rebase"], config);
  if (pullOutput) {
    logger.info(`Pull result: ${pullOutput}`);
  }

  // Create tenant directory if needed
  if (!existsSync(tenantDir)) {
    logger.info(`Creating tenant directory: ${tenantDir}`);
    mkdirSync(tenantDir, { recursive: true });
  }

  // Write values file
  const valuesPath = join(tenantDir, "powerhouse-values.yaml");
  const yaml = generateValuesYaml(state);
  writeFileSync(valuesPath, yaml, "utf-8");
  logger.info(`Wrote values file to ${valuesPath}`);

  // Stage, commit, push
  git(["add", `tenants/${name}/powerhouse-values.yaml`], config);

  const hasChanges = git(["diff", "--cached", "--name-only"], config);
  if (!hasChanges) {
    logger.info("No changes detected in values file, skipping commit");
    return;
  }

  logger.info(`Changes detected: ${hasChanges}`);
  const statusLabel = state.status === "STARTED" ? "enable" : "disable";
  const commitMsg = `chore(${name}): ${statusLabel} tenant — synced from vetra-cloud-environment`;
  logger.info(`Committing: ${commitMsg}`);
  git(["commit", "-m", commitMsg], config);

  logger.info(`Pushing to ${config.remote}/${config.branch}...`);
  git(["push", config.remote, config.branch], config);

  logger.info(`Successfully synced and pushed environment "${name}"`);
}
