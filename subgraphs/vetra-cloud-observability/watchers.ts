import { resolve4 } from "node:dns/promises";
import { X509Certificate } from "node:crypto";
import type { KubeConfig } from "@kubernetes/client-node";
import type { Kysely } from "kysely";
import type {
  EnvironmentStatus,
  EnvironmentPods,
  EnvironmentEvents,
  ObservabilityDB,
} from "./db/schema.js";
import { withTracingSuppressed } from "./trace-suppress.js";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Map the chart's `app.kubernetes.io/component` label to the
 * TenantService enum used by the GraphQL schema. Unrecognised
 * components (clint agents, registry, helper pods, pre-chart legacy
 * pods without the label) collapse to OTHER.
 */
export function classifyPodService(component: string | null | undefined): string {
  if (component === "connect") return "CONNECT";
  if (component === "switchboard") return "SWITCHBOARD";
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
        component: row.component,
        agent: row.agent,
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
// Custom domain validation helpers
// ---------------------------------------------------------------------------

interface DomainCheck {
  domainResolves: number | null;
  tlsCertValid: number | null;
  tlsCertExpiresAt: string | null;
}

/**
 * Report aggregate DNS + TLS status for the env's configured custom domain.
 *
 * Matches every Ingress in the tenant namespace whose host is either exactly
 * `customDomain` (apex mode — e.g. `admin.vetra.io` itself) or ends with
 * `.<customDomain>` (non-apex mode — e.g. `switchboard.admin.vetra.io`). Runs
 * a DNS resolution and TLS secret inspection per matched ingress and
 * aggregates: `tlsCertValid` / `domainResolves` come back green only if every
 * matched ingress is green, red if any fail, null if nothing matches.
 */
async function checkCustomDomain(
  kc: Pick<KubeConfig, "makeApiClient">,
  coreApi: { readNamespacedSecret(params: { name: string; namespace: string }): Promise<unknown> },
  tenantId: string,
  customDomain: string | null,
): Promise<DomainCheck> {
  const result: DomainCheck = {
    domainResolves: null,
    tlsCertValid: null,
    tlsCertExpiresAt: null,
  };

  if (!customDomain) return result;

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

    const suffix = `.${customDomain}`;
    const matching = (ingresses.items ?? []).filter((ing) => {
      const host = ing.spec?.rules?.[0]?.host;
      return !!host && (host === customDomain || host.endsWith(suffix));
    });
    if (matching.length === 0) return result;

    let resolvesAll = true;
    let certsAllValid = true;
    let sawAnyCert = false;
    let earliestExpiry: Date | null = null;

    for (const ing of matching) {
      const host = ing.spec!.rules![0].host!;

      // DNS check
      try {
        const addresses = await resolve4(host);
        if (addresses.length === 0) resolvesAll = false;
      } catch {
        resolvesAll = false;
      }

      // TLS check — read cert-manager-created Secret
      const tlsSecretName = ing.spec?.tls?.[0]?.secretName;
      if (!tlsSecretName) {
        // Ingress without TLS declared — can't judge cert.
        continue;
      }
      try {
        const secret = (await coreApi.readNamespacedSecret({
          name: tlsSecretName,
          namespace: tenantId,
        })) as { data?: { "tls.crt"?: string } };

        const certB64 = secret.data?.["tls.crt"];
        if (!certB64) {
          certsAllValid = false;
          continue;
        }
        sawAnyCert = true;
        const pem = Buffer.from(certB64, "base64").toString("utf-8");
        const expiresAt = extractCertExpiry(pem);
        if (!expiresAt) continue; // couldn't parse, don't penalise
        if (expiresAt <= new Date()) certsAllValid = false;
        if (earliestExpiry === null || expiresAt < earliestExpiry) {
          earliestExpiry = expiresAt;
        }
      } catch {
        // Secret not found yet (cert-manager still issuing, or was deleted)
        certsAllValid = false;
      }
    }

    result.domainResolves = resolvesAll ? 1 : 0;
    result.tlsCertValid = sawAnyCert ? (certsAllValid ? 1 : 0) : 0;
    result.tlsCertExpiresAt = earliestExpiry ? earliestExpiry.toISOString() : null;
  } catch (err) {
    console.warn(`[domain-check] error checking custom domain for ${tenantId}:`, err);
  }

  return result;
}

/** Extract the notAfter date from a PEM certificate. */
function extractCertExpiry(pem: string): Date | null {
  try {
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

    for (const app of appsBody.items ?? []) {
      const tenantId = app.metadata?.labels?.["tenant"];
      if (!tenantId) continue;

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

      const domainCheck = await checkCustomDomain(kc, coreApi, tenantId, customDomain);

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
        metadata?: {
          name?: string;
          namespace?: string;
          uid?: string;
          labels?: Record<string, string>;
        };
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
      const labels = pod.metadata?.labels ?? {};
      const component = labels["app.kubernetes.io/component"] ?? null;
      const agent = labels["clint.vetra.io/agent"] ?? null;

      await upsertPod(db, {
        id: `${tenantId}/${name}`,
        tenantId,
        name,
        service: classifyPodService(component),
        component,
        agent,
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
  const { db, envDb, k8sToken, k8sApiUrl = "" } = deps;

  const watcherAborts: Array<{ abort(): void }> = [];

  // Reconciliation interval (60 seconds). Suppress tracing for the whole
  // reconcile — its pg queries + k8s API calls are fixed-cadence poller
  // work, not request-driven, and scale O(tenant-count). See
  // trace-suppress.ts.
  const intervalId = setInterval(() => {
    void withTracingSuppressed(() =>
      reconcile(db, envDb, k8sToken, k8sApiUrl),
    );
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
            metadata?: {
              name?: string;
              namespace?: string;
              labels?: Record<string, string>;
            };
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
          const labels = pod.metadata?.labels ?? {};
          const component = labels["app.kubernetes.io/component"] ?? null;
          const agent = labels["clint.vetra.io/agent"] ?? null;

          await upsertPod(db, {
            id: `${tenantId}/${name}`,
            tenantId,
            name,
            service: classifyPodService(component),
            component,
            agent,
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
