import { describe, expect, it } from "vitest";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import {
  CONFIRM_MS,
  DEGRADED_AFTER_MS,
  HEALTH_STABLE_MS,
  observeEnvironment,
  observeHealth,
  UPDATE_TIMEOUT_MS,
  type HealthView,
} from "../instances/status.js";

const TAG = `1.5.0@sha256:${"a".repeat(64)}`;
const state = (status: string, version: string | null = TAG) =>
  ({
    status,
    services: [{ type: "FUSION", enabled: true, version }],
  }) as unknown as VetraCloudEnvironmentState;
const now = new Date("2026-11-11T12:00:00.000Z");
const started = (msAgo: number) =>
  new Date(now.getTime() - msAgo).toISOString();

describe("observeEnvironment", () => {
  it("never fails an instance that already ran the target (a restart, a wake, a blip)", () => {
    for (const s of ["DEPLOYING", "CHANGES_APPROVED", "DEPLOYMENt_FAILED"])
      expect(
        observeEnvironment(
          state(s),
          TAG,
          started(UPDATE_TIMEOUT_MS * 10),
          now,
          true,
        ),
      ).toEqual({ kind: "updating" });
    expect(
      observeEnvironment(state("READY"), TAG, started(1), now, true),
    ).toEqual({ kind: "ready" });
    expect(
      observeEnvironment(state("STOPPED"), TAG, started(1), now, true),
    ).toEqual({ kind: "stopped" });
  });

  it("is ready only when READY on the target tag", () => {
    expect(observeEnvironment(state("READY"), TAG, null, now)).toEqual({
      kind: "ready",
    });
    expect(
      observeEnvironment(state("READY", "1.4.0@sha256:x"), TAG, null, now),
    ).toEqual({ kind: "updating" });
  });

  it("is updating while the deploy pipeline runs, failed after the timeout", () => {
    for (const s of [
      "CHANGES_PENDING",
      "CHANGES_APPROVED",
      "CHANGES_PUSHED",
      "DEPLOYING",
    ])
      expect(observeEnvironment(state(s), TAG, started(60_000), now)).toEqual({
        kind: "updating",
      });
    expect(
      observeEnvironment(
        state("DEPLOYING"),
        TAG,
        started(UPDATE_TIMEOUT_MS + 1),
        now,
      ),
    ).toEqual({
      kind: "failed",
      reason: "not ready after 20 minutes",
    });
  });

  it("reports a failed deployment, a stopped and a terminated environment", () => {
    expect(
      observeEnvironment(state("DEPLOYMENt_FAILED"), TAG, null, now),
    ).toEqual({
      kind: "failed",
      reason: "the deployment failed",
    });
    expect(observeEnvironment(state("STOPPED"), TAG, null, now)).toEqual({
      kind: "stopped",
    });
    expect(observeEnvironment(state("TERMINATING"), TAG, null, now)).toEqual({
      kind: "failed",
      reason: "the environment is TERMINATING",
    });
  });

  it("fails a failed deployment on the target tag at once; an old-tag failure is just not ready", () => {
    const failed = { kind: "failed", reason: "the deployment failed" };
    const old = "1.4.0@sha256:x";
    expect(
      observeEnvironment(state("DEPLOYMENt_FAILED"), TAG, null, now),
    ).toEqual(failed);
    expect(
      observeEnvironment(state("DEPLOYMENt_FAILED"), TAG, started(1000), now),
    ).toEqual(failed);
    expect(
      observeEnvironment(state("DEPLOYMENt_FAILED", old), TAG, null, now),
    ).toEqual({ kind: "updating" });
    expect(
      observeEnvironment(
        state("DEPLOYMENt_FAILED", old),
        TAG,
        started(1000),
        now,
      ),
    ).toEqual({ kind: "updating" });
    expect(
      observeEnvironment(
        state("DEPLOYMENt_FAILED", old),
        TAG,
        started(UPDATE_TIMEOUT_MS + 1),
        now,
      ),
    ).toEqual({
      kind: "failed",
      reason: "not ready after 20 minutes",
    });
  });

  it("keeps DRAFT, unknown statuses and unparseable start times updating, never ready", () => {
    expect(observeEnvironment(state("DRAFT"), TAG, null, now)).toEqual({
      kind: "updating",
    });
    expect(observeEnvironment(state("SOMETHING_NEW"), TAG, null, now)).toEqual({
      kind: "updating",
    });
    expect(
      observeEnvironment(state("DEPLOYING"), TAG, "not a date", now),
    ).toEqual({ kind: "updating" });
    expect(observeEnvironment(state("DRAFT"), TAG, "not a date", now)).toEqual({
      kind: "updating",
    });
  });
});

describe("observeHealth", () => {
  const D = `sha256:${"a".repeat(64)}`;
  const OLD = `sha256:${"0".repeat(64)}`;
  const W = 300_000;
  const view = (over: Partial<HealthView>): HealthView => ({
    health: "healthy",
    check: null,
    reason: null,
    checkedAt: started(0),
    since: started(HEALTH_STABLE_MS),
    digest: D,
    observedDigest: D,
    ...over,
  });
  const inFlight = {
    update_started_at: started(W + 60_000),
    running_digest: OLD,
  };
  const steady = { update_started_at: started(3_600_000), running_digest: D };
  const target = { tag: TAG, digest: D };

  it("is ready only when healthy for 2 minutes on the target digest", () => {
    expect(
      observeHealth(state("READY"), target, inFlight, view({}), now, W),
    ).toEqual({ kind: "ready" });
    expect(
      observeHealth(
        state("READY"),
        target,
        inFlight,
        view({ since: started(10_000) }),
        now,
        W,
      ),
    ).toEqual({ kind: "updating" });
    expect(
      observeHealth(
        state("READY"),
        target,
        inFlight,
        view({ observedDigest: OLD }),
        now,
        W,
      ),
    ).toEqual({ kind: "updating" });
  });
  it("ignores the document: DEPLOYMENt_FAILED but healthy is ready, READY but crashing is not", () => {
    expect(
      observeHealth(
        state("DEPLOYMENt_FAILED"),
        target,
        inFlight,
        view({}),
        now,
        W,
      ),
    ).toEqual({
      kind: "ready",
    });
    const crash = view({
      health: "unhealthy",
      check: "crash",
      reason: "the container does not start (CrashLoopBackOff)",
      since: started(CONFIRM_MS + 1),
    });
    expect(
      observeHealth(state("READY"), target, inFlight, crash, now, W),
    ).toEqual({
      kind: "failed",
      reason:
        "unhealthy (crash: the container does not start (CrashLoopBackOff))",
    });
  });
  it("gives an update the window, and a single bad check never fails it", () => {
    const bad = view({
      health: "unhealthy",
      check: "connect",
      reason: "Connect answered 500",
      since: started(CONFIRM_MS + 1),
    });
    expect(
      observeHealth(
        state("READY"),
        target,
        { ...inFlight, update_started_at: started(W - 1000) },
        bad,
        now,
        W,
      ),
    ).toEqual({ kind: "updating" });
    expect(
      observeHealth(
        state("READY"),
        target,
        inFlight,
        { ...bad, since: started(1000) },
        now,
        W,
      ),
    ).toEqual({ kind: "updating" });
  });
  it("never fails a starting host before the 20-minute timeout", () => {
    const starting = view({
      health: "unknown",
      check: "switchboard",
      reason: "the switchboard is starting (migrations)",
      since: started(W * 2),
    });
    expect(
      observeHealth(state("READY"), target, inFlight, starting, now, W),
    ).toEqual({ kind: "updating" });
    expect(
      observeHealth(
        state("READY"),
        target,
        { ...inFlight, update_started_at: started(UPDATE_TIMEOUT_MS + 1) },
        starting,
        now,
        W,
      ),
    ).toEqual({
      kind: "failed",
      reason:
        "not healthy after 20 minutes (switchboard: the switchboard is starting (migrations))",
    });
  });
  it("does not trust a check from before the update or about another digest", () => {
    const old = view({ checkedAt: started(W + 120_000) });
    expect(
      observeHealth(state("READY"), target, inFlight, old, now, W),
    ).toEqual({ kind: "updating" });
    expect(
      observeHealth(
        state("READY"),
        target,
        inFlight,
        view({ digest: OLD }),
        now,
        W,
      ),
    ).toEqual({
      kind: "updating",
    });
  });
  it("degrades a steady instance that is not healthy for a minute, never fails it", () => {
    const down = view({
      health: "unknown",
      check: "pod",
      reason: "the pod is starting",
      since: started(DEGRADED_AFTER_MS + 1),
    });
    expect(observeHealth(state("READY"), target, steady, down, now, W)).toEqual(
      {
        kind: "degraded",
        reason: "pod: the pod is starting",
      },
    );
    expect(
      observeHealth(
        state("READY"),
        target,
        steady,
        { ...down, since: started(1000) },
        now,
        W,
      ),
    ).toEqual({
      kind: "unchanged",
    });
    expect(
      observeHealth(
        state("READY"),
        target,
        steady,
        { ...down, check: "data" },
        now,
        W,
      ),
    ).toEqual({
      kind: "unchanged",
    });
    expect(
      observeHealth(
        state("READY"),
        target,
        steady,
        view({ checkedAt: started(600_000) }),
        now,
        W,
      ),
    ).toEqual({
      kind: "unchanged",
    });
  });
  it("counts windows on observed checks: minutes of unknown then one unhealthy check never fails", () => {
    // The monitor restarts since at the first unhealthy check.
    const firstBad = view({
      health: "unhealthy",
      check: "connect",
      reason: "Connect answered 500",
      checkedAt: started(1000),
      since: started(1000),
    });
    expect(
      observeHealth(state("READY"), target, inFlight, firstBad, now, W),
    ).toEqual({ kind: "updating" });
    // Two checks CONFIRM_MS apart agree: failed.
    expect(
      observeHealth(
        state("READY"),
        target,
        inFlight,
        { ...firstBad, since: started(CONFIRM_MS + 1000) },
        now,
        W,
      ).kind,
    ).toBe("failed");
  });
  it("counts windows on observed checks: one healthy check then silence is not ready", () => {
    const once = view({
      checkedAt: started(HEALTH_STABLE_MS + 30_000),
      since: started(HEALTH_STABLE_MS + 30_000),
    });
    expect(
      observeHealth(state("READY"), target, inFlight, once, now, W),
    ).toEqual({ kind: "updating" });
    const down = view({
      health: "unknown",
      check: "pod",
      reason: "the pod is starting",
      checkedAt: started(DEGRADED_AFTER_MS + 30_000),
      since: started(DEGRADED_AFTER_MS + 30_000),
    });
    expect(observeHealth(state("READY"), target, steady, down, now, W)).toEqual(
      { kind: "unchanged" },
    );
  });
  it("never fails an update at the timeout without fresh health data: keeps updating and says why", () => {
    const late = {
      ...inFlight,
      update_started_at: started(UPDATE_TIMEOUT_MS + 1),
    };
    const waiting = {
      kind: "updating",
      reason:
        "not healthy after 20 minutes, but there is no fresh health data; waiting for it",
    };
    // The monitor stopped: the last check is stale.
    expect(
      observeHealth(
        state("READY"),
        target,
        late,
        view({
          health: "unhealthy",
          check: "crash",
          checkedAt: started(600_000),
        }),
        now,
        W,
      ),
    ).toEqual(waiting);
    // Never checked.
    expect(
      observeHealth(
        state("READY"),
        target,
        late,
        view({ health: null, checkedAt: null, since: null }),
        now,
        W,
      ),
    ).toEqual(waiting);
    // Checked, but the cluster data is missing or stale.
    expect(
      observeHealth(
        state("READY"),
        target,
        late,
        view({
          health: "unknown",
          check: "data",
          reason: "the cluster data is older than 5 minutes",
          since: started(UPDATE_TIMEOUT_MS),
        }),
        now,
        W,
      ),
    ).toEqual(waiting);
  });
  it("keeps stopped and gone environments as before", () => {
    expect(
      observeHealth(state("STOPPED"), target, steady, view({}), now, W),
    ).toEqual({ kind: "stopped" });
    expect(
      observeHealth(state("DESTROYED"), target, steady, view({}), now, W).kind,
    ).toBe("failed");
  });
});
