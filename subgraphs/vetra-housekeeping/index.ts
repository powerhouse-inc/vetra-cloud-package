import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers, type StudioPowerStateResult } from "./resolvers.js";
import { findStudioByHost, listReadyStudios, type StudioRow } from "./db.js";
import {
  deriveStudioPowerState,
  isEligibleForSleep,
  type StudioPowerStatus,
} from "./policy.js";
import { createLokiClient } from "./loki.js";
import { HousekeepingKeeper, loadKeeperConfig } from "./keeper.js";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import {
  sleepEnvironment,
  wakeEnvironment,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";

/**
 * Studio housekeeping subgraph. Server-side home of the sleep/wake transitions,
 * the host→power-state lookup, AND the in-process idle detector (the
 * HousekeepingKeeper, modeled on the studio-pool keeper) — so auto-sleep
 * dispatches system actions via the reactor client with no auth token.
 *
 * Sleep/wake dispatch system actions on the environment document; the gitops
 * processor renders global.disabled for STOPPED and re-enables on wake (which
 * flips the env back to CHANGES_APPROVED, reusing the normal deploy pipeline).
 */
export class VetraHousekeepingSubgraph extends BaseSubgraph {
  name = "vetra-housekeeping";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};
  private keeper: HousekeepingKeeper | null = null;

  async onSetup() {
    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<DB>;

    const keeperConfig = loadKeeperConfig(process.env);
    const allowlist = keeperConfig.allowlist;

    const dispatch = (documentId: string, action: unknown) =>
      this.reactorClient
        .execute(documentId, "main", [action] as never)
        .then(() => undefined);

    const result = (
      host: string,
      row: StudioRow | null,
      status: StudioPowerStatus,
    ): StudioPowerStateResult => ({
      host,
      envId: row?.envId ?? null,
      subdomain: row?.subdomain ?? null,
      owner: row?.owner ?? null,
      status,
    });

    const powerState = async (host: string): Promise<StudioPowerStateResult> => {
      const row = await findStudioByHost(envDb, host);
      return result(host, row, deriveStudioPowerState(row ?? undefined));
    };

    const sleep = async (host: string): Promise<StudioPowerStateResult> => {
      const row = await findStudioByHost(envDb, host);
      if (!row) throw new Error("STUDIO_NOT_FOUND");
      // Idempotent: already asleep / waking → just report state.
      const current = deriveStudioPowerState(row);
      if (current === "SLEEPING") return result(host, row, "SLEEPING");
      if (!isEligibleForSleep(row, { allowlist })) {
        throw new Error("STUDIO_NOT_ELIGIBLE");
      }
      await dispatch(row.envId, sleepEnvironment({}));
      return result(host, row, "SLEEPING");
    };

    const wake = async (host: string): Promise<StudioPowerStateResult> => {
      const row = await findStudioByHost(envDb, host);
      if (!row) throw new Error("STUDIO_NOT_FOUND");
      const current = deriveStudioPowerState(row);
      // Idempotent: only a SLEEPING studio is woken; otherwise report state.
      if (current !== "SLEEPING") return result(host, row, current);
      await dispatch(row.envId, wakeEnvironment({}));
      return result(host, row, "WAKING");
    };

    this.resolvers = createResolvers({ powerState, sleep, wake });

    // In-process idle detector (like the studio-pool keeper). Opt-in via
    // HOUSEKEEPING_DETECTOR_ENABLED; dry-run by default. Dispatches
    // SLEEP_ENVIRONMENT as a system action — no token.
    if (keeperConfig.enabled) {
      const loki = createLokiClient({
        lokiUrl: (process.env.LOKI_URL ?? "http://loki-gateway.monitoring.svc").replace(/\/$/, ""),
        selector: process.env.LOKI_SELECTOR ?? '{namespace="traefik"}',
        logger: console,
      });
      this.keeper = new HousekeepingKeeper({
        listStudios: () => listReadyStudios(envDb),
        loki,
        sleepEnv: (documentId) => dispatch(documentId, sleepEnvironment({})),
        config: keeperConfig,
        logger: console,
      });
      this.keeper.start();
      console.info(
        `[vetra-housekeeping] detector keeper started (dryRun=${keeperConfig.dryRun}, idle=${keeperConfig.idleThresholdSeconds}s, scan=${keeperConfig.scanIntervalMs}ms)`,
      );
    } else {
      console.info("[vetra-housekeeping] detector keeper disabled (HOUSEKEEPING_DETECTOR_ENABLED!=true)");
    }
  }

  async onDisconnect() {
    this.keeper?.stop();
    this.keeper = null;
  }
}
