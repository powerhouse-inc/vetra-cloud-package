export interface LicensingConfig {
  enabled: boolean;
  /** Default-safe: even when enabled, only logs until explicitly turned off. */
  dryRun: boolean;
  scanIntervalMs: number;
  /** Ceiling applied to an app with no row in app_environment_limits. */
  defaultMaxEnvironments: number;
}

export function loadLicensingConfig(
  env: NodeJS.ProcessEnv = process.env,
): LicensingConfig {
  const int = (name: string, fallback: number): number => {
    const v = env[name];
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? fallback : n;
  };
  return {
    enabled: (env.LICENSING_KEEPER_ENABLED ?? "false").toLowerCase() === "true",
    dryRun: (env.LICENSING_DRY_RUN ?? "true").toLowerCase() !== "false",
    scanIntervalMs: int("LICENSING_SCAN_INTERVAL_MS", 60 * 1000),
    defaultMaxEnvironments: int("LICENSING_DEFAULT_MAX_ENVIRONMENTS", 50),
  };
}
