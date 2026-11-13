import type { Kysely } from "kysely";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import type { BackupK8s } from "../backups/k8s.js";
import type { SwitchoverBackups } from "./backups.js";
import type { CountsRunner } from "./counts-job.js";

/** What the switch-over steps need from the cluster, beyond the Apps service's own dependencies. */
export interface SwitchoverPorts {
  backups: SwitchoverBackups;
  counts: CountsRunner;
  /** The tenant's database (CNPG primary) is ready, and its /data volume is Bound. */
  storage: {
    databaseReady(tenant: string): Promise<boolean>;
    dataVolumeBound(tenant: string): Promise<boolean>;
  };
  /** The tenant's /data volume (`<fullname>-app-data`), or null. */
  dataPvc(tenant: string): Promise<string | null>;
  /** A running app pod of the tenant (the same-node archive runs beside it), or null. */
  runningAppPod(tenant: string): Promise<string | null>;
}

/**
 * The production ports over the backups' cluster client and observability's
 * pod table. Readiness that cannot be told is "not ready" (the step times
 * out and fails closed).
 */
export function switchoverPortsOver(d: {
  backups: SwitchoverBackups;
  counts: CountsRunner;
  k8s: BackupK8s;
  observabilityDb: Kysely<ObservabilityDB>;
}): SwitchoverPorts {
  return {
    backups: d.backups,
    counts: d.counts,
    storage: {
      databaseReady: async (t) => (await d.k8s.databaseReady?.(t)) ?? false,
      dataVolumeBound: async (t) => (await d.k8s.dataPvcBound?.(t)) ?? false,
    },
    dataPvc: (t) => d.k8s.findDataPvc(t),
    async runningAppPod(tenant) {
      const pod = await d.observabilityDb
        .selectFrom("environment_pods")
        .select("name")
        .where("tenantId", "=", tenant)
        .where("component", "=", "app")
        .where("phase", "=", "Running")
        .limit(1)
        .executeTakeFirst();
      return pod?.name ?? null;
    },
  };
}
