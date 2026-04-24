import { resolve4 } from "node:dns/promises";
import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { createAction } from "document-model";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import { startWatchers, type WatcherHandle } from "./watchers.js";
import type { ObservabilityDB } from "./db/schema.js";

export class VetraCloudObservabilitySubgraph extends BaseSubgraph {
  name = "vetra-cloud-observability";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  private watcherHandle: WatcherHandle | null = null;
  private deploymentReconciler: ReturnType<typeof setInterval> | null = null;
  private ownerBackfill: ReturnType<typeof setInterval> | null = null;
  private protectionReconciler: ReturnType<typeof setInterval> | null = null;
  private challengeReconciler: ReturnType<typeof setInterval> | null = null;

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-observability",
    )) as unknown as Kysely<ObservabilityDB>;

    await up(db as Kysely<any>);

    const prometheusUrl =
      process.env.PROMETHEUS_URL ??
      "http://kube-prometheus-stack-prometheus.monitoring.svc:9090";
    const lokiUrl = process.env.LOKI_URL ?? "http://loki.monitoring.svc:3100";

    // The processor's `environments` table lives in a separate namespace.
    // The `myEnvironments` / `viewer` resolvers read from it.
    const envDb = (await this.relationalDb.createNamespace(
      "vetra-cloud-environments",
    )) as unknown as Kysely<any>;

    const dispatch = async (
      documentId: string,
      type: string,
      input: Record<string, unknown>,
    ) => {
      const action = createAction(type, input);
      await this.reactorClient.execute(documentId, "main", [action]);
    };

    this.resolvers = createResolvers(db, { prometheusUrl, lokiUrl, envDb, dispatch });

    // Start watchers using the pod's in-cluster ServiceAccount.
    //
    // We used to acquire a short-lived K8s token via OpenBao's Kubernetes
    // secrets engine, but that path is broken for cluster-scoped resources:
    // OpenBao creates a namespaced RoleBinding (even when the role is set to
    // `kubernetes_role_type: ClusterRole`) referencing the ClusterRole, which
    // is equivalent to a Role and does NOT grant cluster-wide list permission
    // on `applications.argoproj.io`. The pod's default SA already has the
    // correct ClusterRoleBinding (`staging-observability` / `vetra-observability`
    // in infrastructure/vetra-observability-rbac/rbac.yaml), so loading from
    // the pod environment is both simpler and strictly more permissive.
    //
    // Passing an empty token triggers `kc.loadFromCluster()` inside the
    // watchers (see watchers.ts). Leaving OPENBAO_ADDR configured is fine —
    // the secrets subgraph still uses it for KV v2 access.
    try {
      this.watcherHandle = startWatchers({
        db,
        envDb,
        k8sToken: "",
      });
      console.info("[observability] Watchers started (in-cluster SA)");
    } catch (err) {
      console.warn("[observability] Failed to start watchers:", err);
    }

    // Start deployment reconciler: bridges ArgoCD status → document status
    this.startDeploymentReconciler(db);

    // Start owner backfill: assigns state.owner on historical envs from createdBy.
    // Idempotent — skips rows that already have owner set or no createdBy.
    this.startOwnerBackfill();

    // Start protection reconciler: for each owned env, ensure the document is
    // marked "protected" at the reactor-api layer and the owner has an ADMIN
    // permission grant. This is what locks down direct getDocument(id) reads
    // for non-owner, non-admin users.
    this.startProtectionReconciler();

    // Start stuck-challenge reconciler: rescues cert-manager Certificates
    // whose latest HTTP-01 Challenge went invalid due to NXDOMAIN (the
    // classic "cert-manager raced external-dns on first provision") by
    // deleting the Certificate once DNS now resolves to us.
    this.startChallengeReconciler();
  }

  async onDisconnect() {
    this.watcherHandle?.stop();
    this.watcherHandle = null;
    if (this.deploymentReconciler) {
      clearInterval(this.deploymentReconciler);
      this.deploymentReconciler = null;
    }
    if (this.ownerBackfill) {
      clearInterval(this.ownerBackfill);
      this.ownerBackfill = null;
    }
    if (this.protectionReconciler) {
      clearInterval(this.protectionReconciler);
      this.protectionReconciler = null;
    }
    if (this.challengeReconciler) {
      clearInterval(this.challengeReconciler);
      this.challengeReconciler = null;
    }
  }

  /** Grace period (ms) before marking a DEPLOYING environment as failed.
   *  Services like switchboard need time for image pulls, migrations, and
   *  health-probe warm-up — ArgoCD will report DEGRADED during this window. */
  private static DEPLOYMENT_GRACE_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Periodically checks for environments in CHANGES_PUSHED/DEPLOYING status
   * and transitions them to READY/FAILED based on ArgoCD state.
   *
   * Queries the processor's environments table (via a shared DB namespace)
   * and the observability environment_status table.
   */
  private startDeploymentReconciler(observabilityDb: Kysely<ObservabilityDB>) {
    const reconcile = async () => {
      try {
        // Get the processor's environments namespace to read document states
        const envDb = (await this.relationalDb.createNamespace(
          "vetra-cloud-environments",
        )) as unknown as Kysely<any>;

        // Find environments waiting for deployment
        const pendingEnvs = (await envDb
          .selectFrom("environments")
          .select(["id", "tenantId", "status", "name", "deployingSince"])
          .where("status", "in", ["CHANGES_PUSHED", "DEPLOYING"])
          .execute()) as Array<{
          id: string;
          tenantId: string | null;
          status: string;
          name: string | null;
          deployingSince: string | null;
        }>;

        if (pendingEnvs.length === 0) return;

        for (const env of pendingEnvs) {
          if (!env.tenantId) continue;

          // Check ArgoCD status for this tenant
          const argoStatus = await observabilityDb
            .selectFrom("environment_status")
            .select(["argoSyncStatus", "argoHealthStatus", "argoLastSyncedAt"])
            .where("tenantId", "=", env.tenantId)
            .executeTakeFirst();

          if (!argoStatus) continue;

          const label = env.name ?? env.id;
          const { argoSyncStatus, argoHealthStatus, argoLastSyncedAt } = argoStatus;

          if (env.status === "CHANGES_PUSHED") {
            // Always transition to DEPLOYING on first sighting — do NOT
            // fast-path to READY based on argo health, because the cached
            // argo status at this point is almost always stale from *before*
            // our gitops push. Requiring argo to reconcile the new revision
            // before marking READY is the whole point of the DEPLOYING state.
            console.info(
              `[deployment-reconciler] ${label}: CHANGES_PUSHED → DEPLOYING (health: ${argoHealthStatus}, sync: ${argoSyncStatus})`,
            );
            const now = new Date().toISOString();
            await envDb
              .updateTable("environments")
              .set({ deployingSince: now })
              .where("id", "=", env.id)
              .execute();
            await this.dispatchAction(env.id, "MARK_DEPLOYMENT_STARTED", {});
          } else if (env.status === "DEPLOYING") {
            // Trust argo's verdict once we have evidence it has observed our
            // gitops push. Signals are:
            //   • argoLastSyncedAt (reconciledAt) > deployingSince — the
            //     strong case, argo explicitly saw the new revision.
            //   • 30s have elapsed since deployingSince — belt-and-suspenders
            //     for cases where argo's timestamps don't obviously advance
            //     (e.g. a push that renders identical manifests), which
            //     otherwise keeps the env pinned in DEPLOYING forever.
            const deployingSinceMs = env.deployingSince
              ? new Date(env.deployingSince).getTime()
              : 0;
            const argoSyncedMs = argoLastSyncedAt
              ? new Date(argoLastSyncedAt).getTime()
              : 0;
            const argoSawChange = argoSyncedMs > deployingSinceMs;
            const elapsedMs = deployingSinceMs
              ? Date.now() - deployingSinceMs
              : Infinity;
            const GRACE_FALLBACK_MS = 30_000;
            const trustworthy = argoSawChange || elapsedMs > GRACE_FALLBACK_MS;

            if (!trustworthy) {
              console.info(
                `[deployment-reconciler] ${label}: DEPLOYING, waiting for ArgoCD to reconcile ` +
                  `(argoLastSyncedAt=${argoLastSyncedAt ?? "null"}, ` +
                  `deployingSince=${env.deployingSince ?? "null"}, elapsed=${Math.round(elapsedMs / 1000)}s)`,
              );
              continue;
            }

            if (argoHealthStatus === "HEALTHY") {
              console.info(
                `[deployment-reconciler] ${label}: DEPLOYING → READY (healthy)`,
              );
              await envDb
                .updateTable("environments")
                .set({ deployingSince: null })
                .where("id", "=", env.id)
                .execute();
              await this.dispatchAction(
                env.id,
                "REPORT_DEPLOYMENT_SUCCEEDED",
                {},
              );
            } else if (argoHealthStatus === "DEGRADED") {
              const deployingSince = env.deployingSince
                ? new Date(env.deployingSince).getTime()
                : Date.now();

              // Backfill deployingSince if missing (e.g. environments already
              // DEPLOYING before this code was deployed)
              if (!env.deployingSince) {
                await envDb
                  .updateTable("environments")
                  .set({ deployingSince: new Date().toISOString() })
                  .where("id", "=", env.id)
                  .execute();
              }

              const elapsed = Date.now() - deployingSince;
              if (elapsed < VetraCloudObservabilitySubgraph.DEPLOYMENT_GRACE_MS) {
                console.info(
                  `[deployment-reconciler] ${label}: DEPLOYING, health DEGRADED — ` +
                  `waiting (${Math.round(elapsed / 1000)}s / ${VetraCloudObservabilitySubgraph.DEPLOYMENT_GRACE_MS / 1000}s grace)`,
                );
              } else {
                console.info(
                  `[deployment-reconciler] ${label}: → FAILED (${argoHealthStatus}, ` +
                  `grace period exceeded after ${Math.round(elapsed / 1000)}s)`,
                );
                await envDb
                  .updateTable("environments")
                  .set({ deployingSince: null })
                  .where("id", "=", env.id)
                  .execute();
                await this.dispatchAction(env.id, "REPORT_DEPLOYMENT_FAILED", {
                  code: argoHealthStatus,
                  message: `ArgoCD health: ${argoHealthStatus}, sync: ${argoSyncStatus}`,
                });
              }
            } else if (argoHealthStatus === "MISSING") {
              // MISSING is expected for new tenants — ArgoCD hasn't synced yet
              console.info(
                `[deployment-reconciler] ${label}: waiting (ArgoCD health: MISSING)`,
              );
            } else if (argoHealthStatus === "PROGRESSING") {
              console.info(
                `[deployment-reconciler] ${label}: waiting (ArgoCD health: PROGRESSING)`,
              );
            }
          }
        }
      } catch (err) {
        // Don't log on every tick if the processor table doesn't exist yet
        if (String(err).includes("does not exist")) return;
        console.warn("[deployment-reconciler] error:", err);
      }
    };

    // Run every 10 seconds — UI reflects status transitions within 10s of
    // the argo-side change (argo itself reacts to git pushes in ~1s via the
    // github webhook, so this is the dominant user-facing delay).
    this.deploymentReconciler = setInterval(() => void reconcile(), 10_000);
    // Run once immediately
    void reconcile();
  }

  /**
   * Seeds state.owner on historical environments by dispatching a system-signed
   * SET_OWNER action with the address from the processor's createdBy column.
   *
   * Why this works without forging signatures:
   *   The SET_OWNER reducer allows system-signed actions (no user in the signer)
   *   to set any address when state.owner is null. User-signed claims are still
   *   restricted to the signer's own address.
   *
   * Idempotent — skips rows where owner is already set or createdBy is null.
   * Runs on startup and every 5 minutes as a safety net in case a dispatch
   * failed (e.g., document was locked).
   */
  private startOwnerBackfill() {
    const backfill = async () => {
      try {
        const envDb = (await this.relationalDb.createNamespace(
          "vetra-cloud-environments",
        )) as unknown as Kysely<any>;

        const pending = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "createdBy"])
          .where("owner", "is", null)
          .where("createdBy", "is not", null)
          .execute()) as Array<{
          id: string;
          name: string | null;
          createdBy: string;
        }>;

        if (pending.length === 0) return;

        console.info(
          `[owner-backfill] Seeding owner for ${pending.length} env(s)`,
        );

        for (const env of pending) {
          // dispatchAction swallows errors; individual failures log but don't
          // abort the batch. Next tick will re-attempt anything still missing.
          await this.dispatchAction(
            env.id,
            "SET_OWNER",
            { address: env.createdBy },
            "owner-backfill",
          );
        }
      } catch (err) {
        if (String(err).includes("does not exist")) return;
        console.warn("[owner-backfill] error:", err);
      }
    };

    // Run every 5 minutes as a safety net, plus once on startup.
    this.ownerBackfill = setInterval(() => void backfill(), 5 * 60 * 1000);
    void backfill();
  }

  /**
   * Enforces document-level read protection at the reactor-api layer for every
   * env that has an owner. Idempotent:
   *   - Queries envs with owner set.
   *   - For each, reads the document's protection record.
   *   - If it isn't already { protected: true, ownerAddress: owner }, calls
   *     initializeDocumentProtection(docId, owner, true) — which sets
   *     protection + owner + grants the owner ADMIN in one shot.
   *
   * AuthorizationService behaviour after this:
   *   - supreme admins (ADMINS env) → can read/write (unchanged)
   *   - owner → can read/write (implicit ADMIN)
   *   - anyone else → 403 on getDocument / findDocuments / mutations
   *
   * Unowned envs are left alone — they stay "public" per the reducer contract.
   *
   * Runs every 60 seconds: short enough that the window between a new env
   * being claimed and being protected is acceptable, long enough to not
   * hammer the DB. The alternative (hooking the reactor's operation stream)
   * would be tighter but requires more plumbing.
   */
  private startProtectionReconciler() {
    const reconcile = async () => {
      const perm = this.documentPermissionService;
      if (!perm) return;

      try {
        const envDb = (await this.relationalDb.createNamespace(
          "vetra-cloud-environments",
        )) as unknown as Kysely<any>;

        const owned = (await envDb
          .selectFrom("environments")
          .select(["id", "name", "owner"])
          .where("owner", "is not", null)
          .execute()) as Array<{
          id: string;
          name: string | null;
          owner: string;
        }>;

        if (owned.length === 0) return;

        let initialized = 0;
        for (const env of owned) {
          try {
            const current = await perm.getDocumentProtection(env.id);
            const ownerMatches =
              current.ownerAddress?.toLowerCase() === env.owner.toLowerCase();
            if (current.protected && ownerMatches) {
              continue; // already in the correct state
            }

            // initializeDocumentProtection seeds `protected` only on first
            // insert — subsequent calls leave the flag alone. Reactor itself
            // often pre-creates a row with protected=false when the document
            // is first persisted, so we have to flip it explicitly.
            await perm.initializeDocumentProtection(env.id, env.owner, true);
            if (!current.protected) {
              await perm.setDocumentProtection(env.id, true);
            }
            if (!ownerMatches) {
              await perm.setDocumentOwner(env.id, env.owner);
              // grantPermission is idempotent per (documentId, userAddress)
              await perm.grantPermission(env.id, env.owner, "ADMIN", env.owner);
            }
            initialized++;
            const label = env.name ?? env.id;
            console.info(
              `[protection-reconciler] ${label}: protected + owner=${env.owner}`,
            );
          } catch (err) {
            console.warn(
              `[protection-reconciler] ${env.id}: init failed: ${String(err)}`,
            );
          }
        }

        if (initialized > 0) {
          console.info(
            `[protection-reconciler] initialized protection for ${initialized}/${owned.length} env(s)`,
          );
        }
      } catch (err) {
        if (String(err).includes("does not exist")) return;
        console.warn("[protection-reconciler] error:", err);
      }
    };

    // Every 60s + once on startup.
    this.protectionReconciler = setInterval(
      () => void reconcile(),
      60 * 1000,
    );
    void reconcile();
  }

  private async dispatchAction(
    documentId: string,
    type: string,
    input: Record<string, unknown>,
    logTag: string = "deployment-reconciler",
  ) {
    try {
      const action = createAction(type, input);
      await this.reactorClient.execute(documentId, "main", [action]);
      console.info(`[${logTag}] Dispatched ${type} for ${documentId}`);
    } catch (err) {
      console.error(
        `[${logTag}] Failed to dispatch ${type}: ${String(err)}`,
      );
    }
  }

  /**
   * Rescues cert-manager certs whose HTTP-01 Challenge lost the first-provision
   * race against external-dns. The flow is:
   *
   *   1. list every Challenge cluster-wide whose `status.state == "invalid"`
   *      AND whose reason mentions NXDOMAIN (the specific race we solve here,
   *      not e.g. webhook failures or network errors)
   *   2. for each, resolve4 the challenge's dnsName; if it now returns one of
   *      the cluster's LB IPs, DNS has caught up
   *   3. throttle via the `vetra.io/last-retry` annotation on the owning
   *      Certificate — skip if we already retried within LAST_RETRY_COOLDOWN
   *   4. delete the Certificate; cert-manager's Ingress-shim re-creates it
   *      on the next reconcile with a fresh Order, which now passes the
   *      HTTP-01 challenge
   *
   * With DNS-01 enabled for *.vetra.io this path shouldn't fire for our own
   * tenants; it exists for external customer domains that stay on HTTP-01.
   */
  private static CLUSTER_LB_IPS = new Set<string>([
    "138.199.129.93",
    // IPv6 equivalent lives on the same LB; resolve4 won't return it, but
    // leave it here for future documentation.
    "2a01:4f8:c01e:796::1",
  ]);
  private static LAST_RETRY_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
  private static LAST_RETRY_ANNOTATION = "vetra.io/last-retry";

  private startChallengeReconciler() {
    const reconcile = async () => {
      try {
        const { KubeConfig, CustomObjectsApi } = await import(
          "@kubernetes/client-node"
        );
        const kc = new KubeConfig();
        kc.loadFromCluster();
        const customApi = kc.makeApiClient(CustomObjectsApi);

        // List all invalid Challenges cluster-wide.
        const res = (await customApi.listClusterCustomObject({
          group: "acme.cert-manager.io",
          version: "v1",
          plural: "challenges",
        })) as {
          items?: Array<{
            metadata?: {
              name?: string;
              namespace?: string;
              ownerReferences?: Array<{ kind?: string; name?: string }>;
            };
            spec?: { dnsName?: string };
            status?: { state?: string; reason?: string };
          }>;
        };

        const stuck = (res.items ?? []).filter(
          (c) =>
            c.status?.state === "invalid" &&
            (c.status?.reason ?? "").includes("NXDOMAIN"),
        );
        if (stuck.length === 0) return;

        for (const ch of stuck) {
          const ns = ch.metadata?.namespace;
          const dnsName = ch.spec?.dnsName;
          const orderOwner = ch.metadata?.ownerReferences?.find(
            (o) => o.kind === "Order",
          )?.name;
          if (!ns || !dnsName) continue;

          // Probe current DNS.
          const addresses = await resolve4(dnsName).catch(() => [] as string[]);
          const pointsAtUs = addresses.some((ip) =>
            VetraCloudObservabilitySubgraph.CLUSTER_LB_IPS.has(ip),
          );
          if (!pointsAtUs) {
            console.info(
              `[challenge-reconciler] ${ns}/${dnsName}: DNS does not resolve to cluster LB (got ${addresses.join(",") || "none"}), skipping`,
            );
            continue;
          }

          // Walk Order → Certificate owner references (Order's owner is the
          // Certificate).
          if (!orderOwner) {
            console.info(
              `[challenge-reconciler] ${ns}/${dnsName}: challenge has no Order owner, skipping`,
            );
            continue;
          }
          const order = (await customApi
            .getNamespacedCustomObject({
              group: "acme.cert-manager.io",
              version: "v1",
              plural: "orders",
              namespace: ns,
              name: orderOwner,
            })
            .catch(() => null)) as {
            metadata?: {
              ownerReferences?: Array<{ kind?: string; name?: string }>;
            };
          } | null;
          const certName = order?.metadata?.ownerReferences?.find(
            (o) => o.kind === "Certificate",
          )?.name;
          if (!certName) {
            console.info(
              `[challenge-reconciler] ${ns}/${dnsName}: Order has no Certificate owner, skipping`,
            );
            continue;
          }

          // Cooldown check — don't hammer the same Certificate.
          const cert = (await customApi
            .getNamespacedCustomObject({
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              namespace: ns,
              name: certName,
            })
            .catch(() => null)) as {
            metadata?: { annotations?: Record<string, string> };
          } | null;
          const lastRetry =
            cert?.metadata?.annotations?.[
              VetraCloudObservabilitySubgraph.LAST_RETRY_ANNOTATION
            ];
          if (lastRetry) {
            const elapsed = Date.now() - new Date(lastRetry).getTime();
            if (
              elapsed <
              VetraCloudObservabilitySubgraph.LAST_RETRY_COOLDOWN_MS
            ) {
              console.info(
                `[challenge-reconciler] ${ns}/${certName}: last retry was ${Math.round(elapsed / 1000)}s ago, within cooldown`,
              );
              continue;
            }
          }

          // Stamp the annotation, then delete. Stamping first ensures the
          // recreated Certificate (via Ingress-shim) inherits it and the
          // next run respects the cooldown.
          console.info(
            `[challenge-reconciler] ${ns}/${certName}: DNS now resolves (${addresses.join(",")}) for ${dnsName}, deleting Certificate to retry`,
          );
          try {
            await customApi.patchNamespacedCustomObject({
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              namespace: ns,
              name: certName,
              body: {
                metadata: {
                  annotations: {
                    [VetraCloudObservabilitySubgraph.LAST_RETRY_ANNOTATION]:
                      new Date().toISOString(),
                  },
                },
              },
            });
          } catch (err) {
            console.warn(
              `[challenge-reconciler] ${ns}/${certName}: annotation patch failed: ${String(err)}`,
            );
            // fall through — deletion is still worth attempting
          }
          try {
            await customApi.deleteNamespacedCustomObject({
              group: "cert-manager.io",
              version: "v1",
              plural: "certificates",
              namespace: ns,
              name: certName,
            });
          } catch (err) {
            console.warn(
              `[challenge-reconciler] ${ns}/${certName}: delete failed: ${String(err)}`,
            );
          }
        }
      } catch (err) {
        console.warn("[challenge-reconciler] error:", err);
      }
    };

    // Every 2 minutes + once on startup.
    this.challengeReconciler = setInterval(
      () => void reconcile(),
      2 * 60 * 1000,
    );
    void reconcile();
  }

}
