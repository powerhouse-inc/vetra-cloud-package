import { sql, type Kysely } from "kysely";
import { isStudioAgentPackage } from "../../shared/studio-package.js";
import type { ObservabilityDB } from "./db/schema.js";
import { PrometheusClient } from "./prometheus.js";
import { LokiClient } from "./loki.js";
import {
  createDumpResolvers,
  type DumpResolverDeps,
} from "./dumps/resolvers.js";
import {
  createRestartResolver,
  type RestartResolverDeps,
} from "./restart.js";
import { createPackageRegistryResolver } from "./package-registry.js";
import { callerIsAdmin } from "../../shared/admins.js";
import { OWNER_ONLY_ACCESS, parseOperators, type EnvAccess } from "./env-access.js";
import {
  grantViewer,
  orgProtectionOptions,
  syncEnvironmentOrgOnce,
  withEnvLock,
  type OrgEnvRow,
  type OrgSyncDeps,
} from "./org-sync.js";
import { expectOrgHandover, protectEnvironment, withdrawOrgHandover } from "./env-protection.js";

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
  /**
   * Optional dependencies for the on-demand database dump feature. The
   * subgraph host omits this when S3 credentials aren't configured —
   * see `index.ts` startup gating. When absent, `environmentDumps`
   * still resolves (to an empty list) so the schema's non-null
   * contract is honoured, and `requestEnvironmentDump` throws
   * `DUMPS_NOT_CONFIGURED` so callers see a clear error rather than a
   * confusing schema violation.
   */
  dumpDeps?: DumpResolverDeps;
  /**
   * Optional dependencies for the service rollout-restart feature. Omitted
   * by the host when the in-cluster Kubernetes client can't be constructed;
   * `restartEnvironmentService` then throws RESTART_NOT_CONFIGURED.
   */
  restartDeps?: RestartResolverDeps;
  /** Org-aware access checks; default: owner/admin only. */
  access?: EnvAccess;
  /** Organisation operator sync (orgOperators + document grants); omitted: no sync. */
  orgSync?: OrgSyncDeps;
  /** Minimum gap between two syncs by `syncEnvironmentOrg` for one caller and env (default 10 s). */
  orgSyncMinIntervalMs?: number;
}

/**
 * Remembers when each key last completed; bounded so it cannot grow without
 * limit. Only successful runs are marked, so a failure can be retried at once.
 */
function createKeyedRateLimiter(minIntervalMs: number, maxKeys = 10_000) {
  const last = new Map<string, number>();
  return {
    limited(key: string): boolean {
      if (minIntervalMs <= 0) return false;
      const prev = last.get(key);
      return prev !== undefined && Date.now() - prev < minIntervalMs;
    },
    mark(key: string): void {
      if (minIntervalMs <= 0) return;
      last.delete(key);
      last.set(key, Date.now());
      if (last.size > maxKeys) {
        const oldest = last.keys().next().value;
        if (oldest !== undefined) last.delete(oldest);
      }
    },
  };
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
  const access = config.access ?? OWNER_ONLY_ACCESS;
  const orgSyncLimiter = createKeyedRateLimiter(config.orgSyncMinIntervalMs ?? 10_000);
  const loadOrgEnv = async (environmentId: string) =>
    (await envDb
      .selectFrom("environments")
      .select(["id", "owner", "ownerOrgId", "orgOperators", "appId", "status"])
      .where("id", "=", environmentId)
      .executeTakeFirst()) as (OrgEnvRow & { status: string | null }) | undefined;
  // Dump resolvers are always registered so the schema's non-nullable
  // `environmentDumps` field never resolves to undefined (which would
  // crash with "Cannot return null for non-nullable field"). When the
  // host hasn't configured S3/k8s deps, the query returns an empty
  // list and the mutation throws DUMPS_NOT_CONFIGURED.
  const dumpResolvers = config.dumpDeps
    ? createDumpResolvers({ ...config.dumpDeps, access })
    : {
        Query: {
          environmentDumps: async () => [] as never[],
        },
        Mutation: {
          requestEnvironmentDump: async () => {
            throw new Error("DUMPS_NOT_CONFIGURED");
          },
          cancelEnvironmentDump: async () => {
            throw new Error("DUMPS_NOT_CONFIGURED");
          },
        },
      };

  // Always registered; the resolver throws RESTART_NOT_CONFIGURED when the
  // host couldn't build the in-cluster k8s client (restartDeps omitted).
  const restartResolvers = createRestartResolver(
    config.restartDeps && { ...config.restartDeps, access },
  );
  const packageRegistryResolvers = createPackageRegistryResolver({ envDb, dispatch, access });

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
          agent,
          since,
          limit,
        }: {
          tenantId: string;
          service?: string | null;
          agent?: string | null;
          since?: string | null;
          limit?: number | null;
        },
      ) => {
        if (service && agent) {
          throw new Error(
            "logs: pass either `service` or `agent`, not both — they target different streams",
          );
        }
        // Agent-scoped path: translate the prefix into a list of pod
        // names via the env_pods cache (populated by the watcher from
        // the chart's `clint.vetra.io/agent` label). If we don't know
        // any pods yet — e.g. the agent was just created and the
        // watcher hasn't seen it — return an empty list rather than
        // falling through to env-wide; the alternative would mislead
        // the UI into showing other agents' logs under this agent.
        if (agent) {
          const podRows = await db
            .selectFrom("environment_pods")
            .select(["name"])
            .where("tenantId", "=", tenantId)
            .where("agent", "=", agent)
            .execute();
          if (podRows.length === 0) return [];
          return loki.logs(
            tenantId,
            null,
            since ?? "FIVE_MIN",
            limit ?? 100,
            podRows.map((r) => r.name),
          );
        }
        return loki.logs(tenantId, service ?? null, since ?? "FIVE_MIN", limit ?? 100);
      },

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
        { scope, orgId }: { scope?: "MINE" | "ALL" | "ORG" | null; orgId?: string | null },
        ctx: AuthAwareContext,
      ) => {
        const userAddress = ctx.user?.address?.toLowerCase();
        if (!userAddress) {
          // Unauthenticated → empty list. The UI can prompt for login.
          return [];
        }

        const isAdmin = callerIsAdmin(ctx, userAddress);
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
            "studioInstanceId",
            "packages",
            "services",
            "appId",
            "appRole",
            "prNumber",
            "ownerOrgId",
            "orgOperators",
          ]);

        let rows;
        if (scope === "ORG") {
          const org = orgId?.trim();
          if (!org) throw new Error("ORG_ID_REQUIRED");
          if (!(await access.isMember({ address: userAddress, isAdmin }, org))) {
            throw new Error("FORBIDDEN");
          }
          rows = await query.where("ownerOrgId", "=", org).execute();
        } else if (wantAll && isAdmin) {
          rows = await query.execute();
        } else {
          // Personal envs only: org envs are listed under their organisation.
          // An unowned env only to its creator (the window before their
          // SET_OWNER lands): listing every unowned env handed out warm-pool
          // document ids, which anyone could then try to claim.
          rows = await query
            .where("ownerOrgId", "is", null)
            .where((eb) =>
              eb.or([
                eb("owner", "=", userAddress),
                eb.and([eb("owner", "is", null), eb("createdBy", "=", userAddress)]),
              ]),
            )
            .execute();
        }

        // packages/services are stored as JSON text; parse them into the
        // arrays the summary type declares so env cards can render package
        // counts + service lists (mirrors myStudioProducts' parsing).
        return rows.map((row) => ({
          ...row,
          packages: parseEnvSummaryPackages(row.packages as string | null),
          services: parseEnvSummaryServices(row.services as string | null),
          orgOperators: parseOperators(row.orgOperators as string | null),
        }));
      },

      myStudioProducts: async (
        _parent: unknown,
        _args: unknown,
        ctx: AuthAwareContext,
      ) => {
        const me = ctx.user?.address?.toLowerCase();
        if (!me) {
          // Unauthenticated → empty list. The UI can prompt for login.
          return [];
        }

        // Scope strictly by ownership OR a synchronous claim. claimedBy is
        // written at claim time, so just-claimed envs show up immediately
        // (no owner-propagation lag), and unclaimed warm-pool envs (owner
        // and claimedBy both NULL) never leak. owner/claimedBy are stored
        // lowercased; compare lowercased defensively.
        const rows = (await envDb
          .selectFrom("environments")
          .select([
            "id",
            "name",
            "subdomain",
            "services",
            "status",
            "packages",
            "claimedAt",
          ])
          .where((eb) =>
            eb.or([
              eb(sql<string>`lower(${eb.ref("owner")})`, "=", me),
              eb(sql<string>`lower(${eb.ref("claimedBy")})`, "=", me),
            ]),
          )
          .execute()) as StudioEnvRow[];

        // Filter to live STUDIO envs, capturing the matched CLINT prefix.
        // `claimedAt` is threaded through so readiness can be evaluated against
        // each env's own claim time (see freshness check below).
        const matched: Array<{
          id: string;
          subdomain: string;
          prefix: string;
          label: string;
          claimedAt: string | null;
          status: string | null;
        }> = [];
        for (const row of rows) {
          if (row.status && RELEASED_STATUSES.has(row.status)) continue;
          if (!row.subdomain) continue;

          const services = parseEnvStudioServices(row.services);
          // A studio env runs an enabled studio-agent CLINT service, matched by
          // inline config package name or the env's packages array.
          const hasStudioPackage = parseEnvPackages(row.packages).some((p) =>
            isStudioAgentPackage(p.name),
          );
          const studioService = services.find(
            (s) =>
              s.type === "CLINT" &&
              s.enabled &&
              (isStudioAgentPackage(s.packageName) ||
                (s.packageName === null && hasStudioPackage)),
          );
          if (!studioService) continue;

          matched.push({
            id: row.id,
            subdomain: row.subdomain,
            prefix: studioService.prefix,
            label: row.name ?? row.subdomain,
            claimedAt: row.claimedAt,
            status: row.status,
          });
        }

        // Batch-resolve readiness in a single query — no per-env N+1.
        //
        // An enabled website endpoint is NOT sufficient on its own: a warm-pool
        // pod announces its website endpoint BEFORE it's claimed, then RESTARTS
        // on claim (Reloader picks up new ADMINS+key). Reading that stale
        // pre-claim announcement would report "ready" while the pod is actually
        // restarting. So a claimed env is only ready once an enabled website
        // endpoint has been (re)announced at/after its `claimedAt` — i.e. the
        // endpoint's `lastSeen` is fresh relative to the claim. Never-claimed
        // (cold-created) envs have no such race, so they keep the old rule.
        const claimedAtByEnv = new Map<string, string | null>(
          matched.map((m) => [m.id, m.claimedAt]),
        );
        const readyKeys = new Set<string>();
        const matchedEnvIds = matched.map((m) => m.id);
        if (matchedEnvIds.length > 0) {
          const endpoints = await db
            .selectFrom("clint_runtime_endpoints")
            .select(["documentId", "prefix", "type", "status", "lastSeen"])
            .where("documentId", "in", matchedEnvIds)
            .execute();
          for (const ep of endpoints) {
            if (ep.type !== "website" || ep.status !== "enabled") continue;
            const claimedAt = claimedAtByEnv.get(ep.documentId) ?? null;
            if (claimedAt && !isFresherThanClaim(ep.lastSeen, claimedAt)) {
              // Stale pre-claim announcement — pod is (re)starting post-claim.
              continue;
            }
            readyKeys.add(`${ep.documentId}|${ep.prefix}`);
          }
        }

        // Batch-load cached brands for the matched envs (mirrors the
        // readiness batch above — no N+1). Studios whose BrandSheet has not
        // been pulled yet simply have no row → brand stays null.
        const brandRows =
          matchedEnvIds.length > 0
            ? await db
                .selectFrom("studio_brand")
                .select(["documentId", "name", "maxim", "concept"])
                .where("documentId", "in", matchedEnvIds)
                .execute()
            : [];
        const brandByEnv = new Map(brandRows.map((b) => [b.documentId, b]));

        return matched.map((m) => ({
          envId: m.id,
          subdomain: m.subdomain,
          prefix: m.prefix,
          label: m.label,
          brand: (() => {
            const b = brandByEnv.get(m.id);
            return b?.name
              ? {
                  title: b.name,
                  tagline: b.maxim ?? null,
                  description: b.concept ?? null,
                }
              : null;
          })(),
          // STOPPED = housekeeping sleep: surface a distinct 'sleeping' state so
          // the dashboard can show 💤 (and the card opens the host, where the
          // activator shows the wake spinner). Otherwise fall back to the
          // website-endpoint readiness check.
          status:
            m.status === "STOPPED"
              ? "sleeping"
              : readyKeys.has(`${m.id}|${m.prefix}`)
                ? "ready"
                : "booting",
        }));
      },

      viewer: (_parent: unknown, _args: unknown, ctx: AuthAwareContext) => {
        const address = ctx.user?.address?.toLowerCase() ?? null;
        const isAdmin = callerIsAdmin(ctx, address);
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
      environmentDumps: dumpResolvers.Query.environmentDumps,
    },

    Mutation: {
      syncEnvironmentOrg: async (
        _parent: unknown,
        { environmentId }: { environmentId: string },
        ctx: AuthAwareContext,
      ) => {
        const caller = ctx.user?.address.toLowerCase();
        if (!caller) throw new Error("UNAUTHENTICATED");
        const isAdmin = callerIsAdmin(ctx, caller);
        const env = await loadOrgEnv(environmentId);
        if (!env) throw new Error("ENV_NOT_FOUND");
        const who = { address: caller, isAdmin };
        if (!env.ownerOrgId) {
          // An unowned env is claimed by the first signed action (reducer auto-claim).
          if (!env.owner) return { environmentId, ownerOrgId: null, canOperate: true, canView: true };
          const own = await access.canOperate(who, env);
          return { environmentId, ownerOrgId: null, canOperate: own, canView: own };
        }
        const operate = await access.canOperate(who, env);
        const view = operate || (await access.canView(who, env));
        // Admins operate through the admin bypass, not as org operators.
        let canOperateNow = operate;
        // The mode is part of the key: a viewer promoted to publisher syncs at once.
        const key = `${caller}|${env.id}|${operate ? "operate" : "view"}`;
        if (config.orgSync && !isAdmin && view && !orgSyncLimiter.limited(key)) {
          try {
            if (operate) {
              const out = await syncEnvironmentOrgOnce(config.orgSync, env, [caller]);
              // Not synced (outage): only an existing operator may sign now.
              if (out.result === "SKIPPED") canOperateNow = out.operators.includes(caller);
              else orgSyncLimiter.mark(key);
            } else {
              await grantViewer(config.orgSync, env, caller);
              orgSyncLimiter.mark(key);
            }
          } catch (err) {
            console.warn(`[org-sync] syncEnvironmentOrg ${env.id}:`, err);
            if (operate) canOperateNow = parseOperators(env.orgOperators).map((a) => a.toLowerCase()).includes(caller);
          }
        }
        return { environmentId, ownerOrgId: env.ownerOrgId, canOperate: canOperateNow, canView: view };
      },

      setEnvironmentOrg: async (
        _parent: unknown,
        { environmentId, orgId }: { environmentId: string; orgId: string },
        ctx: AuthAwareContext,
      ) => {
        const caller = ctx.user?.address.toLowerCase();
        if (!caller) throw new Error("UNAUTHENTICATED");
        const org = orgId.trim();
        if (!org) throw new Error("ORG_ID_REQUIRED");
        const env = await loadOrgEnv(environmentId);
        if (!env) throw new Error("ENV_NOT_FOUND");
        // One-way: an org env never goes back (or elsewhere) through this call.
        if (env.ownerOrgId) throw new Error("ALREADY_ORG_OWNED");
        if (env.appId) throw new Error("APP_ENVIRONMENT");
        if (env.status && RELEASED_STATUSES.has(env.status)) throw new Error("ENV_NOT_ACTIVE");
        // Only the env's own (personal) owner hands it over: no admin bypass,
        // so nobody can pull someone else's env into an organisation. In the
        // org they need publisher capability for a standalone env (PUBLISHER+).
        const isOwner = !!env.owner && env.owner.toLowerCase() === caller;
        const publishesInOrg =
          isOwner &&
          (await access.canOperate({ address: caller, isAdmin: false }, { owner: null, ownerOrgId: org, appId: null }));
        if (!publishesInOrg) throw new Error("FORBIDDEN");
        const sync = config.orgSync;
        const perm = sync?.perm ?? null;
        const opts = sync ? orgProtectionOptions(sync) : null;
        await withEnvLock(env.id, async () => {
          // The read model lags behind dispatches: decide again on the
          // document (or the re-read row) under the lock, so a second call
          // right after a hand-over cannot move the env on to another org.
          const fresh = sync?.readOrgState ? await sync.readOrgState(env.id) : await loadOrgEnv(environmentId);
          if (!fresh) throw new Error("ENV_NOT_FOUND");
          if (fresh.ownerOrgId) throw new Error("ALREADY_ORG_OWNED");
          if (fresh.owner?.toLowerCase() !== caller) throw new Error("FORBIDDEN");
          // Restrict the system-only operations before the hand-over and
          // announce it, so the change is recognised as Vetra's own…
          if (perm && opts) {
            await protectEnvironment(perm, { id: env.id, owner: env.owner, ownerOrgId: null }, opts);
          }
          if (sync) await expectOrgHandover(sync.db, env.id, org);
          try {
            await dispatch(env.id, "SET_OWNER_ORG", { ownerOrgId: org, operators: [caller] });
          } catch (err) {
            // A failed dispatch leaves no announcement behind (parked M1).
            if (sync) {
              await withdrawOrgHandover(sync.db, env.id, org).catch((e: unknown) =>
                console.warn(`[org-sync] withdrawing the hand-over of ${env.id} failed:`, e),
              );
            }
            throw err;
          }
          // …then move the document to the service identity, so the former
          // owner keeps no ADMIN (the hook and reconciler retry on failure).
          if (perm && opts) {
            try {
              await protectEnvironment(perm, { id: env.id, owner: env.owner, ownerOrgId: org }, opts);
            } catch (err) {
              console.warn(`[org-sync] setEnvironmentOrg protection ${env.id}:`, err);
            }
          }
        });
        if (config.orgSync) {
          // The hand-over is done; a failed first sync is caught up by the job.
          try {
            await syncEnvironmentOrgOnce(config.orgSync, { ...env, ownerOrgId: org, orgOperators: JSON.stringify([caller]) });
          } catch (err) {
            console.warn(`[org-sync] setEnvironmentOrg ${env.id}:`, err);
          }
        }
        return { environmentId, ownerOrgId: org, canOperate: true, canView: true };
      },

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
        const isAdmin = callerIsAdmin(ctx, callerAddress);

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
          .select([
            "id",
            "name",
            "subdomain",
            "tenantId",
            "customDomain",
            "status",
            "owner",
            "createdBy",
            "ownerOrgId",
            "orgOperators",
            "appId",
          ])
          .where("id", "=", args.documentId)
          .executeTakeFirst()) as EnvSummaryRow | undefined;
        if (!envRow) {
          throw new Error("ENV_NOT_FOUND");
        }

        // Owner (personal), covering publisher (org) or admin.
        if (!(await access.canOperate({ address: callerAddress, isAdmin }, envRow))) {
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
          .select([
            "id",
            "name",
            "subdomain",
            "tenantId",
            "customDomain",
            "status",
            "owner",
            "createdBy",
            "ownerOrgId",
            "orgOperators",
            "appId",
          ])
          .where("id", "=", args.documentId)
          .executeTakeFirst()) as EnvSummaryRow | undefined;
        const out = refreshed ?? envRow;
        return { ...out, orgOperators: parseOperators(out.orgOperators) };
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
        const isAdmin = callerIsAdmin(ctx, callerAddress);

        const envRow = (await envDb
          .selectFrom("environments")
          .select([
            "id",
            "name",
            "tenantId",
            "status",
            "services",
            "owner",
            "autoUpdateChannel",
            "ownerOrgId",
            "appId",
          ])
          .where("id", "=", documentId)
          .executeTakeFirst()) as
          | (EnvForBump & EnvAccessFields & { autoUpdateChannel: string | null })
          | undefined;
        if (!envRow) throw new Error("ENV_NOT_FOUND");

        if (!(await access.canOperate({ address: callerAddress, isAdmin }, envRow))) {
          throw new Error("FORBIDDEN");
        }

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
        const isAdmin = callerIsAdmin(ctx, callerAddress);

        const envRow = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "tenantId", "status", "services", "owner", "ownerOrgId", "appId"])
          .where("id", "=", documentId)
          .executeTakeFirst()) as (EnvForBump & EnvAccessFields) | undefined;
        if (!envRow) throw new Error("ENV_NOT_FOUND");
        if (!(await access.canOperate({ address: callerAddress, isAdmin }, envRow))) {
          throw new Error("FORBIDDEN");
        }

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
      requestEnvironmentDump: dumpResolvers.Mutation.requestEnvironmentDump,
      cancelEnvironmentDump: dumpResolvers.Mutation.cancelEnvironmentDump,
      restartEnvironmentService:
        restartResolvers.Mutation.restartEnvironmentService,
      setDefaultPackageRegistry:
        packageRegistryResolvers.Mutation.setDefaultPackageRegistry,
    },

    ReleaseHistoryEntry: {},
    ReleaseIndexEntry: {},
    ClintRuntimeEndpointsForPrefix: {},
    ClintRuntimeEndpoint: {},
  };
}

/** Shape of environments-table row the bump helpers read. */
export type EnvForBump = {
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

/** Subset of the `environments` row read by `myStudioProducts`. */
type StudioEnvRow = {
  id: string;
  name: string | null;
  subdomain: string | null;
  services: string | null;
  status: string | null;
  packages: string | null;
  claimedAt: string | null;
};

/**
 * True iff a CLINT endpoint announcement (`lastSeen`) is at/after the env's
 * `claimedAt` — i.e. the endpoint was (re)announced post-claim and isn't a
 * stale warm-pool announcement from before the claim-triggered restart. Both
 * are ISO-8601 timestamps from the processor; compared as epoch millis (UTC,
 * timezone-agnostic). A null/unparseable `lastSeen` yields NaN, which compares
 * false → treated as not-fresh (booting), the safe default.
 */
function isFresherThanClaim(
  lastSeen: string | null,
  claimedAt: string,
): boolean {
  const seen = lastSeen ? new Date(lastSeen).getTime() : NaN;
  const claimed = new Date(claimedAt).getTime();
  return seen >= claimed;
}

/**
 * Parse the env's `services` JSON into the fields `myStudioProducts` needs.
 * Each service is `{ type, prefix, enabled, config?: { package?: { name } } }`.
 * `packageName` is null when the service carries no inline package config.
 */
function parseEnvStudioServices(
  raw: string | null,
): Array<{ type: string; prefix: string; enabled: boolean; packageName: string | null }> {
  try {
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      type?: string;
      prefix?: string;
      enabled?: boolean;
      config?: { package?: { name?: string } };
    }>;
    return parsed.map((s) => ({
      type: String(s.type ?? ""),
      prefix: String(s.prefix ?? ""),
      enabled: !!s.enabled,
      packageName: s.config?.package?.name ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Parse the env's `packages` JSON into the full shape `myEnvironments`'
 * VetraCloudEnvPackage returns (registry + name + version), for the env card's
 * package count / version display.
 */
function parseEnvSummaryPackages(
  raw: string | null,
): Array<{ registry: string | null; name: string; version: string | null }> {
  try {
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      registry?: string | null;
      name?: string;
      version?: string | null;
    }>;
    return parsed
      .filter((p) => !!p.name)
      .map((p) => ({
        registry: p.registry ?? null,
        name: String(p.name),
        version: p.version ?? null,
      }));
  } catch {
    return [];
  }
}

/**
 * Parse the env's `services` JSON into the VetraCloudEnvServiceSummary shape
 * (type + prefix + enabled) `myEnvironments` returns, for the env card's
 * service list + Visit link.
 */
function parseEnvSummaryServices(
  raw: string | null,
): Array<{ type: string; prefix: string | null; enabled: boolean }> {
  try {
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      type?: string;
      prefix?: string;
      enabled?: boolean;
    }>;
    return parsed.map((s) => ({
      type: String(s.type ?? ""),
      prefix: s.prefix ?? null,
      enabled: !!s.enabled,
    }));
  } catch {
    return [];
  }
}

/** Parse the env's `packages` JSON array of `{ name, version }`. */
function parseEnvPackages(raw: string | null): Array<{ name: string }> {
  try {
    const parsed = JSON.parse(raw ?? "[]") as Array<{ name?: string }>;
    return parsed
      .filter((p) => !!p.name)
      .map((p) => ({ name: String(p.name) }));
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
export async function bumpEnvToTag(
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

/** The environments-row columns the org-aware access check reads. */
type EnvAccessFields = {
  owner: string | null;
  ownerOrgId: string | null;
  appId: string | null;
};

type EnvSummaryRow = EnvAccessFields & {
  id: string;
  name: string | null;
  subdomain: string | null;
  tenantId: string | null;
  customDomain: string | null;
  status: string | null;
  createdBy: string | null;
  /** JSON text in the read model; parsed before it is returned. */
  orgOperators: string | null;
};
