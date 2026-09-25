import { afterEach, describe, expect, it } from "vitest";
import { callerIsAdmin } from "./admins.js";

/*
  reactor-api never injects ctx.isAdmin into subgraph context; it checks the
  caller against the ADMINS env itself. The observability subgraph relied on
  ctx.isAdmin, so every "owner or admin" mutation was owner-only in practice.
*/

afterEach(() => {
  delete process.env.ADMINS;
});

describe("callerIsAdmin", () => {
  it("matches the ADMINS env, case-insensitively and trimmed", () => {
    process.env.ADMINS = "0xAAA, 0xBbB";
    expect(callerIsAdmin({}, "0xaaa")).toBe(true);
    expect(callerIsAdmin({}, "0XBBB")).toBe(true);
    expect(callerIsAdmin({}, "0xccc")).toBe(false);
  });

  it("is false without ADMINS or without an address", () => {
    expect(callerIsAdmin({}, "0xaaa")).toBe(false);
    process.env.ADMINS = "0xaaa";
    expect(callerIsAdmin({}, undefined)).toBe(false);
    expect(callerIsAdmin({}, "")).toBe(false);
  });

  it("prefers a host-provided ctx.isAdmin", () => {
    process.env.ADMINS = "0xaaa";
    expect(callerIsAdmin({ isAdmin: () => false }, "0xaaa")).toBe(false);
    expect(callerIsAdmin({ isAdmin: (a) => a === "0xzzz" }, "0xzzz")).toBe(true);
  });
});
