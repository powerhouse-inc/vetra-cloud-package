import { resolve4 } from "node:dns/promises";
import type { Kysely } from "kysely";
import type {
  EnvironmentStatus,
  EnvironmentPods,
  EnvironmentEvents,
  ObservabilityDB,
} from "./db/schema.js";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function classifyPodService(podName: string): string {
  if (podName.includes("connect")) return "CONNECT";
  if (podName.includes("switchboard")) return "SWITCHBOARD";
  return "OTHER";
}

/** Uppercase enum values to match GraphQL schema (K8s returns Mixed case).
 *  Handles camelCase (e.g. OutOfSync → OUT_OF_SYNC) and spaces. */
function toUpperEnum(val: string): string {
  return val
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/ /g, "_");
}

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

export async function upsertPod(
  db: Kysely<ObservabilityDB>,
  row: EnvironmentPods,
): Promise<void> {
  await db
    .insertInto("environment_pods")
    .values(row)
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        phase: row.phase,
        ready: row.ready,
        restartCount: row.restartCount,
        service: row.service,
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
          onEvent(phase, obj).catch((err: unknown) => {
            console.warn(`[watcher:${label}] event handler error`, err);
          });
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
// Custom domain validation helpers
// ---------------------------------------------------------------------------

interface DomainCheck {
  domainResolves: number | null;
  tlsCertValid: number | null;
  tlsCertExpiresAt: string | null;
}

async function checkCustomDomain(
  kc: { makeApiClient<T>(apiClass: new (...args: unknown[]) => T): T },
  coreApi: { readNamespacedSecret(params: { name: string; namespace: string }): Promise<unknown> },
  tenantId: string,
): Promise<DomainCheck> {
  const result: DomainCheck = {
    domainResolves: null,
    tlsCertValid: null,
    tlsCertExpiresAt: null,
  };

  try {
    const { NetworkingV1Api } = await import("@kubernetes/client-node");
    const networkingApi = kc.makeApiClient(NetworkingV1Api);

    const ingressResponse = await networkingApi.listNamespacedIngress({ namespace: tenantId });
    const ingresses = ingressResponse as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: {
          tls?: Array<{ hosts?: string[]; secretName?: string }>;
          rules?: Array<{ host?: string }>;
        };
      }>;
    };

    const customIngress = ingresses.items?.find((ing) =>
      ing.metadata?.name?.includes("-custom-"),
    );
    if (!customIngress) return result;

    const customHost = customIngress.spec?.rules?.[0]?.host;
    if (!customHost) return result;

    // DNS check
    try {
      const addresses = await resolve4(customHost);
      result.domainResolves = addresses.length > 0 ? 1 : 0;
    } catch {
      result.domainResolves = 0;
    }

    // TLS check — read the secret created by cert-manager
    const tlsSecretName = customIngress.spec?.tls?.[0]?.secretName;
    if (tlsSecretName) {
      try {
        const secret = (await coreApi.readNamespacedSecret({
          name: tlsSecretName,
          namespace: tenantId,
        })) as {
          data?: { "tls.crt"?: string };
        };

        const certB64 = secret.data?.["tls.crt"];
        if (certB64) {
          const pem = Buffer.from(certB64, "base64").toString("utf-8");
          const expiresAt = extractCertExpiry(pem);
          if (expiresAt) {
            result.tlsCertExpiresAt = expiresAt.toISOString();
            result.tlsCertValid = expiresAt > new Date() ? 1 : 0;
          } else {
            result.tlsCertValid = 1;
          }
        } else {
          result.tlsCertValid = 0;
        }
      } catch {
        result.tlsCertValid = 0;
      }
    }
  } catch (err) {
    console.warn(`[domain-check] error checking custom domain for ${tenantId}:`, err);
  }

  return result;
}

/** Extract the notAfter date from a PEM certificate. */
function extractCertExpiry(pem: string): Date | null {
  try {
    // Use Node's built-in X509Certificate (available since Node 15)
    const { X509Certificate } = require("node:crypto") as typeof import("node:crypto");
    const cert = new X509Certificate(pem);
    return new Date(cert.validTo);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (lists current state and upserts to DB)
// ---------------------------------------------------------------------------

async function reconcile(
  db: Kysely<ObservabilityDB>,
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
          conditions?: Array<{ type?: string }>;
        };
      }>;
    };

    for (const app of appsBody.items ?? []) {
      const tenantId = app.metadata?.labels?.["tenant"];
      if (!tenantId) continue;

      const syncStatus = app.status?.sync?.status ?? "Unknown";
      const healthStatus = app.status?.health?.status ?? "Unknown";
      const lastSyncedAt = app.status?.operationState?.finishedAt ?? null;
      const message =
        app.status?.health?.message ??
        app.status?.operationState?.message ??
        null;
      const driftDetected = (app.status?.conditions ?? []).some(
        (c) => c.type === "ComparisonError",
      )
        ? 1
        : 0;

      const domainCheck = await checkCustomDomain(kc, coreApi, tenantId);

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

    // List all pods across all namespaces (filtered by tenant namespace in DB)
    const podsResponse = await coreApi.listPodForAllNamespaces({});

    const podsBody = podsResponse as {
      items?: Array<{
        metadata?: { name?: string; namespace?: string; uid?: string };
        status?: {
          phase?: string;
          containerStatuses?: Array<{
            ready?: boolean;
            restartCount?: number;
          }>;
        };
      }>;
    };

    for (const pod of podsBody.items ?? []) {
      const tenantId = pod.metadata?.namespace;
      const name = pod.metadata?.name;
      if (!tenantId || !name) continue;

      const containerStatuses = pod.status?.containerStatuses ?? [];
      const ready = containerStatuses.every((cs) => cs.ready) ? 1 : 0;
      const restartCount = containerStatuses.reduce(
        (sum, cs) => sum + (cs.restartCount ?? 0),
        0,
      );

      await upsertPod(db, {
        id: `${tenantId}/${name}`,
        tenantId,
        name,
        service: classifyPodService(name),
        phase: toUpperEnum(pod.status?.phase ?? "Unknown"),
        ready,
        restartCount,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn("[reconcile] error during reconciliation", err);
  }
}

// ---------------------------------------------------------------------------
// startWatchers
// ---------------------------------------------------------------------------

export function startWatchers(deps: WatcherDeps): WatcherHandle {
  const { db, k8sToken, k8sApiUrl = "" } = deps;

  const watcherAborts: Array<{ abort(): void }> = [];

  // Reconciliation interval (60 seconds)
  const intervalId = setInterval(() => {
    void reconcile(db, k8sToken, k8sApiUrl);
  }, 60_000);

  // Run an initial reconcile
  void reconcile(db, k8sToken, k8sApiUrl);

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
              conditions?: Array<{ type?: string }>;
            };
          };

          const tenantId = app.metadata?.labels?.["tenant"];
          if (!tenantId) return;

          const syncStatus = app.status?.sync?.status ?? "Unknown";
          const healthStatus = app.status?.health?.status ?? "Unknown";
          const lastSyncedAt = app.status?.operationState?.finishedAt ?? null;
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
        async (_phase: string, obj: unknown) => {
          const pod = obj as {
            metadata?: { name?: string; namespace?: string };
            status?: {
              phase?: string;
              containerStatuses?: Array<{
                ready?: boolean;
                restartCount?: number;
              }>;
            };
          };

          const tenantId = pod.metadata?.namespace;
          const name = pod.metadata?.name;
          if (!tenantId || !name) return;

          const containerStatuses = pod.status?.containerStatuses ?? [];
          const ready = containerStatuses.every((cs) => cs.ready) ? 1 : 0;
          const restartCount = containerStatuses.reduce(
            (sum, cs) => sum + (cs.restartCount ?? 0),
            0,
          );

          await upsertPod(db, {
            id: `${tenantId}/${name}`,
            tenantId,
            name,
            service: classifyPodService(name),
            phase: toUpperEnum(pod.status?.phase ?? "Unknown"),
            ready,
            restartCount,
            updatedAt: new Date().toISOString(),
          });
        },
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
