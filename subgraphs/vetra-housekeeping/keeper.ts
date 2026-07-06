import type { StudioRow } from "./db.js";
import { isEligibleForSleep } from "./policy.js";
import type { LokiClient, HostActivity } from "./loki.js";

/** Per-studio idle classification, for the read-only `studioActivity` query. */
export type StudioActivity = {
  host: string;
  subdomain: string | null;
  envId: string;
  owner: string | null;
  /** Env-document status (the keeper only inspects claimed READY studios). */
  status: string;
  /** Passes the sleep policy (claimed, not allowlisted, …). */
  eligible: boolean;
  /** Loki verdict: ACTIVE (real requests), IDLE (automation only), UNKNOWN (no signal). */
  activity: HostActivity;
  /** True iff the keeper would sleep it this pass (eligible && IDLE). */
  wouldSleep: boolean;
};

/**
 * In-process idle detector — the housekeeping counterpart to the studio-pool
 * keeper. Runs inside the switchboard reactor (started in the subgraph's
 * onSetup), so it dispatches `SLEEP_ENVIRONMENT` directly as a system action via
 * the reactor client — no auth token, nothing that expires.
 *
 * Each pass: enumerate claimed READY studios, drop the ineligible ones, ask Loki
 * whether each had a *proper* request in the idle window, and sleep the ones
 * that didn't. Gated by `enabled` and `dryRun` for a safe rollout.
 */

export interface KeeperConfig {
  /** Master switch — the keeper does nothing unless true. */
  enabled: boolean;
  /** Log intended sleeps without dispatching. */
  dryRun: boolean;
  /** No proper request for this long ⇒ sleep. */
  idleThresholdSeconds: number;
  /** Scan cadence (ms). */
  scanIntervalMs: number;
  /**
   * Per-request timeout for the Loki idle query. The grouped 24h `| json` scan
   * over the whole Traefik stream routinely exceeds the old 30s default under
   * real log volume (→ "operation aborted" → all-UNKNOWN → nothing slept), so
   * default 120s. Overridable via HOUSEKEEPING_LOKI_TIMEOUT_MS.
   */
  lokiTimeoutMs: number;
  /** Wildcard base domain studios live under. */
  baseDomain: string;
  /** tenantIds/subdomains never to sleep. */
  allowlist: string[];
}

export function loadKeeperConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const int = (name: string, fallback: number): number => {
    const v = env[name];
    if (!v) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? fallback : n;
  };
  return {
    enabled: (env.HOUSEKEEPING_DETECTOR_ENABLED ?? "false").toLowerCase() === "true",
    // Default-safe: even when enabled, only logs until explicitly turned off.
    dryRun: (env.HOUSEKEEPING_DRY_RUN ?? "true").toLowerCase() !== "false",
    idleThresholdSeconds: int("HOUSEKEEPING_IDLE_THRESHOLD_SECONDS", 24 * 60 * 60),
    scanIntervalMs: int("HOUSEKEEPING_SCAN_INTERVAL_MS", 15 * 60 * 1000),
    lokiTimeoutMs: int("HOUSEKEEPING_LOKI_TIMEOUT_MS", 120000),
    baseDomain: env.STUDIO_BASE_DOMAIN ?? "vetra.io",
    allowlist: (env.HOUSEKEEPING_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Apex studio host for a subdomain (CLINT studios are served at the apex). */
export function studioHost(subdomain: string, baseDomain: string): string {
  return `${subdomain}.${baseDomain}`;
}

export interface KeeperDeps {
  /** Source of claimed READY studios (pre-eligibility) — injected for testability. */
  listStudios: () => Promise<StudioRow[]>;
  loki: LokiClient;
  /** Dispatch SLEEP_ENVIRONMENT on the env document (system action, in-process). */
  sleepEnv: (documentId: string) => Promise<void>;
  config: KeeperConfig;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export class HousekeepingKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private readonly deps: KeeperDeps) {}

  /**
   * Read-only: classify every claimed READY studio (eligibility + Loki idle
   * verdict) WITHOUT sleeping anything. Backs the `studioActivity` query so ops
   * can see exactly what the detector sees — including what it WOULD sleep.
   */
  async classifyAll(): Promise<StudioActivity[]> {
    const { listStudios, loki, config } = this.deps;
    const studios = await listStudios();

    // One batched Loki call for ALL hosts (two grouped queries), not one per
    // host: 40 studios × per-host = 80 queries that saturated Loki's queue and
    // timed out to all-UNKNOWN. classifyHosts fail-safes to UNKNOWN internally.
    const hosts = studios
      .map((s) => (s.subdomain ? studioHost(s.subdomain, config.baseDomain) : null))
      .filter((h): h is string => h !== null);
    const verdicts = await loki.classifyHosts(hosts, config.idleThresholdSeconds);

    return studios.map((s) => {
      const eligible = isEligibleForSleep(s, { allowlist: config.allowlist });
      const host = s.subdomain ? studioHost(s.subdomain, config.baseDomain) : "";
      const activity: HostActivity = host ? verdicts.get(host) ?? "UNKNOWN" : "UNKNOWN";
      return {
        host,
        subdomain: s.subdomain ?? null,
        envId: s.envId,
        owner: s.owner ?? null,
        status: s.status ?? "UNKNOWN",
        eligible,
        activity,
        wouldSleep: eligible && activity === "IDLE",
      };
    });
  }

  /** One detection pass. Returns the hosts slept (or that would be, in dry-run). */
  async reconcileOnce(): Promise<string[]> {
    const { listStudios, loki, sleepEnv, config } = this.deps;
    const log = this.deps.logger ?? console;
    const studios = await listStudios();
    const eligible = studios.filter((s) =>
      isEligibleForSleep(s, { allowlist: config.allowlist }),
    );
    log.info(
      `[housekeeping-keeper] ${studios.length} READY, ${eligible.length} eligible (dryRun=${config.dryRun})`,
    );

    // Batch all eligible hosts into one classifyHosts call (see classifyAll).
    const candidates = eligible
      .map((s) => (s.subdomain ? { s, host: studioHost(s.subdomain, config.baseDomain) } : null))
      .filter((c): c is { s: StudioRow; host: string } => c !== null);
    const verdicts = await loki.classifyHosts(
      candidates.map((c) => c.host),
      config.idleThresholdSeconds,
    );

    const slept: string[] = [];
    for (const { s, host } of candidates) {
      const activity = verdicts.get(host) ?? "UNKNOWN";
      // Sleep ONLY on a positive idle signal (logs exist, none proper). ACTIVE
      // and UNKNOWN (no logs / query failed) are both left running — never sleep
      // something we can't prove is idle.
      if (activity !== "IDLE") continue;

      if (config.dryRun) {
        log.info(`[housekeeping-keeper] would sleep ${host} (idle ≥ ${config.idleThresholdSeconds}s)`);
        slept.push(host);
        continue;
      }
      try {
        await sleepEnv(s.envId);
        log.info(`[housekeeping-keeper] slept ${host}`);
        slept.push(host);
      } catch (err) {
        log.warn(
          `[housekeeping-keeper] sleep failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return slept;
  }

  start(): void {
    if (this.timer) return;
    const log = this.deps.logger ?? console;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.reconcileOnce()
        .catch((err) =>
          log.warn(`[housekeeping-keeper] pass failed: ${err instanceof Error ? err.message : String(err)}`),
        )
        .finally(() => {
          this.running = false;
        });
    };
    tick();
    this.timer = setInterval(tick, this.deps.config.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
