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

  it("returns null for empty input", () => {
    expect(hostToSubdomain("")).toBe(null);
  });
});
