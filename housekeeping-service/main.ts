/**
 * vetra-housekeeping-service — standalone Node pod with two jobs:
 *
 *   1. Idle detector: every scan interval, find claimed/eligible studios with no
 *      *proper* request (Traefik access logs in Loki, automation excluded) for
 *      the idle window and put them to sleep via the vetra-housekeeping subgraph.
 *      Gated by HOUSEKEEPING_DRY_RUN (default true) until rollout.
 *
 *   2. Wake activator: HTTP server behind the catch-all *.vetra.io ingress.
 *      Catches requests to hosts no awake studio is serving, shows a spinner,
 *      wakes the studio, and the spinner reloads into it once it's back. Pings
 *      (the observability poller, monitors, ACME) are short-circuited and never
 *      trigger a wake.
 *
 * Modeled on secrets-controller: own ServiceAccount/RBAC, own DB pool, no
 * reactor-api runtime.
 */
import { loadConfig } from "./config.js";
import { createEnvDb } from "./env-db.js";
import { createLokiClient } from "./loki.js";
import { createSwitchboardClient } from "./switchboard.js";
import { startDetector } from "./detector.js";
import { startActivator } from "./activator.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.info(
    `[main] starting vetra-housekeeping-service ` +
      `(dryRun=${cfg.dryRun}, idle=${cfg.idleThresholdSeconds}s, scan=${cfg.scanIntervalMs}ms, port=${cfg.port})`,
  );

  const envDb = createEnvDb({ databaseUrl: cfg.databaseUrl, namespace: cfg.dbNamespace });
  const loki = createLokiClient({
    lokiUrl: cfg.lokiUrl,
    selector: cfg.lokiSelector,
    logger: console,
  });
  const switchboard = createSwitchboardClient({
    url: cfg.switchboardGraphqlUrl,
    adminToken: cfg.adminToken,
  });

  const stopDetector = startDetector(
    {
      envDb,
      loki,
      switchboard,
      baseDomain: cfg.baseDomain,
      idleThresholdSeconds: cfg.idleThresholdSeconds,
      allowlist: cfg.allowlist,
      dryRun: cfg.dryRun,
      logger: console,
    },
    cfg.scanIntervalMs,
  );

  const server = startActivator({ switchboard, logger: console }, cfg.port);
  console.info(`[main] activator listening on :${cfg.port}`);

  const shutdown = (sig: string) => {
    console.info(`[main] ${sig} — shutting down`);
    stopDetector();
    server.close();
    void envDb.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[main] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
