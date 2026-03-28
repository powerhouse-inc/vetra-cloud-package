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

    // 3. Acquire K8s credentials via OpenBao (skip if not configured)
    const openbaoAddr = process.env.OPENBAO_ADDR;
    if (openbaoAddr) {
      try {
        this.openbao = new OpenBaoClient(openbaoAddr);
        await this.openbao.authenticate();
        const creds = await this.openbao.getK8sToken();
        this.leaseId = creds.leaseId;
        this.leaseDuration = creds.leaseDuration;

        // 4. Start watchers
        this.watcherHandle = startWatchers({ db, k8sToken: creds.token });

        // 5. Schedule token renewal at 80% of TTL
        this.scheduleRenewal(creds.leaseDuration);
      } catch (err) {
        console.warn(
          "[observability] OpenBao/K8s setup failed, watchers disabled:",
          err,
        );
      }
    } else {
      console.info(
        "[observability] OPENBAO_ADDR not set, watchers disabled (resolvers still active)",
      );
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
