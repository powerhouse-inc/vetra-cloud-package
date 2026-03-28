import { BaseSubgraph } from "@powerhousedao/reactor-api";
import type { DocumentNode } from "graphql";
import type { Kysely } from "kysely";
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
  private leaseId: string | null = null;
  private openbao: OpenBaoClient | null = null;
  private leaseDuration: number = 3600;

  async onSetup() {
    // Get a namespaced DB handle following the processor pattern.
    // BaseSubgraph exposes relationalDb: IRelationalDbLegacy which has createNamespace().
    const db = (await this.relationalDb.createNamespace(
      "vetra-cloud-observability",
    )) as unknown as Kysely<ObservabilityDB>;

    // 1. Run migrations
    await up(db as Kysely<any>);

    // 2. Set up resolvers
    const prometheusUrl =
      process.env.PROMETHEUS_URL ?? "http://kube-prometheus-stack-prometheus.monitoring.svc:9090";
    const lokiUrl =
      process.env.LOKI_URL ?? "http://loki.monitoring.svc:3100";

    this.resolvers = createResolvers(db, { prometheusUrl, lokiUrl });

    // 3. Acquire K8s credentials and start watchers
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
        console.warn("[observability] OpenBao failed, falling back to in-cluster SA:", err);
      }
    }

    // Start watchers: use OpenBao token if available, otherwise in-cluster SA
    try {
      this.watcherHandle = startWatchers({
        db,
        k8sToken: k8sToken ?? "",
      });
      console.info(`[observability] Watchers started (${k8sToken ? "OpenBao token" : "in-cluster SA"})`);
    } catch (err) {
      console.warn("[observability] Failed to start watchers:", err);
    }
  }

  async onDisconnect() {
    this.watcherHandle?.stop();
    this.watcherHandle = null;
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

  private scheduleRenewal(leaseDuration: number) {
    const renewAt = Math.floor(leaseDuration * 0.8) * 1000;
    this.renewalTimer = setTimeout(async () => {
      if (!this.openbao || !this.leaseId) return;
      try {
        // renewLease returns void; re-schedule with the same TTL
        await this.openbao.renewLease(this.leaseId);
        this.scheduleRenewal(leaseDuration);
      } catch (err) {
        console.error("[observability] token renewal failed:", err);
      }
    }, renewAt);
  }
}
