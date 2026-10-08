export type LicensingMigrationMode = "off" | "dry-run" | "apply";

export interface LicensingConfig {
  enabled: boolean;
  /** Default-safe: even when enabled, only logs until explicitly turned off. */
  dryRun: boolean;
  scanIntervalMs: number;
  /** Ceiling applied to an app with no row in app_environment_limits. */
  defaultMaxEnvironments: number;
  /** The +90-day offboarding destroy. Off by default: environments are only ever stopped. */
  destroyEnabled: boolean;
  /** The startup licensing migration. Dry-run by default; an unknown value is dry-run. */
  migration: LicensingMigrationMode;
  /** Whether the migration may delete the legacy licence-type documents. */
  deleteLicenseTypes: boolean;
  studioAppSlug: string;
  /** Lowercased address of the studio app's publisher; null when unconfigured. */
  studioPublisher: string | null;
  renownStatsUrl: string | null;
  licensingPublicUrl: string | null;
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
  const trimmed = (name: string): string | null => {
    const v = env[name]?.trim();
    return v ? v : null;
  };
  const flag = (name: string): boolean =>
    (env[name] ?? "false").trim().toLowerCase() === "true";
  const mode = (env.LICENSING_MIGRATION ?? "dry-run").trim().toLowerCase();
  const firstAdmin =
    (env.ADMINS ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .find(Boolean) ?? null;
  return {
    enabled: (env.LICENSING_KEEPER_ENABLED ?? "false").toLowerCase() === "true",
    dryRun: (env.LICENSING_DRY_RUN ?? "true").toLowerCase() !== "false",
    scanIntervalMs: int("LICENSING_SCAN_INTERVAL_MS", 60 * 1000),
    defaultMaxEnvironments: int("LICENSING_DEFAULT_MAX_ENVIRONMENTS", 50),
    destroyEnabled: flag("LICENSING_DESTROY_ENABLED"),
    migration: mode === "off" || mode === "apply" ? mode : "dry-run",
    deleteLicenseTypes: flag("LICENSING_MIGRATION_DELETE_LICENSE_TYPES"),
    studioAppSlug: trimmed("VETRA_STUDIO_APP_SLUG") ?? "vetra-studio",
    studioPublisher:
      trimmed("VETRA_STUDIO_PUBLISHER_ADDRESS")?.toLowerCase() ?? firstAdmin,
    renownStatsUrl: trimmed("RENOWN_STATS_URL"),
    licensingPublicUrl: trimmed("VETRA_LICENSING_URL"),
  };
}
