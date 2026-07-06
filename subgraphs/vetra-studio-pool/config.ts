export interface PoolConfig {
  size: number;
  version: string;
  sizeName: string;
  registry: string;
  /** Cloud switchboard the warm studio's agent talks to when creating/deploying
   * environments (stamped as VETRA_CLOUD_SWITCHBOARD_URL). Per-tenant so prod
   * studios target the prod switchboard instead of the staging default. */
  switchboardUrl: string;
  enabled: boolean;
}

const DEFAULTS = {
  size: 5,
  version: "0.0.1-dev.19",
  sizeName: "VETRA_AGENT_XXL",
  registry: "https://registry.dev.vetra.io",
  switchboardUrl: "https://switchboard.staging.vetra.io",
};

/**
 * Read STUDIO_POOL_* from an env bag. The in-process keeper is "enabled" only
 * when a positive, explicit STUDIO_POOL_SIZE was provided — so the pool never
 * runs by accident in a Switchboard that didn't opt in.
 */
export function loadPoolConfig(env: Record<string, string | undefined>): PoolConfig {
  const raw = env.STUDIO_POOL_SIZE;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const explicitValid = Number.isInteger(parsed) && parsed >= 0;
  return {
    size: explicitValid ? parsed : DEFAULTS.size,
    version: env.STUDIO_POOL_VERSION ?? DEFAULTS.version,
    sizeName: env.STUDIO_POOL_SIZE_NAME ?? DEFAULTS.sizeName,
    registry: env.STUDIO_POOL_REGISTRY ?? DEFAULTS.registry,
    switchboardUrl: env.STUDIO_POOL_SWITCHBOARD_URL ?? DEFAULTS.switchboardUrl,
    enabled: explicitValid && parsed > 0,
  };
}
