// Keeps `environment_pods` in line with the cluster's pods. Shared by the
// observability watchers and scripts/prune-environment-pods.mts, so this
// module must only have type imports (it is loaded by plain
// `node --experimental-strip-types` in the script).
import type { Kysely } from "kysely";
import type { EnvironmentPods, ObservabilityDB } from "./db/schema.ts";

/**
 * Map the chart's `app.kubernetes.io/component` label to the
 * TenantService enum used by the GraphQL schema. Unrecognised
 * components (clint agents, registry, helper pods, pre-chart legacy
 * pods without the label) collapse to OTHER.
 */
export function classifyPodService(
  component: string | null | undefined,
): string {
  if (component === "connect") return "CONNECT";
  if (component === "switchboard") return "SWITCHBOARD";
  return "OTHER";
}

/** Uppercase enum values to match GraphQL schema (K8s returns Mixed case).
 *  Handles camelCase (e.g. OutOfSync → OUT_OF_SYNC) and spaces. */
export function toUpperEnum(val: string): string {
  return val
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/ /g, "_");
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
        image: row.image ?? null,
        imageId: row.imageId ?? null,
        waitingReason: row.waitingReason ?? null,
        service: row.service,
        component: row.component,
        agent: row.agent,
        updatedAt: row.updatedAt,
      }),
    )
    .execute();
}

export async function deletePod(
  db: Kysely<ObservabilityDB>,
  tenantId: string,
  name: string,
): Promise<void> {
  await db
    .deleteFrom("environment_pods")
    .where("id", "=", `${tenantId}/${name}`)
    .execute();
}

/** Minimal shape of a k8s Pod object, as delivered by list and watch. */
export interface PodLike {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: { containers?: Array<{ name?: string; image?: string }> };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      imageID?: string;
      state?: { waiting?: { reason?: string } };
    }>;
  };
}

/** Waiting reasons of a container that is starting normally, not failing. */
const TRANSIENT_WAITING = new Set(["PodInitializing", "ContainerCreating"]);

/** Map a k8s Pod to its environment_pods row (null when name/namespace is missing). */
export function podToRow(
  pod: PodLike,
  now = new Date().toISOString(),
): EnvironmentPods | null {
  const tenantId = pod.metadata?.namespace;
  const name = pod.metadata?.name;
  if (!tenantId || !name) return null;

  const containerStatuses = pod.status?.containerStatuses ?? [];
  const ready = containerStatuses.every((cs) => cs.ready) ? 1 : 0;
  const restartCount = containerStatuses.reduce(
    (sum, cs) => sum + (cs.restartCount ?? 0),
    0,
  );
  const labels = pod.metadata?.labels ?? {};
  const component = labels["app.kubernetes.io/component"] ?? null;
  const agent = labels["clint.vetra.io/agent"] ?? null;

  const main = pod.spec?.containers?.[0];
  const mainStatus =
    containerStatuses.find((cs) => main?.name && cs.name === main.name) ??
    containerStatuses[0];
  // Why the pod waits: the app container's own reason first; any container's
  // real failure (crash, pull) over one that is merely being created.
  const reasons = [
    mainStatus,
    ...containerStatuses.filter((cs) => cs !== mainStatus),
  ]
    .map((cs) => cs?.state?.waiting?.reason)
    .filter((r): r is string => !!r);
  const waitingReason =
    reasons.find((r) => !TRANSIENT_WAITING.has(r)) ?? reasons[0] ?? null;

  return {
    id: `${tenantId}/${name}`,
    tenantId,
    name,
    service: classifyPodService(component),
    component,
    agent,
    phase: toUpperEnum(pod.status?.phase ?? "Unknown"),
    ready,
    restartCount,
    image: main?.image ?? null,
    imageId: mainStatus?.imageID || null,
    waitingReason,
    updatedAt: now,
  };
}

/**
 * Apply one pod watch event. DELETED removes the row — previously every
 * event was upserted, so gone pods lingered forever (often as FAILED) and
 * made healthy services look like they were failing.
 */
export async function handlePodWatchEvent(
  db: Kysely<ObservabilityDB>,
  type: string,
  obj: unknown,
): Promise<void> {
  const pod = obj as PodLike;
  if (type === "DELETED") {
    const tenantId = pod.metadata?.namespace;
    const name = pod.metadata?.name;
    if (tenantId && name) await deletePod(db, tenantId, name);
    return;
  }
  // BOOKMARK / ERROR carry no pod; podToRow returns null for them.
  if (type !== "ADDED" && type !== "MODIFIED") return;
  const row = podToRow(pod);
  if (row) await upsertPod(db, row);
}

export interface ReconcilePodsResult {
  upserted: number;
  /** Stale row count per tenant (deleted, or would be deleted on dry run). */
  stale: Map<string, number>;
}

const DELETE_CHUNK = 1000;

/**
 * Bring environment_pods in line with a fresh pod listing: upsert every
 * listed pod and delete rows for pods that no longer exist.
 *
 * Deletes are scoped strictly to `tenants` — the namespaces the caller
 * actually listed (plus any extra tenants it knows were covered by the
 * listing, e.g. ArgoCD tenants whose namespace currently has no pods).
 * Rows of any other tenant are never touched. If `listPods` throws, the
 * error propagates before anything is written or deleted.
 *
 * Rows updated at/after the moment the listing started are kept, so a pod
 * the watcher upserted while the list was in flight is not pruned.
 */
export async function reconcilePods(
  db: Kysely<ObservabilityDB>,
  listPods: () => Promise<PodLike[]>,
  opts: { extraTenants?: Iterable<string>; dryRun?: boolean } = {},
): Promise<ReconcilePodsResult> {
  const listStartedAt = new Date().toISOString();
  const pods = await listPods();

  const rows = pods
    .map((p) => podToRow(p, listStartedAt))
    .filter((r): r is EnvironmentPods => r !== null);

  const tenants = new Set<string>(opts.extraTenants ?? []);
  const liveIds = new Set<string>();
  for (const r of rows) {
    tenants.add(r.tenantId);
    liveIds.add(r.id);
  }

  if (!opts.dryRun) {
    for (const row of rows) await upsertPod(db, row);
  }

  const stale = new Map<string, number>();
  if (tenants.size === 0)
    return { upserted: opts.dryRun ? 0 : rows.length, stale };

  const existing = await db
    .selectFrom("environment_pods")
    .select(["id", "tenantId"])
    .where("tenantId", "in", [...tenants])
    .where("updatedAt", "<", listStartedAt)
    .execute();

  const staleIds: string[] = [];
  for (const r of existing) {
    if (liveIds.has(r.id)) continue;
    staleIds.push(r.id);
    stale.set(r.tenantId, (stale.get(r.tenantId) ?? 0) + 1);
  }

  if (!opts.dryRun) {
    for (let i = 0; i < staleIds.length; i += DELETE_CHUNK) {
      await db
        .deleteFrom("environment_pods")
        .where("id", "in", staleIds.slice(i, i + DELETE_CHUNK))
        // Re-check so a row the watcher refreshed meanwhile survives.
        .where("updatedAt", "<", listStartedAt)
        .execute();
    }
  }

  return { upserted: opts.dryRun ? 0 : rows.length, stale };
}
