import type { Kysely } from "kysely";
import type { ObservabilityDB } from "./db/schema.js";
import { PrometheusClient } from "./prometheus.js";
import { LokiClient } from "./loki.js";

export interface ResolverConfig {
  prometheusUrl: string;
  lokiUrl: string;
  /**
   * Kysely client for the processor's `vetra-cloud-environments` namespace.
   * Used by `myEnvironments` to filter rows by `createdBy` against the
   * authenticated user (from reactor-api's AuthService).
   */
  envDb: Kysely<any>;
  /**
   * Dispatches an action on a document. Provided by the subgraph host — the
   * resolver is not aware of the underlying reactor client implementation.
   */
  dispatch: (documentId: string, type: string, input: Record<string, unknown>) => Promise<void>;
}

/** Auth context shape injected by reactor-api into resolver `context`. */
type AuthAwareContext = {
  user?: { address: string };
  isAdmin?: (address: string) => boolean;
};

/** Environments in these statuses have released their custom-domain claim. */
const RELEASED_STATUSES = new Set(["TERMINATING", "DESTROYED", "ARCHIVED"]);

/** Service types recognised by the doc-model enum. */
const TENANT_SERVICES = new Set(["CONNECT", "SWITCHBOARD"]);

export function createResolvers(
  db: Kysely<ObservabilityDB>,
  config: ResolverConfig,
): Record<string, any> {
  const prometheus = new PrometheusClient(config.prometheusUrl);
  const loki = new LokiClient(config.lokiUrl);
  const envDb = config.envDb;
  const dispatch = config.dispatch;

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

      myEnvironments: async (
        _parent: unknown,
        { scope }: { scope?: "MINE" | "ALL" | null },
        ctx: AuthAwareContext,
      ) => {
        const userAddress = ctx.user?.address?.toLowerCase();
        if (!userAddress) {
          // Unauthenticated → empty list. The UI can prompt for login.
          return [];
        }

        const isAdmin = ctx.isAdmin?.(userAddress) ?? false;
        const wantAll = scope === "ALL";

        // Build the query — admins requesting ALL get everything; everyone else
        // (including admins requesting MINE) gets only rows they own **plus**
        // unclaimed environments (owner IS NULL) so they can discover and
        // auto-claim them on first interaction.
        const query = envDb
          .selectFrom("environments")
          .select([
            "id",
            "name",
            "subdomain",
            "tenantId",
            "customDomain",
            "status",
            "owner",
            "createdBy",
          ]);

        const rows = wantAll && isAdmin
          ? await query.execute()
          : await query
              .where((eb) =>
                eb.or([
                  eb("owner", "=", userAddress),
                  eb("owner", "is", null),
                ]),
              )
              .execute();

        return rows;
      },

      viewer: (_parent: unknown, _args: unknown, ctx: AuthAwareContext) => {
        const address = ctx.user?.address?.toLowerCase() ?? null;
        const isAdmin = address ? (ctx.isAdmin?.(address) ?? false) : false;
        return { address, isAdmin };
      },
    },

    Mutation: {
      setCustomDomain: async (
        _parent: unknown,
        args: {
          documentId: string;
          enabled: boolean;
          domain?: string | null;
          apexService?: string | null;
        },
        ctx: AuthAwareContext,
      ) => {
        const callerAddress = ctx.user?.address?.toLowerCase();
        if (!callerAddress) {
          throw new Error("UNAUTHENTICATED");
        }
        const isAdmin = ctx.isAdmin?.(callerAddress) ?? false;

        const domain = args.domain?.trim() ? args.domain.trim().toLowerCase() : null;
        if (args.enabled && !domain) {
          throw new Error("DOMAIN_REQUIRED");
        }
        if (args.apexService && !TENANT_SERVICES.has(args.apexService)) {
          throw new Error("INVALID_APEX_SERVICE");
        }

        const envRow = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "subdomain", "tenantId", "customDomain", "status", "owner", "createdBy"])
          .where("id", "=", args.documentId)
          .executeTakeFirst()) as EnvSummaryRow | undefined;
        if (!envRow) {
          throw new Error("ENV_NOT_FOUND");
        }

        const isOwner = !!envRow.owner && envRow.owner.toLowerCase() === callerAddress;
        if (!isOwner && !isAdmin) {
          // Unclaimed envs stay open for now — the protection reconciler
          // only locks down envs that already have an owner. Allow admins
          // through regardless.
          throw new Error("FORBIDDEN");
        }

        // Uniqueness — only enforced when a domain is being claimed.
        if (args.enabled && domain) {
          const conflict = await envDb
            .selectFrom("environments")
            .select(["id", "status"])
            .where("customDomain", "=", domain)
            .where("id", "!=", args.documentId)
            .execute();
          const live = (conflict as Array<{ id: string; status: string | null }>).filter(
            (row) => !row.status || !RELEASED_STATUSES.has(row.status),
          );
          if (live.length > 0) {
            throw new Error("DOMAIN_TAKEN");
          }
        }

        await dispatch(args.documentId, "SET_CUSTOM_DOMAIN", {
          enabled: args.enabled,
          domain: args.enabled ? domain : null,
        });

        // SET_APEX_SERVICE is only meaningful when apex routing is requested
        // and a domain is set; clearing is expressed by explicitly passing
        // apexService: null (the reducer will be added in a follow-up commit
        // once the doc model catches up — dispatch is tolerant of unknown
        // ops to keep the mutation forward-compatible).
        if (args.apexService !== undefined) {
          try {
            await dispatch(args.documentId, "SET_APEX_SERVICE", {
              type: args.enabled ? (args.apexService ?? null) : null,
            });
          } catch (err) {
            // Before the doc-model rollout, this op will be unknown. Log and
            // continue — the custom-domain write already succeeded, and the
            // apex routing takes effect once the package is republished.
            console.warn(
              `[setCustomDomain] SET_APEX_SERVICE dispatch ignored: ${String(err)}`,
            );
          }
        }

        const refreshed = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "subdomain", "tenantId", "customDomain", "status", "owner", "createdBy"])
          .where("id", "=", args.documentId)
          .executeTakeFirst()) as EnvSummaryRow | undefined;
        return refreshed ?? envRow;
      },
    },
  };
}

type EnvSummaryRow = {
  id: string;
  name: string | null;
  subdomain: string | null;
  tenantId: string | null;
  customDomain: string | null;
  status: string | null;
  owner: string | null;
  createdBy: string | null;
};
