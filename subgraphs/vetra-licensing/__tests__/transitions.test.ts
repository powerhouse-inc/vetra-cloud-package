import { describe, it, expect } from "vitest";
import { computeLicenseTransitions, type LicenseRow } from "../transitions.js";

const NOW = "2026-10-06T12:00:00.000Z";
const row = (over: Partial<LicenseRow>): LicenseRow => ({
  id: "lic-1",
  status: "ISSUED",
  start: "2026-10-01T00:00:00.000Z",
  end: null,
  ...over,
});

describe("computeLicenseTransitions", () => {
  it("activates an issued licence whose start has passed", () => {
    expect(computeLicenseTransitions([row({})], NOW)).toEqual({
      toActivate: ["lic-1"],
      toExpire: [],
    });
  });

  it("leaves an issued licence whose start is in the future", () => {
    const rows = [row({ start: "2027-01-01T00:00:00.000Z" })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });

  it("expires an active licence whose end has passed", () => {
    const rows = [row({ status: "ACTIVE", end: "2026-10-05T00:00:00.000Z" })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: ["lic-1"],
    });
  });

  it("never expires an open-ended active licence", () => {
    const rows = [row({ status: "ACTIVE", end: null })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });

  // Review Focus 1: end precedes start — never activate, go straight to EXPIRED.
  it("expires an issued licence that is already past its end, without activating it", () => {
    const rows = [row({
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-02-01T00:00:00.000Z",
    })];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: ["lic-1"],
    });
  });

  it("ignores terminal statuses", () => {
    const rows: LicenseRow[] = [
      row({ id: "a", status: "EXPIRED", end: "2020-01-01T00:00:00.000Z" }),
      row({ id: "b", status: "REVOKED" }),
      row({ id: "c", status: "REPLACED" }),
    ];
    expect(computeLicenseTransitions(rows, NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });

  it("treats a null start as not yet startable", () => {
    expect(computeLicenseTransitions([row({ start: null })], NOW)).toEqual({
      toActivate: [],
      toExpire: [],
    });
  });
});
