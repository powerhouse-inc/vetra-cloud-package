import { describe, expect, it } from "vitest";
import { estimateEnvironmentEurPerMonth, parseCpu, parseMemoryGi } from "../warm-cost.js";
import { APP_RESOURCE_MAP } from "../../../processors/vetra-cloud-environment/gitops.js";

describe("estimateEnvironmentEurPerMonth", () => {
  it("parses k8s quantities", () => {
    expect(parseCpu("500m")).toBe(0.5);
    expect(parseCpu("2")).toBe(2);
    expect(parseMemoryGi("1Gi")).toBe(1);
    expect(parseMemoryGi("512Mi")).toBe(0.5);
  });

  it("matches the literal numbers of the gitops FUSION table", () => {
    // XL requests 2 cpu / 4Gi: ceil(max(1, 1)) + 1 = 2 nodes.
    expect(APP_RESOURCE_MAP.VETRA_AGENT_XL.requests).toEqual({ cpu: "2", memory: "4Gi" });
    expect(estimateEnvironmentEurPerMonth("VETRA_AGENT_XL")).toBe(80);
    // XXL requests 4 cpu / 8Gi: ceil(max(2, 2)) + 1 = 3 nodes.
    expect(APP_RESOURCE_MAP.VETRA_AGENT_XXL.requests).toEqual({ cpu: "4", memory: "8Gi" });
    expect(estimateEnvironmentEurPerMonth("VETRA_AGENT_XXL")).toBe(120);
  });

  it("answers every size, and null as the default size", () => {
    for (const size of Object.keys(APP_RESOURCE_MAP)) {
      const r = APP_RESOURCE_MAP[size as keyof typeof APP_RESOURCE_MAP].requests;
      const nodes = Math.ceil(Math.max(parseCpu(r.cpu) / 2, parseMemoryGi(r.memory) / 4)) + 1;
      expect(estimateEnvironmentEurPerMonth(size)).toBe(40 * nodes);
    }
    expect(estimateEnvironmentEurPerMonth("VETRA_AGENT_S")).toBe(80);
    expect(estimateEnvironmentEurPerMonth(null)).toBe(80);
    expect(estimateEnvironmentEurPerMonth("Default")).toBe(80);
  });
});
