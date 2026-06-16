import { execFile, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
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
import type { SecretsService } from "../../subgraphs/vetra-cloud-secrets/services/secrets-service.js";

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

/**
 * Auth env entries for a switchboard, derived from the env owner. Auth is
 * always on; the owner (lowercased) is the sole admin. Null/empty owner →
 * auth on with no admin until the first claim (next deploy adds ADMINS).
 */
function switchboardAuthEnv(
  owner: string | null | undefined,
): { name: string; value: string }[] {
  const entries = [{ name: "AUTH_ENABLED", value: "true" }];
  if (owner) entries.push({ name: "ADMINS", value: owner.toLowerCase() });
  return entries;
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
    limits: { cpu: "4", memory: "8Gi" },
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

/**
 * Heuristic for classifying legacy env entries (those without an
 * explicit isSecret flag — pre-isSecret schema or pre-UI-update data).
 * Matches names commonly used for sensitive values; conservative on
 * purpose, only the well-known suffixes. Anything not matching is
 * treated as a plain env var. Explicit isSecret on the entry always
 * wins over this heuristic.
 */
const LEGACY_SECRET_NAME_PATTERN = /(_API_KEY|_SECRET|_PASSWORD|_TOKEN|_PRIVATE_KEY)$/;

function classifyEnv(e: { name: string; value?: string | null; isSecret?: boolean | null }): "secret" | "plain" {
  if (e.isSecret === true) return "secret";
  if (e.isSecret === false) return "plain";
  // No explicit flag: fall back to name pattern. Used for legacy data
  // produced before the isSecret schema field shipped.
  return LEGACY_SECRET_NAME_PATTERN.test(e.name) ? "secret" : "plain";
}

async function generateClintBlock(
  state: VetraCloudEnvironmentState,
  documentId: string,
  subdomain: string,
  baseDomain: string,
  tenantId: string,
  secretsService: SecretsService | null,
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
    lines.push(`      env:`);
    lines.push(
      `        - { name: "NODE_OPTIONS", value: "--max-old-space-size=${resources.nodeMaxOldSpaceMb}" }`,
    );
    // Always-on Renown auth for the embedded switchboard; env owner is admin.
    // Emitted inline (not via the secrets service) so they stay deterministic.
    for (const e of switchboardAuthEnv(state.owner)) {
      lines.push(
        `        - { name: ${yamlQuote(e.name)}, value: ${yamlQuote(e.value)} }`,
      );
    }
    // Route each declared env entry. Anything classified as a secret goes
    // through the encrypted tenant_secrets table (via the secrets service);
    // it is OMITTED from this inline block — the chart's `envFrom: secretRef:
    // <tenant>-secrets` picks it up after the secrets-controller materializes
    // the Secret. Plain env vars are written to tenant_env_vars (which becomes
    // the <tenant>-env ConfigMap) when the service is available; otherwise
    // they're emitted inline (legacy fallback for environments where
    // OPENBAO_ADDR isn't configured).
    //
    // Secret VALUES never re-enter inline values.yaml even if the document
    // state still carries one (legacy data with isSecret heuristic-matched
    // names). This is the load-bearing line for "secrets must not leak to
    // git": classifyEnv() + the conditional below.
    for (const e of envVars) {
      const kind = classifyEnv(e);
      const value = e.value ?? "";
      if (kind === "secret") {
        if (secretsService && value !== "") {
          try {
            await secretsService.setSecret(tenantId, e.name, value);
          } catch (err) {
            logger.warn(
              `Failed to upsert secret ${e.name} for tenant ${tenantId}: ${String(err)} — skipping inline emit to avoid plaintext leak`,
            );
          }
        } else if (!secretsService) {
          logger.warn(
            `[secrets] No SecretsService available — secret entry ${e.name} for tenant ${tenantId} cannot be routed; SKIPPING (will not be available to the agent until OPENBAO_ADDR is configured)`,
          );
        }
        // Either way: do NOT emit inline. Defense in depth against the
        // plaintext leak the user explicitly flagged.
        continue;
      }
      // Plain env var. Prefer the secrets-controller path (tenant_env_vars)
      // when available so the values.yaml stays lean; otherwise emit inline.
      if (secretsService) {
        try {
          await secretsService.setEnvVar(tenantId, e.name, value);
          continue;
        } catch (err) {
          logger.warn(
            `Failed to upsert env var ${e.name} for tenant ${tenantId}: ${String(err)} — falling back to inline emit`,
          );
        }
      }
      lines.push(
        `        - { name: ${yamlQuote(e.name)}, value: ${yamlQuote(value)} }`,
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
  secretsService: SecretsService | null = null,
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
    tenantId,
    secretsService,
  );

  // Connect runtime config + installed packages — composed into the single
  // PH_CONNECT_CONFIG_JSON env var; the connect entrypoint deep-merges it
  // (operator-wins) into /dist/powerhouse.config.json.
  //
  // - `state.runtimeConfig` (JSON string — String scalar so it composes in
  //   the federated supergraph) carries the operator-edited connect.* block
  //   and optional packageRegistryUrl.
  // - `state.packages` (the first-class ADD_PACKAGE list) is the source of
  //   truth for the top-level `packages` array — the SPA loads these from
  //   the registry at boot. It wins over any `packages` key a stored
  //   runtimeConfig might carry. When packages are emitted and the operator
  //   didn't set a packageRegistryUrl, the env's default registry is
  //   included so the SPA fetches them from the right place.
  //
  // Legacy PH_REGISTRY_PACKAGES / PH_REGISTRY_URL stay emitted alongside:
  // Switchboard still consumes them, as do Connect images < 6.1.0-dev.16.
  // Connect images 6.1.0-dev.16 .. 6.2.0-dev.9 read neither channel for
  // packages (their set-if-absent entrypoint keeps the baked `packages: []`);
  // the array lands on images >= 6.2.0-dev.10 (operator-wins entrypoint).
  //
  // Nothing to emit (no overrides, no packages) or corrupt stored JSON →
  // omit (fall back to bundled defaults).
  const runtimeConfig = state.runtimeConfig;
  let connectConfigPayload: Record<string, unknown> = {};
  if (typeof runtimeConfig === "string" && runtimeConfig.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(runtimeConfig);
      if (
        parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        connectConfigPayload = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Corrupt stored JSON — skip the overrides rather than emit invalid config.
    }
  }
  delete connectConfigPayload.packages; // state.packages is the source of truth
  const connectPackages = (state.packages ?? []).map((p) => ({
    packageName: p.name,
    ...(p.version ? { version: p.version } : {}),
  }));
  if (connectPackages.length > 0) {
    connectConfigPayload.packages = connectPackages;
    if (typeof connectConfigPayload.packageRegistryUrl !== "string") {
      connectConfigPayload.packageRegistryUrl =
        state.defaultPackageRegistry || "https://registry.dev.vetra.io";
    }
  }
  const connectConfigEnvLine =
    Object.keys(connectConfigPayload).length > 0
      ? `\n    PH_CONNECT_CONFIG_JSON: ${yamlQuote(JSON.stringify(connectConfigPayload))}`
      : "";

  // Always-on Renown auth for the standalone switchboard; env owner is admin.
  const switchboardAuthEnvLines = switchboardAuthEnv(state.owner)
    .map((e) => `\n    ${e.name}: ${yamlQuote(e.value)}`)
    .join("");

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
    LOKI_URL: http://loki.monitoring.svc:3100${switchboardAuthEnvLines}
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
// Sync — persistent working-clone approach
// ---------------------------------------------------------------------------

/**
 * Sync an environment's values to the gitops repo.
 *
 * Reuses a single persistent working clone, refreshed to a pristine
 * origin/branch (fetch + reset --hard + clean) before each render, then writes
 * the values file, commits, and pushes. Reusing the clone — instead of a fresh
 * clone per sync — is what keeps a claim's gitops re-render off the multi-second
 * critical path.
 *
 * A mutex serializes syncs within the same process so the shared working tree
 * is never touched concurrently. Cross-process / cross-pod push races are
 * handled by pull-rebase-retry.
 */
export async function syncEnvironment(
  db: Kysely<DB>,
  state: VetraCloudEnvironmentState,
  documentId: string,
  secretsService: SecretsService | null = null,
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
    await syncEnvironmentEphemeral(db, state, documentId, secretsService);
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
    await withWorkingClone(async (cloneDir, config) => {
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
  secretsService: SecretsService | null,
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

  await withWorkingClone(async (cloneDir, config) => {
    // Create tenant directory
    const tenantDir = join(cloneDir, "tenants", tenantId);
    mkdirSync(tenantDir, { recursive: true });

    // Write values file
    const valuesPath = join(tenantDir, "powerhouse-values.yaml");
    const yaml = await generateValuesYaml(db, state, documentId, secretsService);
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

/** Resolve the persistent gitops working-clone path (read lazily so tests and
 *  config changes take effect without a process restart). */
function getWorkDir(): string {
  return process.env.GITOPS_WORK_DIR ?? join(tmpdir(), "vetra-gitops-work");
}

/**
 * Ensure a pristine working clone at origin/branch and return its path.
 *
 * First use (or a missing work dir) does a full clone. Every subsequent call
 * refreshes the SAME directory with `fetch` + `reset --hard` + `clean -fd` —
 * far cheaper than re-cloning on every sync, which is what dominated the
 * post-claim latency. The gitMutex serializes callers within the process, so
 * reusing one working tree is safe.
 */
async function ensureWorkingClone(config: GitOpsConfig): Promise<string> {
  const dir = getWorkDir();

  if (existsSync(join(dir, ".git"))) {
    logger.info(`Refreshing persistent gitops clone: ${dir}`);
    await git(["fetch", config.remote, config.branch], dir);
    await git(["reset", "--hard", `${config.remote}/${config.branch}`], dir);
    await git(["clean", "-fd"], dir);
    return dir;
  }

  logger.info(`Creating persistent gitops clone: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await git(["clone", "--branch", config.branch, config.repoUrl, "."], dir);
  await git(["config", "user.name", GIT_AUTHOR_NAME], dir);
  await git(["config", "user.email", GIT_AUTHOR_EMAIL], dir);
  return dir;
}

export async function withWorkingClone(
  fn: (cloneDir: string, config: GitOpsConfig) => Promise<void>,
): Promise<void> {
  const config = getConfig();
  let cloneDir: string;
  try {
    cloneDir = await ensureWorkingClone(config);
  } catch (error) {
    // A partial/corrupted work dir can wedge fetch/reset. Nuke it and re-clone
    // once from scratch so a bad state self-heals instead of failing forever.
    logger.warn(
      `Working clone refresh failed, recreating from scratch: ${String(error)}`,
    );
    rmSync(getWorkDir(), { recursive: true, force: true });
    cloneDir = await ensureWorkingClone(config);
  }
  await fn(cloneDir, config);
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
