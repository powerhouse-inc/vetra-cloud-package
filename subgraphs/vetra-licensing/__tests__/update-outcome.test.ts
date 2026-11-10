import { describe, expect, it } from "vitest";
import { observe, updateOutcome } from "../update-outcome.js";

const STARTED = "2026-11-10T12:00:00.000Z";
const SOON = "2026-11-10T12:05:00.000Z";
const LATE = "2026-11-10T12:21:00.000Z";
const TIMEOUT = 20 * 60 * 1000;
const u = { to_version: "1.1.0", started_at: STARTED };
const env = (status: string, fusionVersion: string | null = "1.1.0") => ({
  status,
  fusionVersion,
});

describe("updateOutcome", () => {
  it("succeeds once the environment is READY on the new version", () => {
    expect(updateOutcome(u, env("READY"), SOON, TIMEOUT)).toStrictEqual({
      status: "SUCCEEDED",
      error: null,
    });
  });

  it("fails when the new version's deployment failed", () => {
    expect(
      updateOutcome(u, env("DEPLOYMENt_FAILED"), SOON, TIMEOUT),
    ).toStrictEqual({
      status: "FAILED",
      error: "the deployment of 1.1.0 failed",
    });
  });

  it("waits while it deploys, and for a READY or failed status that is not yet the new version's", () => {
    for (const e of [
      env("CHANGES_APPROVED"),
      env("DEPLOYING"),
      env("READY", "1.0.0"),
      env("DEPLOYMENt_FAILED", "1.0.0"),
      null,
    ]) {
      expect(updateOutcome(u, e, SOON, TIMEOUT)).toBeNull();
    }
  });

  it("fails when it is not READY on the new version within the timeout", () => {
    expect(updateOutcome(u, env("DEPLOYING"), LATE, TIMEOUT)).toStrictEqual({
      status: "FAILED",
      error: "not READY on 1.1.0 within 20 minutes",
    });
    expect(updateOutcome(u, null, LATE, TIMEOUT)?.status).toBe("FAILED");
    expect(
      updateOutcome(
        { ...u, started_at: null },
        env("DEPLOYING"),
        LATE,
        TIMEOUT,
      ),
    ).toBeNull();
  });

  it("reads the status and the FUSION version off a document", () => {
    expect(observe(null)).toBeNull();
    expect(
      observe({
        status: "READY",
        services: [
          { type: "CONNECT", version: "v6" },
          { type: "FUSION", version: "1.1.0" },
        ],
      } as never),
    ).toStrictEqual({ status: "READY", fusionVersion: "1.1.0" });
    expect(observe({ status: "READY", services: [] } as never)).toStrictEqual({
      status: "READY",
      fusionVersion: null,
    });
  });
});
