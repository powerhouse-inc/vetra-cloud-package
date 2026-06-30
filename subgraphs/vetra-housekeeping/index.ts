import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers, type StudioPowerStateResult } from "./resolvers.js";
import { findStudioByHost, type StudioRow } from "./db.js";
import {
  deriveStudioPowerState,
  isEligibleForSleep,
  type StudioPowerStatus,
} from "./policy.js";
import type { DB } from "../../processors/vetra-cloud-environment/schema.js";
import {
  sleepEnvironment,
  wakeEnvironment,
} from "../../document-models/vetra-cloud-environment/v1/gen/creators.js";

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Studio housekeeping subgraph. Server-side home of the sleep/wake transitions
 * and the host→power-state lookup, shared by the idle detector and the wake
 * activator (both in the standalone housekeeping service). Eligibility +
 * transition logic lives here so callers can't sleep/wake an ineligible env.
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

  async onSetup() {
    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<DB>;

    const allowlist = parseAllowlist(process.env.HOUSEKEEPING_ALLOWLIST);

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
  }

  async onDisconnect() {}
}
