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

/** Service types recognised by the doc-model enum. FUSION is the
 *  generic-frontend kind — runs an arbitrary container image and can be
 *  pinned to the apex of a custom domain. */
const TENANT_SERVICES = new Set(["CONNECT", "SWITCHBOARD", "FUSION"]);

/** image name ↔ doc-model service type. */
const IMAGES_TO_SERVICE: Record<string, string> = {
  connect: "CONNECT",
  switchboard: "SWITCHBOARD",
};
const SERVICE_TO_IMAGE: Record<string, string> = {
  CONNECT: "connect",
  SWITCHBOARD: "switchboard",
};

/** GitHub repo where releases live — used to construct release URLs. */
const RELEASES_REPO =
  process.env.CLOUD_AUTO_UPDATE_RELEASES_REPO ?? "powerhouse-inc/powerhouse";

function releaseUrlFor(tag: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/tag/${tag}`;
}

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

      latestRelease: async (
        _parent: unknown,
        { channel, image }: { channel: string; image: string },
      ) => {
        const row = await db
          .selectFrom("release_index")
          .select(["channel", "image", "tag", "publishedAt", "releaseUrl"])
          .where("channel", "=", channel)
          .where("image", "=", image)
          .executeTakeFirst();
        return row ?? null;
      },

      environmentReleaseHistory: async (
        _parent: unknown,
        { documentId, limit }: { documentId: string; limit?: number | null },
      ) => {
        const capped = Math.min(limit ?? 20, 100);
        const rows = await db
          .selectFrom("release_history")
          .select([
            "documentId",
            "tenantId",
            "service",
            "fromTag",
            "toTag",
            "trigger",
            "channel",
            "at",
            "releaseUrl",
          ])
          .where("documentId", "=", documentId)
          .orderBy("at", "desc")
          .limit(capped)
          .execute();
        return rows;
      },

      clintRuntimeEndpointsByEnv: async (
        _parent: unknown,
        { documentId }: { documentId: string },
      ) => {
        const rows = await db
          .selectFrom("clint_runtime_endpoints")
          .select(["prefix", "endpointId", "type", "port", "status", "lastSeen"])
          .where("documentId", "=", documentId)
          .orderBy("prefix", "asc")
          .orderBy("endpointId", "asc")
          .execute();
        // Group by prefix.
        const byPrefix = new Map<
          string,
          {
            prefix: string;
            endpoints: {
              id: string;
              type: string;
              port: string;
              status: string;
              lastSeen: string;
            }[];
          }
        >();
        for (const r of rows) {
          let group = byPrefix.get(r.prefix);
          if (!group) {
            group = { prefix: r.prefix, endpoints: [] };
            byPrefix.set(r.prefix, group);
          }
          group.endpoints.push({
            id: r.endpointId,
            type: r.type,
            port: r.port,
            status: r.status,
            lastSeen: r.lastSeen,
          });
        }
        return Array.from(byPrefix.values());
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

        // `enabled` without a `domain` is a valid intermediate state — the
        // UI toggles the checkbox to reveal the input, then the user types a
        // domain and clicks Save. We only enforce uniqueness once a domain
        // is actually supplied.
        const domain = args.domain?.trim() ? args.domain.trim().toLowerCase() : null;
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

      notifyNewImageRelease: async (
        _parent: unknown,
        { input }: {
          input: {
            tag: string;
            channel: string;
            images: string[];
            secret: string;
          };
        },
      ) => {
        const expected = process.env.CLOUD_AUTO_UPDATE_SECRET;
        if (!expected || input.secret !== expected) {
          throw new Error("UNAUTHORIZED");
        }

        const tag = input.tag.startsWith("v") ? input.tag : `v${input.tag}`;
        const channel = input.channel.toUpperCase();
        const releaseUrl = releaseUrlFor(tag);

        // Upsert release_index for every image we were told about, so the
        // UI can show "latest on channel X" even before any env subscribes.
        const publishedAt = new Date().toISOString();
        for (const img of input.images) {
          const service = IMAGES_TO_SERVICE[img.toLowerCase()];
          if (!service) continue;
          const id = `${channel}/${service}`;
          await db
            .insertInto("release_index")
            .values({
              id,
              channel,
              image: service,
              tag,
              publishedAt,
              releaseUrl,
            })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({ tag, publishedAt, releaseUrl }),
            )
            .execute();
        }

        const serviceTypes = new Set(
          input.images
            .map((img) => IMAGES_TO_SERVICE[img.toLowerCase()])
            .filter((s): s is string => !!s),
        );
        if (serviceTypes.size === 0) {
          console.info(
            `[notifyNewImageRelease] no recognised images in [${input.images.join(",")}], skipping dispatch`,
          );
          return { updatedEnvironments: [] };
        }

        // Find live environments matching this channel. Two matching rules:
        //   (a) opt-in via state.autoUpdateChannel = channel
        //   (b) legacy env-var mapping channel → customDomain
        // Union the results so admin-dev keeps working while users can also
        // subscribe their own envs through the UI.
        const targetDomain = resolveChannelDomain(channel);
        const matched = new Map<string, EnvForBump>();
        const byChannel = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "tenantId", "status", "services"])
          .where("autoUpdateChannel", "=", channel)
          .execute()) as EnvForBump[];
        for (const r of byChannel) matched.set(r.id, r);
        if (targetDomain) {
          const byDomain = (await envDb
            .selectFrom("environments")
            .select(["id", "name", "tenantId", "status", "services"])
            .where("customDomain", "=", targetDomain)
            .execute()) as EnvForBump[];
          for (const r of byDomain) if (!matched.has(r.id)) matched.set(r.id, r);
        }

        const updated: string[] = [];
        for (const env of matched.values()) {
          const bumped = await bumpEnvToTag(
            { db, envDb, dispatch },
            env,
            serviceTypes,
            tag,
            "AUTO",
            channel,
            releaseUrl,
          );
          if (bumped) updated.push(env.id);
        }
        return { updatedEnvironments: updated };
      },

      updateEnvironmentToLatest: async (
        _parent: unknown,
        { documentId }: { documentId: string },
        ctx: AuthAwareContext,
      ) => {
        const callerAddress = ctx.user?.address?.toLowerCase();
        if (!callerAddress) throw new Error("UNAUTHENTICATED");
        const isAdmin = ctx.isAdmin?.(callerAddress) ?? false;

        const envRow = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "tenantId", "status", "services", "owner", "autoUpdateChannel"])
          .where("id", "=", documentId)
          .executeTakeFirst()) as
          | (EnvForBump & { owner: string | null; autoUpdateChannel: string | null })
          | undefined;
        if (!envRow) throw new Error("ENV_NOT_FOUND");

        const isOwner =
          !!envRow.owner && envRow.owner.toLowerCase() === callerAddress;
        if (!isOwner && !isAdmin) throw new Error("FORBIDDEN");

        const channel = envRow.autoUpdateChannel;
        if (!channel) throw new Error("NO_CHANNEL");

        // Look up the latest known tag per enabled service on this channel.
        const services = parseEnvServices(envRow.services);
        const enabledServices = new Set(
          services.filter((s) => s.enabled).map((s) => s.type),
        );
        if (enabledServices.size === 0) {
          return { updatedEnvironments: [] };
        }

        const latestRows = await db
          .selectFrom("release_index")
          .select(["image", "tag", "releaseUrl"])
          .where("channel", "=", channel)
          .where("image", "in", Array.from(enabledServices))
          .execute();
        if (latestRows.length === 0) throw new Error("NO_RELEASE_KNOWN");

        // Group by tag: all services on the same channel usually share the
        // same tag (they're released together from the monorepo), but
        // handle the case where they diverge by dispatching per-service.
        const bumpedAny: string[] = [];
        for (const row of latestRows) {
          const dispatched = await bumpEnvToTag(
            { db, envDb, dispatch },
            envRow,
            new Set([row.image]),
            row.tag,
            "MANUAL",
            channel,
            row.releaseUrl ?? releaseUrlFor(row.tag),
          );
          if (dispatched && !bumpedAny.includes(envRow.id)) bumpedAny.push(envRow.id);
        }

        if (bumpedAny.length > 0) {
          try {
            await dispatch(documentId, "APPROVE_CHANGES", {});
          } catch (err) {
            console.warn(
              `[updateEnvironmentToLatest] approve failed for ${documentId}: ${String(err)}`,
            );
          }
        }
        return { updatedEnvironments: bumpedAny };
      },

      rollbackEnvironmentRelease: async (
        _parent: unknown,
        { documentId }: { documentId: string },
        ctx: AuthAwareContext,
      ) => {
        const callerAddress = ctx.user?.address?.toLowerCase();
        if (!callerAddress) throw new Error("UNAUTHENTICATED");
        const isAdmin = ctx.isAdmin?.(callerAddress) ?? false;

        const envRow = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "tenantId", "status", "services", "owner"])
          .where("id", "=", documentId)
          .executeTakeFirst()) as
          | (EnvForBump & { owner: string | null })
          | undefined;
        if (!envRow) throw new Error("ENV_NOT_FOUND");
        const isOwner =
          !!envRow.owner && envRow.owner.toLowerCase() === callerAddress;
        if (!isOwner && !isAdmin) throw new Error("FORBIDDEN");

        const services = parseEnvServices(envRow.services);
        const enabledServices = services.filter((s) => s.enabled);
        if (enabledServices.length === 0) return { updatedEnvironments: [] };

        // For each enabled service, find the most recent history entry with
        // a non-null fromTag — that fromTag is the previous version.
        const rolled: string[] = [];
        let anyService = false;
        for (const svc of enabledServices) {
          const prev = await db
            .selectFrom("release_history")
            .select(["fromTag", "releaseUrl"])
            .where("documentId", "=", documentId)
            .where("service", "=", svc.type)
            .where("fromTag", "is not", null)
            .orderBy("at", "desc")
            .limit(1)
            .executeTakeFirst();
          if (!prev?.fromTag) continue;
          anyService = true;
          const dispatched = await bumpEnvToTag(
            { db, envDb, dispatch },
            envRow,
            new Set([svc.type]),
            prev.fromTag,
            "ROLLBACK",
            null,
            prev.releaseUrl ?? releaseUrlFor(prev.fromTag),
          );
          if (dispatched && !rolled.includes(envRow.id)) rolled.push(envRow.id);
        }
        if (!anyService) throw new Error("NO_PRIOR_RELEASE");

        if (rolled.length > 0) {
          try {
            await dispatch(documentId, "APPROVE_CHANGES", {});
          } catch (err) {
            console.warn(
              `[rollbackEnvironmentRelease] approve failed for ${documentId}: ${String(err)}`,
            );
          }
        }
        return { updatedEnvironments: rolled };
      },
    },

    ReleaseHistoryEntry: {},
    ReleaseIndexEntry: {},
    ClintRuntimeEndpointsForPrefix: {},
    ClintRuntimeEndpoint: {},
  };
}

/** Shape of environments-table row the bump helpers read. */
type EnvForBump = {
  id: string;
  name: string | null;
  tenantId: string | null;
  status: string | null;
  services: string | null;
};

function parseEnvServices(
  raw: string | null,
): Array<{ type: string; enabled: boolean; version: string | null }> {
  try {
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      type?: string;
      enabled?: boolean;
      version?: string | null;
    }>;
    return parsed.map((s) => ({
      type: String(s.type ?? ""),
      enabled: !!s.enabled,
      version: s.version ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Dispatch SET_SERVICE_VERSION for each enabled service in serviceTypes, then
 * record one release_history row per dispatch. Does NOT call APPROVE_CHANGES
 * — the caller decides when to approve (the bulk `notifyNewImageRelease`
 * approves after all services; update-now/rollback approve once too).
 *
 * Returns true iff at least one dispatch was issued.
 */
async function bumpEnvToTag(
  ctx: {
    db: Kysely<ObservabilityDB>;
    envDb: Kysely<any>;
    dispatch: (
      documentId: string,
      type: string,
      input: Record<string, unknown>,
    ) => Promise<void>;
  },
  env: EnvForBump,
  serviceTypes: Set<string>,
  tag: string,
  trigger: "AUTO" | "MANUAL" | "ROLLBACK",
  channel: string | null,
  releaseUrl: string,
): Promise<boolean> {
  if (env.status && RELEASED_STATUSES.has(env.status)) return false;

  const services = parseEnvServices(env.services);
  const enabledMatching = services.filter(
    (s) => s.enabled && serviceTypes.has(s.type),
  );
  if (enabledMatching.length === 0) return false;

  // Skip services already on the target tag — no-op dispatch wastes
  // processor cycles and pollutes release_history.
  const needsBump = enabledMatching.filter((s) => s.version !== tag);
  if (needsBump.length === 0) return false;

  let dispatched = false;
  for (const svc of needsBump) {
    try {
      await ctx.dispatch(env.id, "SET_SERVICE_VERSION", {
        type: svc.type,
        version: tag,
      });
      dispatched = true;
      const at = new Date().toISOString();
      const id = `${env.id}/${svc.type}/${at}`;
      await ctx.db
        .insertInto("release_history")
        .values({
          id,
          documentId: env.id,
          tenantId: env.tenantId,
          service: svc.type,
          fromTag: svc.version,
          toTag: tag,
          trigger,
          channel,
          at,
          releaseUrl,
        })
        .execute();
    } catch (err) {
      console.warn(
        `[bumpEnvToTag] ${env.name ?? env.id}: ${svc.type} → ${tag} failed: ${String(err)}`,
      );
    }
  }

  // `notifyNewImageRelease` approves after the whole batch for efficiency;
  // the two explicit mutations approve once in their own handler.
  if (dispatched && trigger === "AUTO") {
    try {
      await ctx.dispatch(env.id, "APPROVE_CHANGES", {});
      console.info(
        `[bumpEnvToTag] ${env.name ?? env.id}: bumped [${needsBump.map((s) => s.type).join(",")}] → ${tag}`,
      );
    } catch (err) {
      console.warn(
        `[bumpEnvToTag] ${env.name ?? env.id}: approve failed: ${String(err)}`,
      );
    }
  }

  return dispatched;
}

/**
 * Resolve a release channel to the custom domain that identifies the env to
 * auto-bump. Reads CLOUD_AUTO_UPDATE_CHANNELS (comma-separated pairs like
 * `dev:admin-dev.vetra.io,staging:admin.vetra.io`) with a sensible default
 * so the feature works out of the box without additional config.
 */
function resolveChannelDomain(channel: string): string | null {
  const raw =
    process.env.CLOUD_AUTO_UPDATE_CHANNELS ??
    "dev:admin-dev.vetra.io,staging:admin.vetra.io";
  for (const pair of raw.split(",")) {
    const [ch, domain] = pair.split(":").map((s) => s.trim());
    if (ch && domain && ch === channel) return domain;
  }
  return null;
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
