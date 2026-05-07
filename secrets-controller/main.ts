/**
 * vetra-secrets-controller — standalone Node service that materializes the
 * env-vars and secrets configured per tenant (encrypted in Postgres,
 * managed via the vetra-cloud-secrets GraphQL subgraph) into Kubernetes
 * `<tenantId>-env` ConfigMaps and `<tenantId>-secrets` Secrets in each
 * tenant namespace.
 *
 * Why a standalone pod (vs. the embedded reconciler that lived in
 * switchboard between commits e98be36 and the restoration this file is
 * part of): the management switchboard's ServiceAccount has no
 * cross-namespace RBAC, so its embedded reconcile loop logged
 * "namespace missing or RBAC not applied; skipping" for every tenant
 * and no env actually received its values. This controller has its own
 * ServiceAccount + ClusterRole that grants get/list/create/update/patch
 * on Secrets and ConfigMaps cluster-wide, and does nothing else.
 *
 * Loop:
 *   1. Startup full sweep — every tenant in the DB gets reconciled once.
 *   2. LISTEN on `vetra_secrets_changed` — every NOTIFY (emitted by the
 *      subgraph mutations) triggers a single-tenant reconcile.
 *   3. Safety-net 5-min full sweep — covers anything missed (dropped
 *      notification, listener reconnect window).
 *   4. SIGTERM/SIGINT shutdown — closes listener, db pool, health
 *      server.
 */

import { createK8sClient } from "../subgraphs/vetra-cloud-secrets/k8s-client.js";
import { OpenBaoTransitClient } from "../subgraphs/vetra-cloud-secrets/openbao-transit.js";
import { PostgresListener } from "../subgraphs/vetra-cloud-secrets/postgres-listener.js";
import { createReconciler } from "../subgraphs/vetra-cloud-secrets/reconciler.js";

import { loadConfig } from "./config.js";
import { createOwnedRepository } from "./db.js";
import { startHealthServer } from "./health.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.info(
    `[main] starting vetra-secrets-controller (channel=${config.notifyChannel}, intervalMs=${config.fullReconcileIntervalMs}, namespace=${config.dbNamespace})`,
  );

  const repo = createOwnedRepository({
    databaseUrl: config.databaseUrl,
    namespace: config.dbNamespace,
  });
  console.info(`[main] resolved DB schema: ${repo.schema}`);

  const k8s = createK8sClient();
  const transit = new OpenBaoTransitClient({
    addr: config.openbaoAddr,
    role: config.transitRole,
    keyNamePrefix: config.transitKeyPrefix,
  });
  const reconciler = createReconciler({
    repo,
    k8s,
    transit,
    managedLabelValue: config.managedLabelValue,
  });

  let startupReconcileDone = false;

  const listener = new PostgresListener({
    databaseUrl: config.databaseUrl,
    channel: config.notifyChannel,
    onNotify: (tenantId) => {
      if (!tenantId) {
        console.warn("[main] received empty NOTIFY payload; skipping");
        return;
      }
      void reconciler.reconcileTenant(tenantId).catch((err) => {
        console.error(
          `[main] reconcileTenant(${tenantId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    // Notifications between disconnect and reconnect are silently dropped
    // by Postgres. After every reconnect, run a full sweep so we converge
    // on whatever the DB looks like now.
    onReconnect: () => {
      void reconciler.reconcileAll().catch((err) => {
        console.error(
          `[main] post-reconnect reconcileAll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  });

  const healthServer = startHealthServer(config.healthPort, {
    listenerConnected: () => listener.isConnected(),
    startupReconcileDone: () => startupReconcileDone,
  });

  await listener.start();

  try {
    await reconciler.reconcileAll();
  } catch (err) {
    console.error(
      `[main] startup reconcileAll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  startupReconcileDone = true;
  console.info("[main] startup reconciliation complete");

  const safetyNet = setInterval(() => {
    void reconciler.reconcileAll().catch((err) => {
      console.error(
        `[main] safety-net reconcileAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, config.fullReconcileIntervalMs);
  // Don't keep the event loop alive on the timer alone — listener owns that.
  safetyNet.unref?.();

  const shutdown = async (signal: string) => {
    console.info(`[main] received ${signal}, shutting down`);
    clearInterval(safetyNet);
    await listener.stop();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await repo.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(
    `[main] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
