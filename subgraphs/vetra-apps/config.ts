/**
 * vetra-apps configuration, read from the environment once at setup. Every
 * group is optional: a missing group disables only the features that need it
 * (resolvers fail with SERVICE_NOT_CONFIGURED), the subgraph always loads.
 */
export interface GithubDeployConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

export interface HarborAppsConfig {
  url: string;
  username: string;
  password: string;
}

export interface RenownWorkloadConfig {
  switchboardUrl: string;
  registrationToken: string;
}

export interface VetraAppsConfig {
  /** Test/dev only: accept a release report without a verifiable GitHub attestation when no verifier is wired. */
  allowUnattestedReleases: boolean;
  github: GithubDeployConfig | null;
  webhookSecret: string | null;
  harbor: HarborAppsConfig | null;
  renown: RenownWorkloadConfig | null;
  /** base64 32-byte key; encrypts Harbor robot secrets at rest. */
  encryptionKey: Buffer | null;
  /** vetra.io base URL (renown returnUrl, PR comment links). */
  vetraAppUrl: string;
  /** Renown web app (delegation authorize page + credential REST). */
  renownWebUrl: string;
  /** The only audience Renown issues CI (workload) tokens for; verified by the CI routes. */
  ciAudience: string;
  /** Registry the production env installs packages from. */
  productionRegistry: string;
  /** Registry preview envs install PR packages from. */
  previewRegistry: string;
  /**
   * The studio app's slug (VETRA_STUDIO_APP_SLUG, default "vetra-studio").
   * Reserved: no app row is ever given it, so no app document can carry it.
   */
  studioAppSlug: string;
  /**
   * Releases phase 2 instances. enabled=false (VETRA_APPS_INSTANCES=off)
   * stops the reconciler. labelSuffix (VETRA_APPS_INSTANCE_LABEL_SUFFIX,
   * e.g. "-stg") ends every instance host, so staging and production never
   * claim the same <slug>-<name>.vetra.io.
   */
  instances: {
    enabled: boolean;
    labelSuffix: string;
    /** VETRA_APPS_INSTANCE_HEALTH=off|report|enforce (default report), VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S (60-3600, default 300), VETRA_APPS_INSTANCE_PROBES_PER_PASS, VETRA_APPS_INSTANCE_PROBES_PER_APP. */
    health?: InstanceHealthConfig;
  };
}

type Env = Record<string, string | undefined>;

export type InstanceHealthMode = "off" | "report" | "enforce";
export interface InstanceHealthConfig {
  /** off: no monitor; report: measured and shown, status unchanged; enforce: status follows health. */
  mode: InstanceHealthMode;
  /** An update unhealthy this long after it started fails (and reverts). */
  unhealthyWindowMs: number;
  probesPerPass: number;
  probesPerApp: number;
}
export const DEFAULT_INSTANCE_HEALTH: InstanceHealthConfig = {
  mode: "report",
  unhealthyWindowMs: 300_000,
  probesPerPass: 10,
  probesPerApp: 3,
};
/** Configs built by hand (tests) may leave health out. */
export const instanceHealth = (cfg: VetraAppsConfig): InstanceHealthConfig =>
  cfg.instances.health ?? DEFAULT_INSTANCE_HEALTH;

const trimmed = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** Empty, or a dash, then 1-7 lowercase alphanumerics or dashes, ending in an alphanumeric (8 characters at most). */
const LABEL_SUFFIX = /^(-[a-z0-9](?:[a-z0-9-]{0,5}[a-z0-9])?)?$/;

const INSTANCES_OFF = new Set(["off", "false", "0", "no"]);
const INSTANCES_ON = new Set(["", "on", "true", "1", "yes"]);

/**
 * Startup errors, not silent fallbacks: a bad suffix could point a
 * non-production build at a production host, so it refuses to load.
 */
function instancesConfig(env: Env): VetraAppsConfig["instances"] {
  // On by default; per-app instances_enabled defaults to false, so nothing runs until an app opts in.
  const rawSwitch = (trimmed(env.VETRA_APPS_INSTANCES) ?? "").toLowerCase();
  if (!INSTANCES_OFF.has(rawSwitch) && !INSTANCES_ON.has(rawSwitch)) {
    throw new Error(
      `VETRA_APPS_INSTANCES "${env.VETRA_APPS_INSTANCES}" is invalid: use on/off (also true/false, 1/0, yes/no)`,
    );
  }
  const suffix = trimmed(env.VETRA_APPS_INSTANCE_LABEL_SUFFIX) ?? "";
  if (!LABEL_SUFFIX.test(suffix)) {
    throw new Error(
      `VETRA_APPS_INSTANCE_LABEL_SUFFIX "${suffix}" is invalid: it must be empty, or a dash then 1-7 lowercase letters, digits or dashes, not ending in a dash (e.g. -stg)`,
    );
  }
  return {
    enabled: !INSTANCES_OFF.has(rawSwitch),
    labelSuffix: suffix,
    health: healthConfig(env),
  };
}

function intIn(
  env: Env,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = trimmed(env[name]);
  if (raw === null) return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < min || n > max)
    throw new Error(
      `${name} "${raw}" is invalid: use a whole number from ${min} to ${max}`,
    );
  return n;
}

function healthConfig(env: Env): InstanceHealthConfig {
  const mode = (trimmed(env.VETRA_APPS_INSTANCE_HEALTH) ?? "report").toLowerCase();
  if (mode !== "off" && mode !== "report" && mode !== "enforce")
    throw new Error(
      `VETRA_APPS_INSTANCE_HEALTH "${env.VETRA_APPS_INSTANCE_HEALTH}" is invalid: use off, report or enforce`,
    );
  return {
    mode,
    unhealthyWindowMs:
      intIn(env, "VETRA_APPS_INSTANCE_UNHEALTHY_WINDOW_S", 300, 60, 3600) * 1000,
    probesPerPass: intIn(env, "VETRA_APPS_INSTANCE_PROBES_PER_PASS", 10, 1, 100),
    probesPerApp: intIn(env, "VETRA_APPS_INSTANCE_PROBES_PER_APP", 3, 1, 20),
  };
}

export function loadAppsConfig(env: Env = process.env): VetraAppsConfig {
  const appId = trimmed(env.GITHUB_DEPLOY_APP_ID);
  const slug = trimmed(env.GITHUB_DEPLOY_APP_SLUG);
  const clientId = trimmed(env.GITHUB_DEPLOY_APP_CLIENT_ID);
  const clientSecret = trimmed(env.GITHUB_DEPLOY_APP_CLIENT_SECRET);
  const privateKey =
    trimmed(env.GITHUB_DEPLOY_APP_PRIVATE_KEY)?.replace(/\\n/g, "\n") ?? null;
  const github =
    appId && slug && clientId && clientSecret && privateKey
      ? { appId, slug, clientId, clientSecret, privateKey }
      : null;

  const harborUser = trimmed(env.HARBOR_APPS_ADMIN_USERNAME);
  const harborPass = trimmed(env.HARBOR_APPS_ADMIN_PASSWORD);
  const harbor =
    harborUser && harborPass
      ? {
          url: (trimmed(env.HARBOR_URL) ?? "https://cr.vetra.io").replace(
            /\/+$/,
            "",
          ),
          username: harborUser,
          password: harborPass,
        }
      : null;

  const registrationToken = trimmed(env.RENOWN_WORKLOAD_REGISTRATION_TOKEN);
  const renown = registrationToken
    ? {
        switchboardUrl: (
          trimmed(env.RENOWN_SWITCHBOARD_URL) ??
          "https://switchboard.renown.vetra.io"
        ).replace(/\/+$/, ""),
        registrationToken,
      }
    : null;

  let encryptionKey: Buffer | null = null;
  const rawKey = trimmed(env.VETRA_APPS_ENCRYPTION_KEY);
  if (rawKey) {
    const key = Buffer.from(rawKey, "base64");
    if (key.length === 32) encryptionKey = key;
    else
      console.warn(
        "[vetra-apps] VETRA_APPS_ENCRYPTION_KEY must be base64 of 32 bytes — ignoring it",
      );
  }

  return {
    allowUnattestedReleases: trimmed(env.VETRA_APPS_ALLOW_UNATTESTED_RELEASES) === "1",
    github,
    webhookSecret: trimmed(env.GITHUB_DEPLOY_APP_WEBHOOK_SECRET),
    harbor,
    renown,
    encryptionKey,
    vetraAppUrl: (trimmed(env.VETRA_APP_URL) ?? "https://vetra.io").replace(
      /\/+$/,
      "",
    ),
    renownWebUrl: (
      trimmed(env.RENOWN_WEB_URL) ?? "https://www.renown.id"
    ).replace(/\/+$/, ""),
    ciAudience:
      trimmed(env.VETRA_APPS_CI_AUDIENCE) ??
      "https://switchboard.vetra.io/api/@powerhousedao/vetra-cloud-package/apps",
    productionRegistry: "https://registry.vetra.io",
    previewRegistry: "https://registry.dev.vetra.io",
    studioAppSlug: trimmed(env.VETRA_STUDIO_APP_SLUG) ?? "vetra-studio",
    instances: instancesConfig(env),
  };
}

/** Names of the config groups that are missing, for the boot log. */
export function missingConfig(cfg: VetraAppsConfig): string[] {
  const missing: string[] = [];
  if (!cfg.github) missing.push("GITHUB_DEPLOY_APP_*");
  if (!cfg.webhookSecret) missing.push("GITHUB_DEPLOY_APP_WEBHOOK_SECRET");
  if (!cfg.harbor) missing.push("HARBOR_APPS_ADMIN_*");
  if (!cfg.renown) missing.push("RENOWN_WORKLOAD_REGISTRATION_TOKEN");
  if (!cfg.encryptionKey) missing.push("VETRA_APPS_ENCRYPTION_KEY");
  return missing;
}
