import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import {
  createResolvers,
  type StudioCandidate,
  type StudioPowerStateResult,
} from "./resolvers.js";
import { findStudioByHost, listReadyStudios } from "./db.js";
import {
  deriveStudioPowerState,
  isEligibleForSleep,
} from "./policy.js";
import { createWake, studioPowerResult } from "./wake.js";
import { isLicenceStopped } from "../vetra-licensing/offboarding.js";
import type { VetraLicensingDB } from "../vetra-licensing/db/schema.js";
import { createLokiClient } from "./loki.js";
import { HousekeepingKeeper, loadKeeperConfig, studioHost } from "./keeper.js";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import { createReactorEnvGateway } from "../vetra-apps/envs.js";
import {
  createEnvironmentStopper,
  housekeepingKeepsDatabase,
} from "../vetra-apps/holds/stop.js";
import type { VetraAppsDB } from "../vetra-apps/db/schema.js";
import {
  sleepEnvironment,
  wakeEnvironment,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import { withoutStacktraces } from "../../shared/graphql-errors.js";

/** The reason of a housekeeping hold (VETRA_HOUSEKEEPING_KEEPS_DATABASE). */
const HOUSEKEEPING_HOLD_REASON = "idle (housekeeping)";

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

    const result = studioPowerResult;

    // VETRA_HOUSEKEEPING_KEEPS_DATABASE (default off): a database-backed
    // environment is held instead of slept (a sleep deletes its database),
    // except a CLINT one, which still sleeps: the chart cannot scale clint
    // down, so a hold would leave the agent running. Off, studios sleep and
    // wake by dispatch exactly as before.
    const stopper = housekeepingKeepsDatabase()
      ? createEnvironmentStopper(
          {
            db: (await this.relationalDb.createNamespace(
              "vetra-apps",
            )) as unknown as Kysely<VetraAppsDB>,
            envs: createReactorEnvGateway(this.reactorClient as never),
            now: () => new Date(),
          },
          {
            keepsDatabase: true,
            reason: HOUSEKEEPING_HOLD_REASON,
            sleepsClint: true,
          },
        )
      : null;
    const stopEnv = async (envId: string) => {
      if (stopper) await stopper.stop(envId);
      else await dispatch(envId, sleepEnvironment({}));
    };
    const resumeEnv = async (envId: string) => {
      if (stopper) await stopper.resume(envId);
      else await dispatch(envId, wakeEnvironment({}));
    };
    const powerOf = async (row: Awaited<ReturnType<typeof findStudioByHost>>) =>
      row && stopper && (await stopper.isStopped(row.envId))
        ? ("SLEEPING" as const)
        : deriveStudioPowerState(row ?? undefined);

    const powerState = async (host: string): Promise<StudioPowerStateResult> => {
      const row = await findStudioByHost(envDb, host);
      return result(host, row, await powerOf(row));
    };

    const sleep = async (host: string): Promise<StudioPowerStateResult> => {
      const row = await findStudioByHost(envDb, host);
      if (!row) throw new Error("STUDIO_NOT_FOUND");
      // Idempotent: already asleep / waking → just report state.
      const current = await powerOf(row);
      if (current === "SLEEPING") return result(host, row, "SLEEPING");
      if (!isEligibleForSleep(row, { allowlist })) {
        throw new Error("STUDIO_NOT_ELIGIBLE");
      }
      await stopEnv(row.envId);
      return result(host, row, "SLEEPING");
    };

    const licensingDb = (await this.relationalDb.createNamespace(
      "vetra-licensing",
    )) as unknown as Kysely<VetraLicensingDB>;
    const wake = createWake({
      findStudioByHost: (h) => findStudioByHost(envDb, h),
      dispatchWake: resumeEnv,
      isLicenceStopped: (id) => isLicenceStopped(licensingDb, id),
      ...(stopper ? { isHeld: (id: string) => stopper.isStopped(id) } : {}),
    });

    // Raw candidate rows for the external idle detector (Task 1.1): same source
    // rows as the in-process keeper, just unfiltered/unclassified — the external
    // service runs its own eligibility instead of trusting `studioActivity`.
    const readyStudios = async (): Promise<StudioCandidate[]> => {
      const rows = await listReadyStudios(envDb);
      return rows.map((row) => ({
        host: studioHost(row.subdomain ?? "", keeperConfig.baseDomain),
        subdomain: row.subdomain ?? null,
        envId: row.envId,
        owner: row.owner ?? null,
        status: row.status ?? "",
        poolState: row.poolState ?? null,
        tenantId: row.tenantId ?? null,
        services: row.services ?? null,
      }));
    };

    // In-process idle detector + on-demand classifier (like the studio-pool
    // keeper). Build the keeper UNCONDITIONALLY so the read-only `studioActivity`
    // query works even when the auto-sleep loop is off; only START the periodic
    // loop when HOUSEKEEPING_DETECTOR_ENABLED. Sleeps dispatch SLEEP_ENVIRONMENT
    // as a system action — no token.
    const loki = createLokiClient({
      lokiUrl: (process.env.LOKI_URL ?? "http://loki-gateway.monitoring.svc").replace(/\/$/, ""),
      selector: process.env.LOKI_SELECTOR ?? '{namespace="traefik"}',
      fetchTimeoutMs: keeperConfig.lokiTimeoutMs,
      canaryHost: process.env.HOUSEKEEPING_CANARY_HOST,
      logger: console,
    });
    const keeper = new HousekeepingKeeper({
      listStudios: () => listReadyStudios(envDb),
      loki,
      sleepEnv: stopEnv,
      config: keeperConfig,
      logger: console,
    });
    this.keeper = keeper;

    this.resolvers = withoutStacktraces(
      createResolvers({
        powerState,
        sleep,
        wake,
        studioActivity: () => keeper.classifyAll(),
        readyStudios,
      }),
    );

    // DEPRECATION: this in-process detector is being extracted to the standalone
    // tier-aware housekeeping service (see docs/superpowers/specs/2026-07-17-
    // housekeeping-service-extraction-design.md). Keep it running until the
    // service's detector is verified on both tiers, then set
    // HOUSEKEEPING_DETECTOR_ENABLED=false per tier (cutover) and remove.
    if (keeperConfig.enabled) {
      keeper.start();
      console.info(
        `[vetra-housekeeping] detector keeper started (dryRun=${keeperConfig.dryRun}, idle=${keeperConfig.idleThresholdSeconds}s, scan=${keeperConfig.scanIntervalMs}ms)`,
      );
    } else {
      console.info(
        "[vetra-housekeeping] detector loop disabled (HOUSEKEEPING_DETECTOR_ENABLED!=true); studioActivity query still available",
      );
    }
  }

  async onDisconnect() {
    this.keeper?.stop();
    this.keeper = null;
  }
}
