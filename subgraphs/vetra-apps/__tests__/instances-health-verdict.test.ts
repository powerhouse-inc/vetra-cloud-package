import { describe, expect, it } from "vitest";
import {
  digestOf,
  judgeCluster,
  judgedPods,
  judgeProbes,
  observedDigest,
  type PodSnapshot,
} from "../instances/health.js";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const REPO = "cr.vetra.io/acme/shop";
const pod = (over: Partial<PodSnapshot> = {}): PodSnapshot => ({
  phase: "RUNNING",
  ready: true,
  restartCount: 0,
  image: `${REPO}:1.5.0@${A}`,
  imageId: `${REPO}@${A}`,
  waitingReason: null,
  ...over,
});
const argo = {
  syncStatus: "SYNCED",
  healthStatus: "HEALTHY",
  drift: false,
  message: null,
};
const ok = {
  status: 200,
  contentType: "text/html; charset=utf-8",
  error: null,
};

describe("digestOf", () => {
  it("reads the digest after the last @", () => {
    expect(digestOf(`1.5.0@${A}`)).toBe(A);
    expect(digestOf(`docker-pullable://${REPO}@${A}`)).toBe(A);
    expect(digestOf("1.5.0")).toBeNull();
    expect(digestOf(null)).toBeNull();
    expect(digestOf(`x@sha256:short`)).toBeNull();
  });
});

describe("judgeCluster", () => {
  it("fails a render error before anything else, whatever the old pods say", () => {
    expect(
      judgeCluster(
        { ...argo, drift: true, message: "helm template failed" },
        [pod()],
        0,
      ),
    ).toEqual({
      health: "unhealthy",
      check: "gitops",
      reason: "Argo CD cannot apply the environment (helm template failed)",
    });
    expect(
      judgeCluster({ ...argo, syncStatus: "UNKNOWN" }, [], null)?.check,
    ).toBe("gitops");
  });
  it("knows nothing without cluster data", () => {
    expect(judgeCluster(null, [], null)).toMatchObject({
      health: "unknown",
      check: "data",
    });
  });
  it("fails a pull error and a crash loop", () => {
    expect(
      judgeCluster(
        argo,
        [
          pod({
            ready: false,
            waitingReason: "ImagePullBackOff",
            imageId: null,
          }),
        ],
        null,
      ),
    ).toEqual({
      health: "unhealthy",
      check: "image",
      reason: "the image cannot be pulled (ImagePullBackOff)",
    });
    expect(
      judgeCluster(
        argo,
        [
          pod({
            ready: false,
            waitingReason: "CrashLoopBackOff",
            restartCount: 3,
          }),
        ],
        3,
      ),
    ).toEqual({
      health: "unhealthy",
      check: "crash",
      reason: "the container does not start (CrashLoopBackOff)",
    });
  });
  it("fails restarts that rose since the last check, even when the pod is ready again", () => {
    expect(judgeCluster(argo, [pod({ restartCount: 4 })], 3)).toEqual({
      health: "unhealthy",
      check: "restarts",
      reason: "the container restarted (4 restarts)",
    });
    expect(judgeCluster(argo, [pod({ restartCount: 4 })], 4)).toBeNull();
    expect(judgeCluster(argo, [pod({ restartCount: 4 })], null)).toBeNull();
  });
  it("calls a missing or not-ready pod unknown (starting), not unhealthy", () => {
    expect(judgeCluster(argo, [], null)).toEqual({
      health: "unknown",
      check: "pod",
      reason: "no pod runs the target image yet",
    });
    expect(judgeCluster(argo, [pod({ ready: false })], 0)).toEqual({
      health: "unknown",
      check: "pod",
      reason: "the pod is starting",
    });
  });
});

describe("judgedPods", () => {
  it("keeps live pods on the wanted digest only", () => {
    const pods = [
      pod(),
      pod({ image: `${REPO}:1.6.0@${B}` }),
      pod({ phase: "FAILED" }),
    ];
    expect(judgedPods(pods, A)).toEqual([pods[0]]);
    expect(judgedPods(pods, null)).toEqual([]);
  });
});

describe("judgeProbes", () => {
  it("is healthy when /ready is 200 and Connect serves HTML", () => {
    expect(judgeProbes({ ...ok, contentType: "text/plain" }, ok)).toEqual({
      health: "healthy",
      check: null,
      reason: null,
    });
  });
  it("treats 503 as starting (migrations), anything else as unhealthy", () => {
    expect(
      judgeProbes({ status: 503, contentType: null, error: null }, null),
    ).toEqual({
      health: "unknown",
      check: "switchboard",
      reason: "the switchboard is starting (migrations)",
    });
    expect(
      judgeProbes({ status: 502, contentType: null, error: null }, null),
    ).toEqual({
      health: "unhealthy",
      check: "switchboard",
      reason: "/ready answered 502",
    });
    expect(
      judgeProbes({ status: null, contentType: null, error: "timeout" }, null)
        .reason,
    ).toBe("/ready did not answer (timeout)");
  });
  it("fails Connect that does not serve its page", () => {
    expect(
      judgeProbes(ok, { status: 500, contentType: "text/html", error: null }),
    ).toEqual({
      health: "unhealthy",
      check: "connect",
      reason: "Connect answered 500",
    });
    expect(
      judgeProbes(ok, {
        status: 200,
        contentType: "application/json",
        error: null,
      }).check,
    ).toBe("connect");
  });
});

describe("observedDigest", () => {
  it("prefers a ready pod on the wanted digest, then any ready pod, by imageID", () => {
    expect(observedDigest([pod()], A, `1.5.0@${A}`)).toEqual({
      digest: A,
      source: "pod",
    });
    const old = pod({ image: `${REPO}:1.4.0@${B}`, imageId: `${REPO}@${B}` });
    expect(
      observedDigest([old, pod({ ready: false })], A, `1.5.0@${A}`),
    ).toEqual({ digest: B, source: "pod" });
  });
  it("falls back to the document when the ready pod reports no imageID", () => {
    expect(observedDigest([pod({ imageId: null })], A, `1.5.0@${A}`)).toEqual({
      digest: A,
      source: "document",
    });
  });
  it("is null when nothing is ready", () => {
    expect(observedDigest([pod({ ready: false })], A, `1.5.0@${A}`)).toEqual({
      digest: null,
      source: null,
    });
  });
});
