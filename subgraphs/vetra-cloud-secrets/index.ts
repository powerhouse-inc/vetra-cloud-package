import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
import { schema } from "./schema.js";
import { createResolvers } from "./resolvers.js";
import { up } from "./db/migrations.js";
import type { SecretsDB } from "./db/schema.js";
import { OpenBaoTransitClient } from "./openbao-transit.js";
import { createRepository } from "./repository.js";
import { createK8sClient } from "./k8s-client.js";
import { createReconciler, type Reconciler } from "./reconciler.js";
import { PostgresListener } from "./postgres-listener.js";

const DEFAULT_ROLE = "vetra-secrets";
const NOTIFY_CHANNEL = "vetra_secrets_changed";
const DEFAULT_FULL_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const MANAGED_LABEL_VALUE = "vetra-cloud-secrets";

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

export class VetraCloudSecretsSubgraph extends BaseSubgraph {
  name = "vetra-cloud-secrets";
  typeDefs: DocumentNode = schema;
  resolvers: Record<string, unknown> = {};
  additionalContextFields = {};

  private listener: PostgresListener | null = null;
  private safetyNetTimer: NodeJS.Timeout | null = null;

  async onSetup() {
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-secrets",
    )) as unknown as Kysely<SecretsDB>;

    await up(db as Kysely<any>);

    const openbaoAddr = process.env.OPENBAO_ADDR;
    if (!openbaoAddr) {
      throw new Error(
        "[secrets] OPENBAO_ADDR is required — secrets cannot be encrypted without transit engine access",
      );
    }

    const transit = new OpenBaoTransitClient({
      addr: openbaoAddr,
      role: process.env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_ROLE,
      keyNamePrefix: process.env.OPENBAO_TRANSIT_KEY_PREFIX,
    });

    this.resolvers = createResolvers(db, transit);

    // Reconciliation runs only in-cluster (needs K8s API + a Postgres URL
    // that supports LISTEN). Switchboard always meets both conditions in
    // prod; local development without KUBERNETES_SERVICE_HOST silently skips.
    // LISTEN is not supported by PgBouncer transaction-mode poolers, so if
    // the regular DATABASE_URL goes through one, set LISTEN_DATABASE_URL to
    // a direct-primary connection string.
    const listenUrl =
      process.env.LISTEN_DATABASE_URL ?? process.env.DATABASE_URL;
    if (process.env.KUBERNETES_SERVICE_HOST && listenUrl) {
      await this.startReconcileLoop(db, transit, listenUrl);
    } else {
      console.info(
        "[secrets] KUBERNETES_SERVICE_HOST or DATABASE_URL unset — skipping background reconcile loop",
      );
    }
  }

  async onDisconnect() {
    if (this.safetyNetTimer) {
      clearInterval(this.safetyNetTimer);
      this.safetyNetTimer = null;
    }
    if (this.listener) {
      await this.listener.stop();
      this.listener = null;
    }
  }

  private async startReconcileLoop(
    db: Kysely<SecretsDB>,
    transit: OpenBaoTransitClient,
    listenUrl: string,
  ): Promise<void> {
    const repo = createRepository(db);
    const k8s = createK8sClient();
    const reconciler = createReconciler({
      repo,
      k8s,
      transit,
      managedLabelValue: MANAGED_LABEL_VALUE,
    });

    const fullReconcileIntervalMs = parsePositiveInt(
      process.env.FULL_RECONCILE_INTERVAL_MS,
      DEFAULT_FULL_RECONCILE_INTERVAL_MS,
    );

    this.listener = new PostgresListener({
      databaseUrl: listenUrl,
      channel: NOTIFY_CHANNEL,
      onNotify: (tenantId) => {
        if (!tenantId) {
          console.warn("[secrets] received empty NOTIFY payload; skipping");
          return;
        }
        void reconciler.reconcileTenant(tenantId).catch((err) => {
          console.error(
            `[secrets] reconcileTenant(${tenantId}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      onReconnect: () => {
        void this.safeReconcileAll(reconciler, "post-reconnect");
      },
    });

    await this.listener.start();

    void this.safeReconcileAll(reconciler, "startup");

    this.safetyNetTimer = setInterval(() => {
      void this.safeReconcileAll(reconciler, "safety-net");
    }, fullReconcileIntervalMs);
    this.safetyNetTimer.unref?.();

    console.info(
      `[secrets] reconcile loop started (channel=${NOTIFY_CHANNEL}, intervalMs=${fullReconcileIntervalMs})`,
    );
  }

  private async safeReconcileAll(
    reconciler: Reconciler,
    label: string,
  ): Promise<void> {
    try {
      await reconciler.reconcileAll();
    } catch (err) {
      console.error(
        `[secrets] ${label} reconcileAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
