/**
 * Runtime config for the standalone studio-housekeeping **activator** — the HTTP
 * server behind the catch-all *.vetra.io ingress that shows a spinner and wakes
 * a sleeping studio on demand.
 *
 * The idle *detector* no longer lives here — it runs in-process in the
 * switchboard (the HousekeepingKeeper in the vetra-housekeeping subgraph), so
 * this service needs no DB, no Loki, and no admin/service token (it calls the
 * open, idempotent wakeStudio mutation).
 */

export interface ActivatorConfig {
  /** Switchboard GraphQL endpoint exposing the vetra-housekeeping subgraph. */
  switchboardGraphqlUrl: string;
  /** vetra.io waking page browsers are redirected to (branded spinner). */
  wakingPageUrl: string;
  /** Port for the activator HTTP server + health endpoints. */
  port: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ActivatorConfig {
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  return {
    switchboardGraphqlUrl: required("SWITCHBOARD_GRAPHQL_URL"),
    wakingPageUrl: (env.WAKING_PAGE_URL ?? "https://vetra.io/studio/waking").replace(/\/$/, ""),
    port: Number.isNaN(port) || port <= 0 ? 8080 : port,
  };
}
