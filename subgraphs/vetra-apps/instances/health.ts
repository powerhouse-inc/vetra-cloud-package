import type { InstanceHealth } from "../db/schema.js";

/** Spec 14.7, as measured from the cluster and the host (see plan 3's table). Pure. */
export type HealthCheck =
  | "gitops"
  | "image"
  | "crash"
  | "restarts"
  | "pod"
  | "switchboard"
  | "connect"
  | "stopped"
  | "data";

export interface HealthVerdict {
  health: InstanceHealth;
  check: HealthCheck | null;
  reason: string | null;
}

export interface PodSnapshot {
  /** Upper case, as observability stores it (RUNNING, PENDING, FAILED, …). */
  phase: string;
  ready: boolean;
  restartCount: number;
  image: string | null;
  imageId: string | null;
  waitingReason: string | null;
  /** VETRA_SETTINGS_REVISION the pod was started with (null: none or not recorded). */
  settingsRevision?: string | null;
}

export interface ArgoSnapshot {
  syncStatus: string;
  healthStatus: string;
  /** An Argo ComparisonError condition: the manifests do not render. */
  drift: boolean;
  message: string | null;
}

export interface ProbeResult {
  status: number | null;
  contentType: string | null;
  error: string | null;
}

export const NO_DATA: HealthVerdict = {
  health: "unknown",
  check: "data",
  reason: "no cluster data for the environment yet",
};
export const STOPPED: HealthVerdict = {
  health: "unknown",
  check: "stopped",
  reason: "the environment is stopped",
};
export const HEALTHY: HealthVerdict = {
  health: "healthy",
  check: null,
  reason: null,
};

const PULL_FAILURES = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "ErrImageNeverPull",
]);
const CRASH_FAILURES = new Set([
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);
const DEAD_PHASES = new Set(["SUCCEEDED", "FAILED"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The digest after the last `@` of an image reference or tag (`<version>@<digest>`), if well formed. */
export function digestOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const d = ref.slice(ref.lastIndexOf("@") + 1);
  return ref.includes("@") && DIGEST.test(d) ? d : null;
}

/** Live pods whose spec pulls the wanted digest (and, when one is wanted, runs the wanted settings revision). */
export function judgedPods(
  pods: PodSnapshot[],
  wanted: string | null,
  wantedSettings: string | null = null,
): PodSnapshot[] {
  if (!wanted) return [];
  return pods.filter(
    (p) =>
      !DEAD_PHASES.has(p.phase) &&
      digestOf(p.image) === wanted &&
      (wantedSettings === null ||
        (p.settingsRevision ?? null) === wantedSettings),
  );
}

/** Checks 1-7. Null: the cluster has nothing against the instance; probe it. */
export function judgeCluster(
  argo: ArgoSnapshot | null,
  judged: PodSnapshot[],
  previousRestarts: number | null,
  wantedSettings: string | null = null,
): HealthVerdict | null {
  if (argo && (argo.drift || argo.syncStatus === "UNKNOWN"))
    return {
      health: "unhealthy",
      check: "gitops",
      reason: `Argo CD cannot apply the environment${argo.message ? ` (${argo.message.slice(0, 200)})` : ""}`,
    };
  if (!argo && judged.length === 0) return NO_DATA;
  const waiting = judged
    .map((p) => p.waitingReason)
    .filter((r): r is string => !!r);
  const pull = waiting.find((r) => PULL_FAILURES.has(r));
  if (pull)
    return {
      health: "unhealthy",
      check: "image",
      reason: `the image cannot be pulled (${pull})`,
    };
  const crash = waiting.find((r) => CRASH_FAILURES.has(r));
  if (crash)
    return {
      health: "unhealthy",
      check: "crash",
      reason: `the container does not start (${crash})`,
    };
  const restarts = judged.reduce((n, p) => n + p.restartCount, 0);
  if (previousRestarts !== null && restarts > previousRestarts)
    return {
      health: "unhealthy",
      check: "restarts",
      reason: `the container restarted (${restarts} restarts)`,
    };
  if (judged.length === 0)
    return {
      health: "unknown",
      check: "pod",
      reason: wantedSettings
        ? "no pod runs the target image and settings yet"
        : "no pod runs the target image yet",
    };
  if (!judged.every((p) => p.ready && p.phase === "RUNNING"))
    return { health: "unknown", check: "pod", reason: "the pod is starting" };
  return null;
}

const answer = (p: ProbeResult) =>
  p.status !== null
    ? `answered ${p.status}`
    : `did not answer (${p.error ?? "no response"})`;

/** Checks 8-10: the switchboard's readiness (migrations done), then Connect's page. */
export function judgeProbes(
  ready: ProbeResult,
  connect: ProbeResult | null,
): HealthVerdict {
  if (ready.status === 503)
    return {
      health: "unknown",
      check: "switchboard",
      reason: "the switchboard is starting (migrations)",
    };
  if (ready.status !== 200)
    return {
      health: "unhealthy",
      check: "switchboard",
      reason: `/ready ${answer(ready)}`,
    };
  const servesPage =
    !!connect &&
    connect.status !== null &&
    connect.status >= 200 &&
    connect.status < 300 &&
    (connect.contentType ?? "").includes("text/html");
  if (!servesPage)
    return {
      health: "unhealthy",
      check: "connect",
      reason:
        connect &&
        connect.status !== null &&
        connect.status >= 200 &&
        connect.status < 300
          ? `Connect answered ${connect.status} without a page`
          : `Connect ${connect ? answer(connect) : "was not asked"}`,
    };
  return HEALTHY;
}

/**
 * What the cluster runs (spec 6 "running digest"): a ready pod's imageID,
 * the wanted digest first. Until the host reports its own version (spec 15,
 * gap 8) this is the best evidence; the document's tag only stands in when
 * the ready pod has no imageID yet.
 */
export function observedDigest(
  hostPods: PodSnapshot[],
  wanted: string | null,
  documentVersion: string | null,
): { digest: string | null; source: "pod" | "document" | null } {
  const ready = hostPods.filter((p) => p.ready && p.phase === "RUNNING");
  if (ready.length === 0) return { digest: null, source: null };
  const ids = ready
    .map((p) => digestOf(p.imageId))
    .filter((d): d is string => !!d);
  if (ids.length > 0)
    return {
      digest: wanted && ids.includes(wanted) ? wanted : ids[0],
      source: "pod",
    };
  return { digest: digestOf(documentVersion), source: "document" };
}

/**
 * The settings revision a ready host pod on the target digest runs: the
 * wanted one when such a pod has it. A pod on another image says nothing
 * about the target's settings.
 */
export function observedSettings(
  hostPods: PodSnapshot[],
  wanted: string | null,
  wantedSettings: string | null,
): string | null {
  const revs = hostPods
    .filter(
      (p) =>
        p.ready &&
        p.phase === "RUNNING" &&
        (wanted === null ||
          (digestOf(p.imageId) ?? digestOf(p.image)) === wanted),
    )
    .map((p) => p.settingsRevision ?? null)
    .filter((r): r is string => !!r);
  if (revs.length === 0) return null;
  return wantedSettings && revs.includes(wantedSettings)
    ? wantedSettings
    : revs[0];
}
