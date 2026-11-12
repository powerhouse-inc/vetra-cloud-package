import type { Kysely } from "kysely";
import {
  approveChanges,
  setLabel,
} from "../../../document-models/vetra-cloud-environment/v1/gen/creators.js";
import type { EnvGateway } from "../envs.js";
import type { VetraAppsDB } from "../db/schema.js";
import type { ObservabilityDB } from "../../vetra-cloud-observability/db/schema.js";
import { CLUSTER_STALE_MS } from "../instances/cluster.js";
import { deleteHold, getHold, insertHold, type HoldRow } from "./repo.js";

/**
 * A hold keeps an environment with its data while its app does not run: the
 * processor renders it with no app pod and no ingress, keeping the CNPG
 * database (Cluster, its PVC, Pooler, ScheduledBackup) and the data volumes.
 * Sleeping (STOPPED, global.disabled) instead removes the Cluster, and CNPG
 * deletes the database with it.
 */
export interface HoldDeps {
  db: Kysely<VetraAppsDB>;
  envs: EnvGateway;
  now: () => Date;
  observabilityDb?: Kysely<ObservabilityDB> | null;
}

/**
 * Statuses a re-render can follow from: a deployed (or deploying) environment.
 * STOPPED renders disabled whatever the hold (a hold never wakes); DRAFT has
 * never been deployed, so its first render reads the hold; the rest are gone.
 */
const RERENDERABLE = new Set([
  "READY",
  "CHANGES_APPROVED",
  "CHANGES_PUSHED",
  "DEPLOYING",
  "DEPLOYMENt_FAILED",
  "CHANGES_PENDING",
]);

/**
 * Makes the processor render the environment again, changing no field: the
 * same label marks changes pending, approving them renders. System-signed,
 * so a licensed (managedBy) environment re-renders too. Pending changes are
 * approved as they are (the hold must take effect).
 */
export async function rerender(
  envs: EnvGateway,
  environmentId: string,
): Promise<void> {
  const state = await envs.getState(environmentId);
  if (!state || !RERENDERABLE.has(state.status)) return;
  if (state.status === "CHANGES_PENDING") {
    await envs.execute(environmentId, [approveChanges({})]);
    return;
  }
  // The processor skips an environment without a label; nothing to render.
  if (!state.label) return;
  await envs.execute(environmentId, [
    setLabel({ label: state.label }),
    approveChanges({}),
  ]);
}

/** Holds an environment and re-renders it; an environment already held is left as it is. */
export async function holdEnvironment(
  deps: HoldDeps,
  input: {
    environmentId: string;
    reason: string;
    switchoverId: string | null;
    by: string;
  },
): Promise<{ hold: HoldRow; created: boolean }> {
  const existing = await getHold(deps.db, input.environmentId);
  if (existing) return { hold: existing, created: false };
  const hold = await insertHold(deps.db, {
    environment_id: input.environmentId,
    reason: input.reason,
    switchover_id: input.switchoverId,
    created_by: input.by.toLowerCase(),
    created_at: deps.now().toISOString(),
  });
  await rerender(deps.envs, input.environmentId);
  return { hold, created: true };
}

/** Releases a hold and re-renders the environment (its app starts again). False: it was not held. */
export async function releaseHold(
  deps: HoldDeps,
  environmentId: string,
): Promise<boolean> {
  if (!(await deleteHold(deps.db, environmentId))) return false;
  await rerender(deps.envs, environmentId);
  return true;
}

export async function isHeld(
  deps: Pick<HoldDeps, "db">,
  environmentId: string,
): Promise<boolean> {
  return (await getHold(deps.db, environmentId)) !== null;
}

/** Workload pods a hold removes (chart `app.kubernetes.io/component`). */
const WORKLOAD_COMPONENTS = ["app", "switchboard", "connect"];

/**
 * Whether observability, with fresh data, still records an app, switchboard
 * or Connect pod for the tenant (a held environment whose render never
 * happened). False when it cannot tell.
 */
export async function workloadPodSeen(
  deps: Pick<HoldDeps, "now" | "observabilityDb">,
  tenantId: string,
): Promise<boolean> {
  const db = deps.observabilityDb;
  if (!db) return false;
  const pod = await db
    .selectFrom("environment_pods")
    .select("updatedAt")
    .where("tenantId", "=", tenantId)
    .where("component", "in", WORKLOAD_COMPONENTS)
    .limit(1)
    .executeTakeFirst();
  return (
    !!pod &&
    Date.parse(pod.updatedAt) >= deps.now().getTime() - CLUSTER_STALE_MS
  );
}

/**
 * Whether the tenant runs no app, switchboard or Connect pod, as observability
 * records it. False when that cannot be told: no observability, or its data
 * for the tenant is stale (older than CLUSTER_STALE_MS).
 */
export async function appPodGone(
  deps: Pick<HoldDeps, "now" | "observabilityDb">,
  tenantId: string,
): Promise<boolean> {
  const db = deps.observabilityDb;
  if (!db) return false;
  const pod = await db
    .selectFrom("environment_pods")
    .select("id")
    .where("tenantId", "=", tenantId)
    .where("component", "in", WORKLOAD_COMPONENTS)
    .limit(1)
    .executeTakeFirst();
  if (pod) return false;
  const status = await db
    .selectFrom("environment_status")
    .select("updatedAt")
    .where("tenantId", "=", tenantId)
    .executeTakeFirst();
  // No status row: Argo never synced the tenant, so nothing ever ran.
  if (!status) return true;
  return Date.parse(status.updatedAt) >= deps.now().getTime() - CLUSTER_STALE_MS;
}
