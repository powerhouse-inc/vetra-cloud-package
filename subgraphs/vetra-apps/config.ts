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
  /** Registry the production env installs packages from. */
  productionRegistry: string;
  /** Registry preview envs install PR packages from. */
  previewRegistry: string;
}

type Env = Record<string, string | undefined>;

const trimmed = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

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
    productionRegistry: "https://registry.vetra.io",
    previewRegistry: "https://registry.dev.vetra.io",
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
