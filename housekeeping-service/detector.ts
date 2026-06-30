import { isEligibleForSleep } from "../subgraphs/vetra-housekeeping/policy.js";
import type { EnvDb } from "./env-db.js";
import type { LokiClient } from "./loki.js";
import type { SwitchboardClient } from "./switchboard.js";

export interface DetectorDeps {
  envDb: EnvDb;
  loki: LokiClient;
  switchboard: SwitchboardClient;
  baseDomain: string;
  idleThresholdSeconds: number;
  allowlist: string[];
  dryRun: boolean;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/** Apex studio host for a subdomain (CLINT studios are served at the apex). */
export function studioHost(subdomain: string, baseDomain: string): string {
  return `${subdomain}.${baseDomain}`;
}

/**
 * One detection pass: find claimed, eligible, READY studios with no proper
 * request in the idle window and put them to sleep (or log, in dry-run).
 * Returns the hosts that were slept (or would be).
 */
export async function runDetectionOnce(deps: DetectorDeps): Promise<string[]> {
  const log = deps.logger ?? console;
  const studios = await deps.envDb.listReadyStudios();
  const eligible = studios.filter((s) =>
    isEligibleForSleep(s, { allowlist: deps.allowlist }),
  );
  log.info(
    `[detector] ${studios.length} READY studios, ${eligible.length} eligible (dryRun=${deps.dryRun})`,
  );

  const slept: string[] = [];
  for (const s of eligible) {
    if (!s.subdomain) continue;
    const host = studioHost(s.subdomain, deps.baseDomain);
    const active = await deps.loki.hasRecentProperRequest(
      host,
      deps.idleThresholdSeconds,
    );
    if (active) continue;

    if (deps.dryRun) {
      log.info(`[detector] would sleep ${host} (idle ≥ ${deps.idleThresholdSeconds}s)`);
      slept.push(host);
      continue;
    }
    try {
      const res = await deps.switchboard.sleepStudio(host);
      log.info(`[detector] slept ${host} → ${res.status}`);
      slept.push(host);
    } catch (err) {
      log.warn(
        `[detector] sleep failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return slept;
}

/** Start the periodic detector loop. Returns a stop function. */
export function startDetector(deps: DetectorDeps, intervalMs: number): () => void {
  const log = deps.logger ?? console;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDetectionOnce(deps);
    } catch (err) {
      log.warn(`[detector] pass failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
