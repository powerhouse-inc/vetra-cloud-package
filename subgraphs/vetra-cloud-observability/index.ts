import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { createAction } from "document-model";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import { OpenBaoClient } from "./openbao.js";
import { startWatchers, type WatcherHandle } from "./watchers.js";
import type { ObservabilityDB } from "./db/schema.js";

export class VetraCloudObservabilitySubgraph extends BaseSubgraph {
  name = "vetra-cloud-observability";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  private watcherHandle: WatcherHandle | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private deploymentReconciler: ReturnType<typeof setInterval> | null = null;
  private ownerBackfill: ReturnType<typeof setInterval> | null = null;
  private leaseId: string | null = null;
  private openbao: OpenBaoClient | null = null;
  private leaseDuration: number = 3600;

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

    this.resolvers = createResolvers(db, { prometheusUrl, lokiUrl, envDb });

    // Acquire K8s credentials and start watchers
    const openbaoAddr = process.env.OPENBAO_ADDR;
    let k8sToken: string | null = null;

    if (openbaoAddr) {
      try {
        this.openbao = new OpenBaoClient(openbaoAddr);
        await this.openbao.authenticate();
        const creds = await this.openbao.getK8sToken();
        k8sToken = creds.token;
        this.leaseId = creds.leaseId;
        this.leaseDuration = creds.leaseDuration;
        this.scheduleRenewal(creds.leaseDuration);
        console.info("[observability] Acquired K8s token via OpenBao");
      } catch (err) {
        console.warn(
          "[observability] OpenBao failed, falling back to in-cluster SA:",
          err,
        );
      }
    }

    try {
      this.watcherHandle = startWatchers({
        db,
        k8sToken: k8sToken ?? "",
      });
      console.info(
        `[observability] Watchers started (${k8sToken ? "OpenBao token" : "in-cluster SA"})`,
      );
    } catch (err) {
      console.warn("[observability] Failed to start watchers:", err);
    }

    // Start deployment reconciler: bridges ArgoCD status → document status
    this.startDeploymentReconciler(db);

    // Start owner backfill: assigns state.owner on historical envs from createdBy.
    // Idempotent — skips rows that already have owner set or no createdBy.
    this.startOwnerBackfill();
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
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
    if (this.openbao && this.leaseId) {
      try {
        await this.openbao.revokeLease(this.leaseId);
      } catch {
        /* best effort */
      }
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
            .select(["argoSyncStatus", "argoHealthStatus"])
            .where("tenantId", "=", env.tenantId)
            .executeTakeFirst();

          if (!argoStatus) continue;

          const label = env.name ?? env.id;
          const { argoSyncStatus, argoHealthStatus } = argoStatus;

          if (env.status === "CHANGES_PUSHED") {
            if (argoHealthStatus === "HEALTHY") {
              // Fast path: already healthy — go straight through DEPLOYING → READY
              console.info(
                `[deployment-reconciler] ${label}: CHANGES_PUSHED → DEPLOYING → READY (healthy)`,
              );
              await this.dispatchAction(env.id, "MARK_DEPLOYMENT_STARTED", {});
              await this.dispatchAction(
                env.id,
                "REPORT_DEPLOYMENT_SUCCEEDED",
                {},
              );
            } else if (
              argoHealthStatus === "PROGRESSING" ||
              argoHealthStatus === "DEGRADED" ||
              argoSyncStatus === "OUT_OF_SYNC"
            ) {
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
            }
          } else if (env.status === "DEPLOYING") {
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

    // Run every 30 seconds
    this.deploymentReconciler = setInterval(() => void reconcile(), 30_000);
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

  private scheduleRenewal(leaseDuration: number) {
    const renewAt = Math.floor(leaseDuration * 0.8) * 1000;
    this.renewalTimer = setTimeout(async () => {
      if (!this.openbao || !this.leaseId) return;
      try {
        await this.openbao.renewLease(this.leaseId);
        this.scheduleRenewal(leaseDuration);
      } catch (err) {
        console.error("[observability] token renewal failed:", err);
      }
    }, renewAt);
  }
}
