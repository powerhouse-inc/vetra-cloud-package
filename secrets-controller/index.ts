import { loadConfig } from "./config.js";
import { createRepository } from "./db.js";
import { createK8sClient } from "./k8s-client.js";
import { createReconciler } from "./reconciler.js";
import { PostgresListener } from "./postgres-listener.js";
import { startHealthServer } from "./health.js";
import { OpenBaoTransitClient } from "../subgraphs/vetra-cloud-secrets/openbao-transit.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.info(
    `[main] starting vetra-secrets-controller (channel=${config.notifyChannel}, reconcileIntervalMs=${config.fullReconcileIntervalMs})`,
  );

  const repo = createRepository(config.databaseUrl, config.dbSchema);
  const k8s = createK8sClient();
  const transit = new OpenBaoTransitClient({
    addr: config.openbaoAddr,
    role: config.transitRole,
    keyName: config.transitKey,
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
    onReconnect: () => {
      // After a reconnect we may have missed NOTIFYs; do a full sweep.
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

  const timer = setInterval(() => {
    void reconciler.reconcileAll().catch((err) => {
      console.error(
        `[main] safety-net reconcileAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, config.fullReconcileIntervalMs);
  timer.unref?.();

  const shutdown = async (signal: string) => {
    console.info(`[main] received ${signal}, shutting down`);
    clearInterval(timer);
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
    `[main] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exit(1);
});
