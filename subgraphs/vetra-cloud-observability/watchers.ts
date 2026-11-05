import type { KubeConfig } from "@kubernetes/client-node";
import type { Kysely } from "kysely";
import type {
  EnvironmentStatus,
  EnvironmentEvents,
  ObservabilityDB,
} from "./db/schema.js";
import { withTracingSuppressed } from "./trace-suppress.js";
import { checkCustomDomain, type DomainCheck } from "./domain-check.js";
import {
  handlePodWatchEvent,
  reconcilePods,
  toUpperEnum,
  type PodLike,
} from "./pod-sync.js";

export {
  classifyPodService,
  deletePod,
  handlePodWatchEvent,
  podToRow,
  reconcilePods,
  upsertPod,
  type PodLike,
  type ReconcilePodsResult,
} from "./pod-sync.js";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export async function upsertEnvironmentStatus(
  db: Kysely<ObservabilityDB>,
  row: EnvironmentStatus,
): Promise<void> {
  await db
    .insertInto("environment_status")
    .values(row)
    .onConflict((oc) =>
      oc.column("tenantId").doUpdateSet({
        argoSyncStatus: row.argoSyncStatus,
        argoHealthStatus: row.argoHealthStatus,
        argoLastSyncedAt: row.argoLastSyncedAt,
        argoMessage: row.argoMessage,
        configDriftDetected: row.configDriftDetected,
        tlsCertValid: row.tlsCertValid,
        tlsCertExpiresAt: row.tlsCertExpiresAt,
        domainResolves: row.domainResolves,
        updatedAt: row.updatedAt,
      }),
    )
    .execute();
}

export async function insertEvent(
  db: Kysely<ObservabilityDB>,
  row: EnvironmentEvents,
): Promise<void> {
  await db
    .insertInto("environment_events")
    .values(row)
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

export async function pruneEvents(
  db: Kysely<ObservabilityDB>,
  tenantId: string,
  keepCount = 50,
): Promise<void> {
  const topIds = await db
    .selectFrom("environment_events")
    .select("id")
    .where("tenantId", "=", tenantId)
    .orderBy("timestamp", "desc")
    .limit(keepCount)
    .execute();

  if (topIds.length < keepCount) return;

  await db
    .deleteFrom("environment_events")
    .where("tenantId", "=", tenantId)
    .where(
      "id",
      "not in",
      topIds.map((r) => r.id),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// Watcher lifecycle types
// ---------------------------------------------------------------------------

export interface ReactorClient {
  addActions(
    documentId: string,
    actions: Array<{ type: string; input: Record<string, unknown> }>,
  ): Promise<void>;
}

export interface WatcherDeps {
  db: Kysely<ObservabilityDB>;
  /** Kysely handle for the processor's `vetra-cloud-environments` namespace —
   *  used to resolve each tenant's configured `customDomain` so the domain
   *  check targets the right ingress instead of guessing by name. */
  envDb: Kysely<any>;
  k8sToken: string;
  k8sApiUrl?: string;
  reactorClient?: ReactorClient;
  /** Map of tenantId → documentId for dispatching document actions */
  tenantDocumentMap?: Map<string, string>;
}

export interface WatcherHandle {
  stop(): void;
}

// ---------------------------------------------------------------------------
// Internal: reconnecting watch helper
// ---------------------------------------------------------------------------

type WatchCallback = (type: string, obj: unknown) => Promise<void>;

function watchWithReconnect(
  watch: {
    watch(
      path: string,
      queryParams: Record<string, string>,
      callback: (phase: string, obj: unknown) => void,
      done: (err: unknown) => void,
    ): Promise<{ abort(): void }>;
  },
  path: string,
  queryParams: Record<string, string>,
  onEvent: WatchCallback,
  label: string,
): { abort(): void } {
  let active = true;
  let consecutiveFailures = 0;
  let requestHandle: { abort(): void } | null = null;

  function start() {
    if (!active) return;

    watch
      .watch(
        path,
        queryParams,
        (phase: string, obj: unknown) => {
          consecutiveFailures = 0;
          // Watch-event upserts are background poller work — suppress their
          // spans so they don't each become a root transaction. See
          // trace-suppress.ts.
          withTracingSuppressed(() => onEvent(phase, obj)).catch(
            (err: unknown) => {
              console.warn(`[watcher:${label}] event handler error`, err);
            },
          );
        },
        (err: unknown) => {
          if (!active) return;
          if (err) {
            consecutiveFailures++;
            console.warn(
              `[watcher:${label}] watch error (consecutive=${consecutiveFailures})`,
              err,
            );
          }
          if (consecutiveFailures >= 3) {
            console.warn(
              `[watcher:${label}] 3 consecutive failures, stopping watcher`,
            );
            active = false;
            return;
          }
          // reconnect
          start();
        },
      )
      .then((handle) => {
        requestHandle = handle;
      })
      .catch((err: unknown) => {
        if (!active) return;
        consecutiveFailures++;
        console.warn(`[watcher:${label}] failed to start watch`, err);
        if (consecutiveFailures >= 3) {
          console.warn(
            `[watcher:${label}] 3 consecutive failures, stopping watcher`,
          );
          active = false;
          return;
        }
        start();
      });
  }

  start();

  return {
    abort() {
      active = false;
      requestHandle?.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// Custom domain validation (logic + probes live in domain-check.ts)
// ---------------------------------------------------------------------------

/** First-rule hosts of every Ingress in the tenant namespace. */
async function listIngressHosts(
  kc: Pick<KubeConfig, "makeApiClient">,
  tenantId: string,
): Promise<string[]> {
  const { NetworkingV1Api } = await import("@kubernetes/client-node");
  const networkingApi = kc.makeApiClient(NetworkingV1Api);
  const res = (await networkingApi.listNamespacedIngress({
    namespace: tenantId,
  })) as {
    items?: Array<{ spec?: { rules?: Array<{ host?: string }> } }>;
  };
  return (res.items ?? [])
    .map((ing) => ing.spec?.rules?.[0]?.host)
    .filter((h): h is string => !!h);
}

async function checkTenantCustomDomain(
  kc: Pick<KubeConfig, "makeApiClient">,
  tenantId: string,
  customDomain: string | null,
): Promise<DomainCheck> {
  if (!customDomain) return checkCustomDomain([], null);
  try {
    return await checkCustomDomain(
      await listIngressHosts(kc, tenantId),
      customDomain,
    );
  } catch (err) {
    console.warn(
      `[domain-check] error checking custom domain for ${tenantId}:`,
      err,
    );
    return checkCustomDomain([], null);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (lists current state and upserts to DB)
// ---------------------------------------------------------------------------

async function reconcile(
  db: Kysely<ObservabilityDB>,
  envDb: Kysely<any>,
  k8sToken: string,
  k8sApiUrl: string,
): Promise<void> {
  try {
    const { KubeConfig, CustomObjectsApi, CoreV1Api } =
      await import("@kubernetes/client-node");

    const kc = new KubeConfig();
    if (k8sToken) {
      const server = k8sApiUrl || "https://kubernetes.default.svc";
      kc.loadFromOptions({
        clusters: [{ name: "cluster", server, skipTLSVerify: true }],
        users: [{ name: "user", token: k8sToken }],
        contexts: [{ name: "ctx", cluster: "cluster", user: "user" }],
        currentContext: "ctx",
      });
    } else {
      kc.loadFromCluster();
    }

    const customApi = kc.makeApiClient(CustomObjectsApi);
    const coreApi = kc.makeApiClient(CoreV1Api);

    // List ArgoCD apps
    const appsResponse: unknown = await customApi.listClusterCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      plural: "applications",
    });

    const appsBody = appsResponse as {
      items?: Array<{
        metadata?: {
          name?: string;
          labels?: Record<string, string>;
          creationTimestamp?: string;
        };
        status?: {
          sync?: { status?: string; revision?: string };
          health?: { status?: string; message?: string };
          operationState?: { finishedAt?: string; message?: string };
          reconciledAt?: string;
          conditions?: Array<{ type?: string }>;
        };
      }>;
    };

    const argoTenants = new Set<string>();
    for (const app of appsBody.items ?? []) {
      const tenantId = app.metadata?.labels?.["tenant"];
      if (!tenantId) continue;
      argoTenants.add(tenantId);

      const syncStatus = app.status?.sync?.status ?? "Unknown";
      const healthStatus = app.status?.health?.status ?? "Unknown";
      // Prefer `reconciledAt` over `operationState.finishedAt`: the latter
      // only advances when argo performs an actual sync operation, so if
      // argo reconciles a new commit and finds the manifests already match
      // the cluster, finishedAt stays stale. reconciledAt updates on every
      // reconcile (polling or webhook-triggered), which is what the
      // deployment reconciler really wants to check "has argo seen our
      // push?". Fall back to finishedAt for apps that haven't reported
      // reconciledAt yet.
      const lastSyncedAt =
        app.status?.reconciledAt ??
        app.status?.operationState?.finishedAt ??
        null;
      const message =
        app.status?.health?.message ??
        app.status?.operationState?.message ??
        null;
      const driftDetected = (app.status?.conditions ?? []).some(
        (c) => c.type === "ComparisonError",
      )
        ? 1
        : 0;

      // Fetch the env's configured custom domain so the check targets the
      // exact host the user configured (apex mode) or its <svc>.<domain>
      // additional ingresses (non-apex) — not whichever ingress happens to
      // have "-custom-" in its name.
      const envRow = (await envDb
        .selectFrom("environments")
        .select(["customDomain"])
        .where("tenantId", "=", tenantId)
        .executeTakeFirst()) as { customDomain: string | null } | undefined;
      const customDomain = envRow?.customDomain ?? null;

      const domainCheck = await checkTenantCustomDomain(
        kc,
        tenantId,
        customDomain,
      );

      await upsertEnvironmentStatus(db, {
        tenantId,
        argoSyncStatus: toUpperEnum(syncStatus),
        argoHealthStatus: toUpperEnum(healthStatus),
        argoLastSyncedAt: lastSyncedAt,
        argoMessage: message,
        configDriftDetected: driftDetected,
        tlsCertValid: domainCheck.tlsCertValid,
        tlsCertExpiresAt: domainCheck.tlsCertExpiresAt,
        domainResolves: domainCheck.domainResolves,
        updatedAt: new Date().toISOString(),
      });
    }

    // List all pods across all namespaces, upsert them and prune rows of
    // pods that are gone. A tenant from the ArgoCD listing whose namespace
    // currently has no pods (scaled to zero) is in scope too.
    await reconcilePods(
      db,
      async () => {
        const res = (await coreApi.listPodForAllNamespaces({})) as {
          items?: PodLike[];
        };
        if (!Array.isArray(res.items)) {
          throw new Error("pod listing returned no items array");
        }
        return res.items;
      },
      { extraTenants: argoTenants },
    );
  } catch (err) {
    console.warn("[reconcile] error during reconciliation", err);
  }
}

// ---------------------------------------------------------------------------
// startWatchers
// ---------------------------------------------------------------------------

export function startWatchers(deps: WatcherDeps): WatcherHandle {
  const { db, envDb, k8sToken, k8sApiUrl = "" } = deps;

  const watcherAborts: Array<{ abort(): void }> = [];

  // Reconciliation interval (60 seconds). Suppress tracing for the whole
  // reconcile — its pg queries + k8s API calls are fixed-cadence poller
  // work, not request-driven, and scale O(tenant-count). See
  // trace-suppress.ts.
  const intervalId = setInterval(() => {
    void withTracingSuppressed(() => reconcile(db, envDb, k8sToken, k8sApiUrl));
  }, 60_000);

  // Run an initial reconcile
  void withTracingSuppressed(() => reconcile(db, envDb, k8sToken, k8sApiUrl));

  // Start K8s watches via dynamic import so tests don't require a live cluster
  (async () => {
    try {
      const { KubeConfig, Watch } = await import("@kubernetes/client-node");

      const kc = new KubeConfig();
      if (k8sToken) {
        const server = k8sApiUrl || "https://kubernetes.default.svc";
        kc.loadFromOptions({
          clusters: [{ name: "cluster", server, skipTLSVerify: true }],
          users: [{ name: "user", token: k8sToken }],
          contexts: [{ name: "ctx", cluster: "cluster", user: "user" }],
          currentContext: "ctx",
        });
      } else {
        // Use in-cluster SA token (mounted at /var/run/secrets/...)
        kc.loadFromCluster();
      }

      const watch = new Watch(kc);

      // ArgoCD applications watcher
      const argoAbort = watchWithReconnect(
        watch,
        "/apis/argoproj.io/v1alpha1/applications",
        {},
        async (_phase: string, obj: unknown) => {
          const app = obj as {
            metadata?: {
              labels?: Record<string, string>;
            };
            status?: {
              sync?: { status?: string };
              health?: { status?: string; message?: string };
              operationState?: { finishedAt?: string; message?: string };
              reconciledAt?: string;
              conditions?: Array<{ type?: string }>;
            };
          };

          const tenantId = app.metadata?.labels?.["tenant"];
          if (!tenantId) return;

          const syncStatus = app.status?.sync?.status ?? "Unknown";
          const healthStatus = app.status?.health?.status ?? "Unknown";
          // Prefer reconciledAt (advances on every reconcile, incl. no-op syncs)
          // over operationState.finishedAt (only set on an actual sync op, often
          // null) — matching the periodic poll path. Using finishedAt here left
          // argoLastSyncedAt null until the 60s poll, stalling the deployment
          // reconciler's "argo saw our push" check by up to a minute.
          const lastSyncedAt =
            app.status?.reconciledAt ??
            app.status?.operationState?.finishedAt ??
            null;
          const message =
            app.status?.health?.message ??
            app.status?.operationState?.message ??
            null;
          const driftDetected = (app.status?.conditions ?? []).some(
            (c) => c.type === "ComparisonError",
          )
            ? 1
            : 0;

          await upsertEnvironmentStatus(db, {
            tenantId,
            argoSyncStatus: toUpperEnum(syncStatus),
            argoHealthStatus: toUpperEnum(healthStatus),
            argoLastSyncedAt: lastSyncedAt,
            argoMessage: message,
            configDriftDetected: driftDetected,
            tlsCertValid: null,
            tlsCertExpiresAt: null,
            domainResolves: null,
            updatedAt: new Date().toISOString(),
          });

          // Also record sync/health changes as deployment events
          const eventType =
            healthStatus === "Degraded" || healthStatus === "Missing"
              ? "WARNING"
              : "NORMAL";
          const reason =
            syncStatus === "Synced" && healthStatus === "Healthy"
              ? "SyncSucceeded"
              : syncStatus === "OutOfSync"
                ? "SyncOutOfSync"
                : `${syncStatus}/${healthStatus}`;

          await insertEvent(db, {
            id: `argo-${tenantId}-${Date.now()}`,
            tenantId,
            type: eventType,
            reason,
            message: message ?? `Sync: ${syncStatus}, Health: ${healthStatus}`,
            involvedObject: `Application/${tenantId}`,
            timestamp: lastSyncedAt ?? new Date().toISOString(),
          });
          await pruneEvents(db, tenantId);
        },
        "argo-apps",
      );
      watcherAborts.push(argoAbort);

      // Pod watcher
      const podAbort = watchWithReconnect(
        watch,
        "/api/v1/pods",
        {},
        (type: string, obj: unknown) => handlePodWatchEvent(db, type, obj),
        "pods",
      );
      watcherAborts.push(podAbort);

      // Event watcher
      const eventAbort = watchWithReconnect(
        watch,
        "/api/v1/events",
        {},
        async (_phase: string, obj: unknown) => {
          const event = obj as {
            metadata?: { uid?: string };
            involvedObject?: {
              namespace?: string;
              kind?: string;
              name?: string;
            };
            type?: string;
            reason?: string;
            message?: string;
            lastTimestamp?: string;
            eventTime?: string;
          };

          const id = event.metadata?.uid;
          const tenantId = event.involvedObject?.namespace;
          if (!id || !tenantId) return;

          const involvedObject = event.involvedObject
            ? `${event.involvedObject.kind ?? ""}/${event.involvedObject.name ?? ""}`
            : "";

          await insertEvent(db, {
            id,
            tenantId,
            type: toUpperEnum(event.type ?? "Normal"),
            reason: event.reason ?? "",
            message: event.message ?? "",
            involvedObject,
            timestamp:
              event.lastTimestamp ??
              event.eventTime ??
              new Date().toISOString(),
          });

          await pruneEvents(db, tenantId);
        },
        "events",
      );
      watcherAborts.push(eventAbort);
    } catch (err) {
      console.warn(
        "[startWatchers] failed to start K8s watches, relying on reconcile loop only",
        err,
      );
    }
  })();

  return {
    stop() {
      clearInterval(intervalId);
      for (const handle of watcherAborts) {
        handle.abort();
      }
    },
  };
}
