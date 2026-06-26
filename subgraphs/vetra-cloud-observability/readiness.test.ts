import { describe, it, expect } from "vitest";
import {
  coreServicesReady,
  enabledServiceCount,
  type PodReadiness,
} from "./readiness.js";

const SERVICES_2 = JSON.stringify([
  { type: "CLINT", enabled: true },
  { type: "CONNECT", enabled: true },
]);
const SERVICES_1_DISABLED = JSON.stringify([
  { type: "CLINT", enabled: true },
  { type: "CONNECT", enabled: false },
]);

const ready = (n: number): PodReadiness[] =>
  Array.from({ length: n }, () => ({ ready: 1, phase: "RUNNING" }));

describe("enabledServiceCount", () => {
  it("counts only enabled services from a JSON string", () => {
    expect(enabledServiceCount(SERVICES_2)).toBe(2);
    expect(enabledServiceCount(SERVICES_1_DISABLED)).toBe(1);
  });
  it("accepts an already-parsed array", () => {
    expect(enabledServiceCount([{ enabled: true }, { enabled: true }])).toBe(2);
  });
  it("returns 0 for malformed / empty input", () => {
    expect(enabledServiceCount("not json")).toBe(0);
    expect(enabledServiceCount(null)).toBe(0);
    expect(enabledServiceCount("[]")).toBe(0);
  });
});

describe("coreServicesReady", () => {
  it("ready when all pods are ready+Running and cover every enabled service", () => {
    expect(coreServicesReady(SERVICES_2, ready(2))).toBe(true);
  });

  it("not ready before a service's pod exists (fewer pods than services)", () => {
    expect(coreServicesReady(SERVICES_2, ready(1))).toBe(false);
    expect(coreServicesReady(SERVICES_2, [])).toBe(false);
  });

  it("not ready while any observed pod is not ready", () => {
    expect(
      coreServicesReady(SERVICES_2, [
        { ready: 1, phase: "RUNNING" },
        { ready: 0, phase: "RUNNING" },
      ]),
    ).toBe(false);
  });

  it("not ready while a pod is not Running (e.g. Pending/ContainerCreating)", () => {
    expect(
      coreServicesReady(SERVICES_2, [
        { ready: 1, phase: "RUNNING" },
        { ready: 1, phase: "PENDING" },
      ]),
    ).toBe(false);
  });

  it("handles replicas: extra ready pods still count as ready", () => {
    expect(coreServicesReady(SERVICES_2, ready(3))).toBe(true);
  });

  it("respects disabled services in the expected count", () => {
    expect(coreServicesReady(SERVICES_1_DISABLED, ready(1))).toBe(true);
  });

  it("never ready when there are no enabled services", () => {
    expect(coreServicesReady("[]", ready(2))).toBe(false);
  });

  it("accepts boolean ready flags", () => {
    expect(
      coreServicesReady(SERVICES_1_DISABLED, [{ ready: true, phase: "Running" }]),
    ).toBe(true);
  });
});
