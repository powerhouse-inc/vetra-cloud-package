/**
 * vetra-housekeeping-activator — standalone pod behind the catch-all *.vetra.io
 * ingress. Catches requests to hosts no awake studio is serving, shows a
 * spinner, wakes the studio (open + idempotent wakeStudio mutation), and the
 * spinner reloads into it once it's back. Pings (the observability poller,
 * monitors, ACME) are short-circuited and never trigger a wake.
 *
 * The idle *detector* is NOT here — it runs in-process in the switchboard (the
 * HousekeepingKeeper in the vetra-housekeeping subgraph), dispatching sleeps as
 * system actions, so nothing here needs a DB, Loki, or an expiring token.
 */
import { loadConfig } from "./config.js";
import { createSwitchboardClient } from "./switchboard.js";
import { startActivator } from "./activator.js";

function main(): void {
  const cfg = loadConfig();
  console.info(`[main] starting vetra-housekeeping-activator (port=${cfg.port})`);

  const switchboard = createSwitchboardClient({ url: cfg.switchboardGraphqlUrl });
  const server = startActivator({ switchboard, logger: console }, cfg.port);
  console.info(`[main] activator listening on :${cfg.port}`);

  const shutdown = (sig: string) => {
    console.info(`[main] ${sig} — shutting down`);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
