import type { Kysely } from "kysely";
import type { ObservabilityDB } from "./db/schema.js";
import { PrometheusClient } from "./prometheus.js";
import { LokiClient } from "./loki.js";

export interface ResolverConfig {
  prometheusUrl: string;
  lokiUrl: string;
}

export function createResolvers(
  db: Kysely<ObservabilityDB>,
  config: ResolverConfig,
): Record<string, any> {
  const prometheus = new PrometheusClient(config.prometheusUrl);
  const loki = new LokiClient(config.lokiUrl);

  return {
    Query: {
      environmentStatus: async (_parent: unknown, { tenantId }: { tenantId: string }) => {
        const row = await db
          .selectFrom("environment_status")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .executeTakeFirst();

        if (!row) return null;

        return {
          ...row,
          configDriftDetected: !!row.configDriftDetected,
          tlsCertValid: row.tlsCertValid === null ? null : !!row.tlsCertValid,
          domainResolves: row.domainResolves === null ? null : !!row.domainResolves,
        };
      },

      environmentPods: async (_parent: unknown, { tenantId }: { tenantId: string }) => {
        const rows = await db
          .selectFrom("environment_pods")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .execute();

        return rows.map((row) => ({
          ...row,
          ready: !!row.ready,
          service: row.service === "OTHER" ? null : row.service,
        }));
      },

      environmentEvents: async (
        _parent: unknown,
        { tenantId, limit }: { tenantId: string; limit?: number | null },
      ) => {
        const cappedLimit = Math.min(limit ?? 50, 200);

        return db
          .selectFrom("environment_events")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .orderBy("timestamp", "desc")
          .limit(cappedLimit)
          .execute();
      },

      // Prometheus proxies — delegate directly
      cpuUsage: async (
        _parent: unknown,
        { tenantId, range }: { tenantId: string; range?: string | null },
      ) => prometheus.cpuUsage(tenantId, range ?? "FIVE_MIN"),

      memoryUsage: async (
        _parent: unknown,
        { tenantId, range }: { tenantId: string; range?: string | null },
      ) => prometheus.memoryUsage(tenantId, range ?? "FIVE_MIN"),

      podRestartRate: async (
        _parent: unknown,
        { tenantId, range }: { tenantId: string; range?: string | null },
      ) => prometheus.podRestartRate(tenantId, range ?? "FIVE_MIN"),

      httpRequestRate: async (
        _parent: unknown,
        { tenantId, range }: { tenantId: string; range?: string | null },
      ) => prometheus.httpRequestRate(tenantId, range ?? "FIVE_MIN"),

      httpLatency: async (
        _parent: unknown,
        { tenantId, range }: { tenantId: string; range?: string | null },
      ) => prometheus.httpLatency(tenantId, range ?? "FIVE_MIN"),

      // Loki proxies
      logs: async (
        _parent: unknown,
        {
          tenantId,
          service,
          since,
          limit,
        }: {
          tenantId: string;
          service?: string | null;
          since?: string | null;
          limit?: number | null;
        },
      ) => loki.logs(tenantId, service ?? null, since ?? "FIVE_MIN", limit ?? 100),

      errorLogs: async (
        _parent: unknown,
        {
          tenantId,
          since,
          limit,
        }: {
          tenantId: string;
          since?: string | null;
          limit?: number | null;
        },
      ) => loki.errorLogs(tenantId, since ?? "FIVE_MIN", limit ?? 100),
    },
  };
}
