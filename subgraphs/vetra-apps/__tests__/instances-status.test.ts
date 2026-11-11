import { describe, expect, it } from "vitest";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { observeEnvironment, UPDATE_TIMEOUT_MS } from "../instances/status.js";

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
});
