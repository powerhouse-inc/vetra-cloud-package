import { describe, expect, it } from "vitest";
import {
  deriveStudioPowerState,
  isAutomationRequest,
  isEligibleForSleep,
  hasClintService,
  OBSERVABILITY_PULL_USER_AGENT,
} from "./policy.js";

describe("isAutomationRequest", () => {
  it("flags the observability poll path", () => {
    expect(isAutomationRequest("/_proxy/routes", "anything")).toBe(true);
  });

  it("flags health/metrics/acme paths (and prefixes)", () => {
    for (const p of [
      "/health",
      "/healthz",
      "/ready",
      "/metrics",
      "/favicon.ico",
      "/.well-known/acme-challenge/abc123",
    ]) {
      expect(isAutomationRequest(p, null)).toBe(true);
    }
  });

  it("ignores query string and trailing slash when matching", () => {
    expect(isAutomationRequest("/_proxy/routes?x=1", null)).toBe(true);
    expect(isAutomationRequest("/health/", null)).toBe(true);
  });

  it("flags the observability poller and known monitors by user-agent", () => {
    expect(isAutomationRequest("/", OBSERVABILITY_PULL_USER_AGENT)).toBe(true);
    expect(isAutomationRequest("/", "UptimeRobot/2.0")).toBe(true);
    expect(isAutomationRequest("/", "kube-probe/1.31")).toBe(true);
  });

  it("treats a real page load / app path as a proper request", () => {
    expect(isAutomationRequest("/", "Mozilla/5.0 (Macintosh)")).toBe(false);
    expect(isAutomationRequest("/switchboard/graphql", "Mozilla/5.0")).toBe(false);
    expect(isAutomationRequest("/assets/app.js", "Mozilla/5.0")).toBe(false);
  });

  it("does not flag a genuine CLI user (curl/wget are not automation)", () => {
    expect(isAutomationRequest("/d/some-doc", "curl/8.4.0")).toBe(false);
  });

  it("handles null/empty inputs safely", () => {
    expect(isAutomationRequest(null, null)).toBe(false);
    expect(isAutomationRequest("", "")).toBe(false);
  });
});

describe("deriveStudioPowerState", () => {
  it("maps STOPPED → SLEEPING", () => {
    expect(deriveStudioPowerState({ status: "STOPPED" })).toBe("SLEEPING");
  });
  it("maps READY → AWAKE", () => {
    expect(deriveStudioPowerState({ status: "READY" })).toBe("AWAKE");
  });
  it("maps transitional statuses → WAKING", () => {
    expect(deriveStudioPowerState({ status: "DEPLOYING" })).toBe("WAKING");
    expect(deriveStudioPowerState({ status: "CHANGES_APPROVED" })).toBe("WAKING");
  });
  it("maps unknown/terminal/missing → UNKNOWN", () => {
    expect(deriveStudioPowerState({ status: "DESTROYED" })).toBe("UNKNOWN");
    expect(deriveStudioPowerState(null)).toBe("UNKNOWN");
    expect(deriveStudioPowerState({})).toBe("UNKNOWN");
  });
});

const CLINT_SVC = JSON.stringify([{ type: "CLINT", prefix: "agent", enabled: true }]);
const APP_SVC = JSON.stringify([
  { type: "CONNECT", enabled: true },
  { type: "SWITCHBOARD", enabled: true },
]);

describe("hasClintService", () => {
  it("true when a CLINT service is enabled", () => {
    expect(hasClintService(CLINT_SVC)).toBe(true);
    expect(hasClintService(JSON.stringify([{ type: "SWITCHBOARD", enabled: true }, { type: "CLINT", enabled: true }]))).toBe(true);
  });
  it("false for CONNECT+SWITCHBOARD-only apps (served at connect.*/switchboard.*, not the apex)", () => {
    expect(hasClintService(APP_SVC)).toBe(false);
  });
  it("false for a disabled CLINT, null, or malformed JSON", () => {
    expect(hasClintService(JSON.stringify([{ type: "CLINT", enabled: false }]))).toBe(false);
    expect(hasClintService(null)).toBe(false);
    expect(hasClintService("not json")).toBe(false);
  });
});

describe("isEligibleForSleep", () => {
  const base = {
    status: "READY",
    owner: "0xabc",
    poolState: null,
    tenantId: "tall-duck-ab12cd34-9f8e7d6c",
    subdomain: "tall-duck-ab12cd34",
    services: CLINT_SVC,
  };

  it("accepts a claimed, ready CLINT studio", () => {
    expect(isEligibleForSleep(base)).toBe(true);
    expect(isEligibleForSleep({ ...base, poolState: "CLAIMED" })).toBe(true);
  });

  it("rejects non-CLINT envs — CONNECT+SWITCHBOARD apps must NOT be slept (the apex-host bug)", () => {
    expect(isEligibleForSleep({ ...base, services: APP_SVC })).toBe(false);
    expect(isEligibleForSleep({ ...base, services: null })).toBe(false);
  });

  it("rejects non-READY envs (never re-sleep a stopping/deploying one)", () => {
    expect(isEligibleForSleep({ ...base, status: "STOPPED" })).toBe(false);
    expect(isEligibleForSleep({ ...base, status: "DEPLOYING" })).toBe(false);
    expect(isEligibleForSleep({ ...base, status: "TERMINATING" })).toBe(false);
  });

  it("rejects unclaimed / warm-pool envs", () => {
    expect(isEligibleForSleep({ ...base, owner: null })).toBe(false);
    expect(isEligibleForSleep({ ...base, poolState: "AVAILABLE" })).toBe(false);
    expect(isEligibleForSleep({ ...base, poolState: "WARMING" })).toBe(false);
  });

  it("rejects core tenants and the allowlist", () => {
    expect(isEligibleForSleep({ ...base, tenantId: "vetra", subdomain: "vetra" })).toBe(false);
    expect(isEligibleForSleep(base, { allowlist: [base.tenantId] })).toBe(false);
    expect(isEligibleForSleep(base, { allowlist: [base.subdomain] })).toBe(false);
  });

  it("rejects rows with no subdomain", () => {
    expect(isEligibleForSleep({ ...base, subdomain: null })).toBe(false);
  });
});
