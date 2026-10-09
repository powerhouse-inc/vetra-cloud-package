export type LicensingMigrationMode = "off" | "dry-run" | "apply";

export interface LicensingConfig {
  enabled: boolean;
  /**
   * Default-safe: even when enabled, the autonomous handler and keeper only
   * log until this is explicitly turned off. It does NOT cover the machine
   * API's mutations (applyEnvironmentTemplate, releaseEnvironment,
   * issuePublisherGrant): an authenticated app's explicit call acts at once,
   * gated only by `enabled`.
   */
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
  /**
   * The studio app's Renown workload identity (VETRA_STUDIO_IDENTITY_DID); null
   * when unset or not a `did:` string. The studio has no apps row, so this is
   * the only source of its identity.
   */
  studioIdentityDid: string | null;
  renownStatsUrl: string | null;
  licensingPublicUrl: string | null;
  /**
   * How many live environments the handler re-templates per tick. Creation is
   * not counted (only the per-app cap applies to it). 0 pauses re-templating.
   */
  retemplatePerTick: number;
  /**
   * Reporting tokens issued per handler tick, across all apps
   * (LICENSING_TOKENS_PER_TICK). Writing one restarts a running environment
   * once; asleep environments do not count. 0 issues only to asleep ones.
   */
  tokensPerTick: number;
  /** A handler step (or read) that takes longer fails, so a hung call cannot stall every later tick. */
  stepTimeoutMs: number;
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
  const nonNegative = (name: string, fallback: number): number => {
    const v = env[name]?.trim();
    if (!v || !/^\d+$/.test(v)) return fallback;
    return Number.parseInt(v, 10);
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
    studioIdentityDid: ((v) => (v?.startsWith("did:") ? v : null))(
      trimmed("VETRA_STUDIO_IDENTITY_DID"),
    ),
    renownStatsUrl: trimmed("RENOWN_STATS_URL"),
    licensingPublicUrl: trimmed("VETRA_LICENSING_URL"),
    retemplatePerTick: nonNegative("LICENSING_RETEMPLATE_PER_TICK", 5),
    stepTimeoutMs: int("LICENSING_STEP_TIMEOUT_MS", 120 * 1000),
    tokensPerTick: nonNegative("LICENSING_TOKENS_PER_TICK", 5),
  };
}
