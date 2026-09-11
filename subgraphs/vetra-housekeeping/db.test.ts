import { describe, expect, it } from "vitest";
import { hostToSubdomain } from "./db.js";

describe("hostToSubdomain", () => {
  it("extracts the apex studio subdomain", () => {
    expect(hostToSubdomain("tall-duck-ab12cd34.vetra.io")).toBe(
      "tall-duck-ab12cd34",
    );
  });

  it("strips a port and lowercases", () => {
    expect(hostToSubdomain("Tall-Duck-AB12.vetra.io:443")).toBe("tall-duck-ab12");
  });

  it("takes the leading label for deeper hosts", () => {
    expect(hostToSubdomain("cozy-bat-09.staging.vetra.io")).toBe("cozy-bat-09");
  });

  it("resolves flat connect host (<sub>-connect)", () => {
    expect(hostToSubdomain("teal-seal-677b5f64-connect.vetra.io")).toBe(
      "teal-seal-677b5f64",
    );
  });

  it("resolves flat switchboard host (<sub>-switchboard)", () => {
    expect(hostToSubdomain("teal-seal-677b5f64-switchboard.vetra.io")).toBe(
      "teal-seal-677b5f64",
    );
  });

  it("resolves flat agent host (<sub>-vetra-agent)", () => {
    expect(hostToSubdomain("teal-seal-677b5f64-vetra-agent.vetra.io")).toBe(
      "teal-seal-677b5f64",
    );
  });

  it("resolves legacy subdomain-style connect host (connect.<sub>)", () => {
    expect(hostToSubdomain("connect.light-fawn-92.vetra.io")).toBe(
      "light-fawn-92",
    );
  });

  it("resolves legacy subdomain-style switchboard host", () => {
    expect(hostToSubdomain("switchboard.light-fawn-92.vetra.io")).toBe(
      "light-fawn-92",
    );
  });

  it("only strips exact trailing service tokens (no false positives)", () => {
    expect(hostToSubdomain("switchboards-r-us-ab12cd34.vetra.io")).toBe(
      "switchboards-r-us-ab12cd34",
    );
  });

  it("returns null for empty input", () => {
    expect(hostToSubdomain("")).toBe(null);
  });
});
