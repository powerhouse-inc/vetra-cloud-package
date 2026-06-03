import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { childLogger } from "document-model";
import type { Kysely } from "kysely";
import type {
  VetraCloudEnvironmentService,
  VetraCloudEnvironmentState,
  VetraCloudRessourceSize,
} from "../../document-models/vetra-cloud-environment/index.js";
import type { DB } from "./schema.js";

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
  const host = `${service}.${customDomain}`;
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

/**
 * Narrow `state.apexService` to the service types the processor actually
 * renders apex routing for. Returns null when no apex is requested or when
 * the pinned type is one we don't emit (e.g. FUSION — no chart ingress).
 */
function readApexService(
  state: VetraCloudEnvironmentState,
): "CONNECT" | "SWITCHBOARD" | "FUSION" | null {
  const v = state.apexService;
  if (v === "CONNECT" || v === "SWITCHBOARD" || v === "FUSION") return v;
  return null;
}

/**
 * Per-service TLS secret name. When a service is routed at the apex of a
 * custom domain, the cert covers that host; otherwise it covers the
 * generic `<service>.<subdomain>.vetra.io` host.
 */
function tlsSecretName(
  service: "switchboard" | "connect",
  subdomain: string,
  apexDomain: string | null,
): string {
  if (apexDomain) {
    return `${service}-${apexDomain.replace(/\./g, "-")}-tls`;
  }
  return `${service}-${subdomain}-vetra-io-tls`;
}

// ---------------------------------------------------------------------------
// CLINT services — image, resource mapping, announce-token provisioning
// ---------------------------------------------------------------------------

const CLINT_RUNTIME_IMAGE =
  process.env.CLINT_RUNTIME_IMAGE_REPOSITORY ??
  "cr.vetra.io/powerhouse-inc-powerhouse/clint-runtime";

// Prebuilt per-agent images: the in-cluster clint-image-builder bakes each
// published agent into its own image at <base>/clint-agent/<sanitized-pkg>:<version>
// on publish, so pods start with pull + exec (no runtime `pnpm add`). The base
// is the Harbor project that also hosts clint-runtime.
const CLINT_AGENT_IMAGE_BASE =
  process.env.CLINT_AGENT_IMAGE_BASE ??
  CLINT_RUNTIME_IMAGE.replace(/\/[^/]+$/, "");

/** Container repo paths can't hold "@" and a scoped "/" would add an unintended
 *  path segment: strip a leading "@" and replace "/" with "-". Mirrors the
 *  sanitization in clint-image-builder's image-ref.ts. */
function sanitizeAgentPackageName(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

function clintAgentImageRepository(pkgName: string): string {
  return `${CLINT_AGENT_IMAGE_BASE}/clint-agent/${sanitizeAgentPackageName(pkgName)}`;
}

/**
 * Resolve a package "version" that may be a dist-tag (latest/dev/staging) or
 * null into a concrete published version. The clint-image-builder only pushes
 * a prebuilt image per CONCRETE version, so the emitted image tag must be the
 * concrete version — otherwise a `latest`-pinned agent would reference a
 * `clint-agent/<pkg>:latest` tag that is never built (ImagePullBackOff).
 * Concrete versions pass through unchanged; falls back to the input (or
 * "latest") if the registry is unreachable.
 */
async function resolveConcreteVersion(
  registry: string,
  pkgName: string,
  version: string | null | undefined,
): Promise<string> {
  const requested = version ?? "latest";
  try {
    const base = registry.replace(/\/$/, "");
    const res = await fetch(`${base}/${pkgName}`);
    if (res.ok) {
      const body = (await res.json()) as {
        "dist-tags"?: Record<string, string>;
      };
      const concrete = (body["dist-tags"] ?? {})[requested];
      if (concrete) return concrete;
    }
  } catch (e) {
    logger.warn(
      `clint version resolution failed for ${pkgName}@${requested}: ${String(e)}`,
    );
  }
  return requested;
}

type ResourceSpec = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
  /**
   * V8 max old-space size in MB, used to derive `NODE_OPTIONS`. Without this
   * Node caps the heap at ~1.7Gi regardless of the cgroup limit, so a 4Gi pod
   * still OOMs the JS process. Sized to ~75% of the cgroup limit, leaving
   * room for stack, V8 metaspace, code, and native bindings.
   */
  nodeMaxOldSpaceMb: number;
};

/**
 * App-services map (Switchboard/Connect/Fusion). Calibrated so S equals
 * today's powerhouse-chart default — preventing regression on next sync for
 * any environment that hasn't yet picked a size.
 */
const APP_RESOURCE_MAP: Record<VetraCloudRessourceSize, ResourceSpec> = {
  VETRA_AGENT_S: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "1Gi" },
    nodeMaxOldSpaceMb: 768,
  },
  VETRA_AGENT_M: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "2Gi" },
    nodeMaxOldSpaceMb: 1536,
  },
  VETRA_AGENT_L: {
    requests: { cpu: "1", memory: "2Gi" },
    limits: { cpu: "4", memory: "4Gi" },
    nodeMaxOldSpaceMb: 3072,
  },
  VETRA_AGENT_XL: {
    requests: { cpu: "2", memory: "4Gi" },
    limits: { cpu: "6", memory: "8Gi" },
    nodeMaxOldSpaceMb: 6144,
  },
  VETRA_AGENT_XXL: {
    requests: { cpu: "4", memory: "8Gi" },
    limits: { cpu: "8", memory: "16Gi" },
    nodeMaxOldSpaceMb: 12288,
  },
};

/** CLINT agents — small-footprint runtime. nodeMaxOldSpaceMb is unused for
 *  CLINT (the runtime image isn't necessarily Node) but kept for type
 *  symmetry with APP_RESOURCE_MAP. */
const CLINT_RESOURCE_MAP: Record<VetraCloudRessourceSize, ResourceSpec> = {
  VETRA_AGENT_S: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
    nodeMaxOldSpaceMb: 384,
  },
  VETRA_AGENT_M: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "1Gi" },
    nodeMaxOldSpaceMb: 768,
  },
  VETRA_AGENT_L: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "2Gi" },
    nodeMaxOldSpaceMb: 1536,
  },
  VETRA_AGENT_XL: {
    requests: { cpu: "1", memory: "2Gi" },
    limits: { cpu: "4", memory: "4Gi" },
    nodeMaxOldSpaceMb: 3072,
  },
  VETRA_AGENT_XXL: {
    requests: { cpu: "2", memory: "4Gi" },
    limits: { cpu: "8", memory: "8Gi" },
    nodeMaxOldSpaceMb: 6144,
  },
};

/**
 * Resolve the effective t-shirt size for a service. Reads the top-level
 * `selectedRessource` first, falls back to the legacy CLINT
 * `config.selectedRessource` (one-release transition), then to S.
 */
function readServiceSize(
  svc: VetraCloudEnvironmentService | undefined,
): VetraCloudRessourceSize {
  if (!svc) return "VETRA_AGENT_S";
  return (
    svc.selectedRessource ??
    svc.config?.selectedRessource ??
    "VETRA_AGENT_S"
  );
}

async function generateClintBlock(
  state: VetraCloudEnvironmentState,
  documentId: string,
  subdomain: string,
  baseDomain: string,
): Promise<string> {
  const clintServices = (state.services ?? []).filter(
    (s) => s.type === "CLINT" && s.enabled,
  );
  if (clintServices.length === 0) {
    return `clint:\n  enabled: false\n  agents: []`;
  }

  const lines: string[] = [`clint:`, `  enabled: true`, `  agents:`];
  for (const svc of clintServices) {
    const cfg = svc.config;
    const pkg = cfg?.package;
    if (!pkg) {
      logger.warn(
        `CLINT service "${svc.prefix}" has no config.package — skipping in YAML emit`,
      );
      continue;
    }
    const size = readServiceSize(svc);
    const resources = CLINT_RESOURCE_MAP[size];
    const command = cfg?.serviceCommand ?? pkg.name;
    const envVars = cfg?.env ?? [];

    const registry =
      pkg.registry ||
      state.defaultPackageRegistry ||
      "https://registry.dev.vetra.io/";
    // Resolve dist-tags (latest/dev) to a concrete version so the image tag
    // matches a prebuilt clint-agent tag.
    const agentVersion = await resolveConcreteVersion(
      registry,
      pkg.name,
      pkg.version,
    );
    lines.push(`    - name: ${yamlQuote(svc.prefix)}`);
    lines.push(`      image:`);
    // Prebuilt per-agent image (built on publish by clint-image-builder),
    // tagged with the concrete package version — the package is baked in, so
    // the pod does pull + exec, no runtime install.
    lines.push(`        repository: ${yamlQuote(clintAgentImageRepository(pkg.name))}`);
    lines.push(`        tag: ${yamlQuote(agentVersion)}`);
    // Per-version tags are immutable, so IfNotPresent lets the kubelet reuse
    // cached layers. If the image isn't pushed yet the pod waits in
    // ImagePullBackOff until the builder finishes — intended "wait" behavior.
    lines.push(`        pullPolicy: IfNotPresent`);
    lines.push(`      package: ${yamlQuote(pkg.name)}`);
    lines.push(`      version: ${yamlQuote(agentVersion)}`);
    lines.push(`      registry: ${yamlQuote(registry)}`);
    lines.push(`      command: ${yamlQuote(command)}`);
    lines.push(`      resources:`);
    lines.push(
      `        requests: { cpu: ${yamlQuote(resources.requests.cpu)}, memory: ${yamlQuote(resources.requests.memory)} }`,
    );
    lines.push(
      `        limits: { cpu: ${yamlQuote(resources.limits.cpu)}, memory: ${yamlQuote(resources.limits.memory)} }`,
    );
    // Always emit NODE_OPTIONS so V8's heap cap matches the cgroup limit.
    // The clint-runtime image is Node-based and runs `pnpm install` at boot;
    // without this, V8 caps the heap at its default (~75% of detected memory)
    // which on small sizes is well under what large agent installs need.
    // User-provided envVars come last so they can override if desired.
    lines.push(`      env:`);
    lines.push(
      `        - { name: "NODE_OPTIONS", value: "--max-old-space-size=${resources.nodeMaxOldSpaceMb}" }`,
    );
    for (const e of envVars) {
      lines.push(
        `        - { name: ${yamlQuote(e.name)}, value: ${yamlQuote(e.value)} }`,
      );
    }
    // Public HTTPS ingress — required so the observability subgraph's pull
    // worker can reach the agent's `/_proxy/routes` endpoint. cert-manager
    // provisions TLS via the Let's Encrypt cluster issuer.
    lines.push(`      ingress:`);
    lines.push(`        enabled: true`);
    lines.push(`        host: ${yamlQuote(`${svc.prefix}.${subdomain}.${baseDomain}`)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Values YAML generation
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE_TAG = "v6.0.0-dev.152";

export async function generateValuesYaml(
  db: Kysely<DB>,
  state: VetraCloudEnvironmentState,
  documentId: string,
): Promise<string> {
  const subdomain = state.genericSubdomain!;
  const tenantId = getTenantId(subdomain, documentId);
  const name = toKebabCase(state.label ?? "unnamed");
  const switchboardEnabled = state.services.some(
    (s) => s.type === "SWITCHBOARD" && s.enabled,
  );
  const connectEnabled = state.services.some(
    (s) => s.type === "CONNECT" && s.enabled,
  );
  const clintEnabled = state.services.some(
    (s) => s.type === "CLINT" && s.enabled,
  );
  // Activate the tenantSecretsController flag whenever switchboard or
  // clint are enabled. Switchboard hosts the GraphQL writes (and needs
  // the per-tenant Vault encrypt policy + KubernetesAuthEngineRole the
  // chart creates under this flag); clint agents consume the
  // <tenant>-env / <tenant>-secrets via envFrom (rendered
  // unconditionally with `optional: true`, but the flag also drives
  // the Reloader-friendly flow). Connect-only envs without either get
  // skipped — no reconcile target to wire up.
  const tenantSecretsControllerEnabled = switchboardEnabled || clintEnabled;
  const switchboardService = state.services.find(
    (s) => s.type === "SWITCHBOARD",
  );
  const connectService = state.services.find(
    (s) => s.type === "CONNECT",
  );
  const switchboardTag = switchboardService?.version ?? DEFAULT_IMAGE_TAG;
  const connectTag = connectService?.version ?? DEFAULT_IMAGE_TAG;
  const switchboardResources =
    APP_RESOURCE_MAP[readServiceSize(switchboardService)];
  const connectResources = APP_RESOURCE_MAP[readServiceSize(connectService)];
  const DISABLED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);
  const disabled = DISABLED_STATUSES.has(state.status);
  // Postgres is only needed when Switchboard is enabled — Connect-only envs
  // (e.g. admin-style apex deployments) can skip the ~60-90s CNPG bootstrap
  // and the associated 50Gi Hetzner volume. Toggling Switchboard on later
  // flips this back to true and CNPG comes up then.
  const databaseEnabled = switchboardEnabled;

  const phPackages =
    state.packages
      ?.map((p) => `${p.name}@${p.version ?? "latest"}`)
      .join(",") ?? "";

  const customDomain = state.customDomain?.enabled ? state.customDomain.domain ?? null : null;
  const apexService = readApexService(state);
  // When a service claims the apex, its primary ingress uses the custom
  // domain directly (no prefix) and the additionalIngresses block is
  // skipped for that service — the apex is the only custom host.
  const switchboardApexDomain =
    customDomain && apexService === "SWITCHBOARD" && switchboardEnabled
      ? customDomain
      : null;
  const connectApexDomain =
    customDomain && apexService === "CONNECT" && connectEnabled
      ? customDomain
      : null;
  const switchboardCustomIngress =
    customDomain && switchboardEnabled && !switchboardApexDomain
      ? generateCustomDomainIngress("switchboard", customDomain)
      : "";
  const connectCustomIngress =
    customDomain && connectEnabled && !connectApexDomain
      ? generateCustomDomainIngress("connect", customDomain)
      : "";
  const switchboardHostLine = switchboardApexDomain
    ? `\n    host: ${yamlQuote(switchboardApexDomain)}`
    : "";
  const connectHostLine = connectApexDomain
    ? `\n    host: ${yamlQuote(connectApexDomain)}`
    : "";
  const switchboardTlsSecret = tlsSecretName(
    "switchboard",
    subdomain,
    switchboardApexDomain,
  );
  const connectTlsSecret = tlsSecretName(
    "connect",
    subdomain,
    connectApexDomain,
  );

  const tenantName = yamlQuote(state.label ?? name);
  const dbName = tenantId.replace(/-/g, "_");

  // CLINT services: emit the dedicated `clint:` block. Frank's chart
  // consumes it to render the agent Deployments/Services/Ingresses.
  // Endpoint discovery is now pull-based (see clint-pull-worker); the
  // chart no longer receives announce env vars.
  const clintBlock = await generateClintBlock(
    state,
    documentId,
    subdomain,
    state.genericBaseDomain ?? "vetra.io",
  );

  // Connect runtime config — the operator-editable powerhouse.config.json
  // partial (connect.* block + top-level packageRegistryUrl), stored verbatim
  // on state.runtimeConfig. Rendered as a single PH_CONNECT_CONFIG_JSON env var
  // on the connect pod; the connect entrypoint deep-merges it (set-if-absent)
  // into /dist/powerhouse.config.json. The stored object is already the
  // full-file shape, so it is emitted as-is (no wrapping). Null / empty object
  // → omit (fall back to bundled defaults).
  const runtimeConfig = state.runtimeConfig;
  const hasRuntimeConfig =
    runtimeConfig != null &&
    typeof runtimeConfig === "object" &&
    !Array.isArray(runtimeConfig) &&
    Object.keys(runtimeConfig as Record<string, unknown>).length > 0;
  const connectConfigEnvLine = hasRuntimeConfig
    ? `\n    PH_CONNECT_CONFIG_JSON: ${yamlQuote(JSON.stringify(runtimeConfig))}`
    : "";

  // Optional preamble — only emitted when there's an active service
  // that needs the controller's wiring. Tenants without switchboard
  // and without clint stay quiet (their values.yaml omits the block,
  // chart default keeps the feature off).
  const tenantSecretsControllerBlock = tenantSecretsControllerEnabled
    ? `# Route tenant env vars & secrets through the standalone vetra-secrets-controller
# (Postgres-backed; transit-encrypted secrets; auto rolling restart via Reloader).
tenantSecretsController:
  enabled: true

`
    : "";

  return `${tenantSecretsControllerBlock}global:
  disabled: ${disabled}
  subdomain: ${yamlQuote(subdomain)}
  imagePullSecrets:
    enabled: true
    name: harbor-credentials
    useExisting: true
database:
  cnpg:
    enabled: ${databaseEnabled}
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
  gitops:
    enabled: false
  name: switchboard
  replicaCount: 1
  image:
    repository: cr.vetra.io/powerhouse-inc-powerhouse/switchboard
    tag: ${switchboardTag}
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3000
  ingress:
    enabled: true
    className: traefik${switchboardHostLine}
    tls:
      enabled: true
      secretName: ${switchboardTlsSecret}
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod${switchboardCustomIngress}
  env:
    PORT: "3000"
    NODE_ENV: production
    NODE_OPTIONS: ${yamlQuote(`--max-old-space-size=${switchboardResources.nodeMaxOldSpaceMb}`)}
    PH_REGISTRY_URL: ${yamlQuote(state.defaultPackageRegistry || "https://registry.dev.vetra.io")}
    PH_REGISTRY_PACKAGES: ${yamlQuote(phPackages)}
    OPENBAO_ADDR: https://openbao.vetra.io
    PROMETHEUS_URL: http://prometheus-server.monitoring.svc
    LOKI_URL: http://loki.monitoring.svc:3100
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  envFrom:
    - configMapRef:
        name: ${tenantId}-env
        optional: true
    - secretRef:
        name: ${tenantId}-secrets
        optional: true
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
    initialDelaySeconds: 15
    periodSeconds: 5
    timeoutSeconds: 5
    failureThreshold: 12
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  resources:
    requests:
      cpu: ${yamlQuote(switchboardResources.requests.cpu)}
      memory: ${yamlQuote(switchboardResources.requests.memory)}
    limits:
      cpu: ${yamlQuote(switchboardResources.limits.cpu)}
      memory: ${yamlQuote(switchboardResources.limits.memory)}
  autoscaling:
    enabled: false
connect:
  enabled: ${connectEnabled}
  name: connect
  replicaCount: 1
  image:
    repository: cr.vetra.io/powerhouse-inc-powerhouse/connect
    tag: ${connectTag}
    pullPolicy: IfNotPresent
  service:
    type: ClusterIP
    port: 80
    targetPort: 3001
  ingress:
    enabled: true
    className: traefik${connectHostLine}
    tls:
      enabled: true
      secretName: ${connectTlsSecret}
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod${connectCustomIngress}
  env:
    PORT: "3001"
    NODE_ENV: production
    NODE_OPTIONS: ${yamlQuote(`--max-old-space-size=${connectResources.nodeMaxOldSpaceMb}`)}
    PH_REGISTRY_URL: ${yamlQuote(state.defaultPackageRegistry || "https://registry.dev.vetra.io")}
    PH_REGISTRY_PACKAGES: ${yamlQuote(phPackages)}${connectConfigEnvLine}
  envConfigMap:
    TENANT_ID: ${tenantId}
    TENANT_NAME: ${tenantName}
  envFrom:
    - configMapRef:
        name: ${tenantId}-env
        optional: true
    - secretRef:
        name: ${tenantId}-secrets
        optional: true
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
    initialDelaySeconds: 15
    periodSeconds: 5
    timeoutSeconds: 5
    failureThreshold: 12
  securityContext:
    runAsNonRoot: false
    runAsUser: 0
    fsGroup: 0
  resources:
    requests:
      cpu: ${yamlQuote(connectResources.requests.cpu)}
      memory: ${yamlQuote(connectResources.requests.memory)}
    limits:
      cpu: ${yamlQuote(connectResources.limits.cpu)}
      memory: ${yamlQuote(connectResources.limits.memory)}
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
sentry:
  enabled: true
  environment: ${tenantId}
networkPolicy:
  enabled: false
${clintBlock}
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
  db: Kysely<DB>,
  state: VetraCloudEnvironmentState,
  documentId: string,
): Promise<void> {
  if (!state.label) {
    logger.warn("Environment has no label, skipping gitops sync");
    return;
  }
  if (!state.genericSubdomain) {
    logger.warn(
      `Environment "${state.label}" has no subdomain, skipping gitops sync`,
    );
    return;
  }

  await gitMutex.acquire();
  try {
    await syncEnvironmentEphemeral(db, state, documentId);
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
  db: Kysely<DB>,
  state: VetraCloudEnvironmentState,
  documentId: string,
): Promise<void> {
  const subdomain = state.genericSubdomain!;
  const tenantId = getTenantId(subdomain, documentId);

  logger.info(
    `Syncing environment "${tenantId}" (subdomain=${subdomain})`,
  );
  logger.info(
    `Environment state: status=${state.status}, ` +
    `services=[${state.services?.map((s) => `${s.type}:${s.enabled}`).join(", ")}], ` +
    `packages=[${(state.packages?.map((p) => `${p.name}@${p.version}`).join(", ")) ?? ""}], ` +
    `subdomain=${subdomain}, customDomain=${state.customDomain?.domain ?? "unset"}`,
  );

  await withEphemeralClone(async (cloneDir, config) => {
    // Create tenant directory
    const tenantDir = join(cloneDir, "tenants", tenantId);
    mkdirSync(tenantDir, { recursive: true });

    // Write values file
    const valuesPath = join(tenantDir, "powerhouse-values.yaml");
    const yaml = await generateValuesYaml(db, state, documentId);
    writeFileSync(valuesPath, yaml, "utf-8");
    logger.info(`Wrote values file to ${valuesPath}`);

    // Stage
    await git(["add", `tenants/${tenantId}/powerhouse-values.yaml`], cloneDir);

    const hasChanges = await git(["diff", "--cached", "--name-only"], cloneDir);
    if (!hasChanges) {
      logger.info("No changes detected in values file, skipping commit");
      return;
    }

    // Commit. Label the action by the effect on the chart's `global.disabled`
    // flag — envs in terminal-ish statuses render disabled=true, everything
    // else is a live update (initial provision, approval, service toggle,
    // version bump, custom-domain change, etc.).
    logger.info(`Changes detected: ${hasChanges}`);
    const DISABLED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);
    const statusLabel = DISABLED_STATUSES.has(state.status) ? "disable" : "update";
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
