import { describe, expect, it, vi } from "vitest";
import { createTenantOwnersCheck } from "./tenant-owners.js";

const WAIT = { timeoutMs: 20, intervalMs: 5 };

describe("createTenantOwnersCheck", () => {
  it("returns the projected owners", async () => {
    const check = createTenantOwnersCheck(
      async () => ["0xaa", null],
      WAIT,
      "[t]",
    );
    expect(await check("t1")).toStrictEqual({
      ok: true,
      owners: ["0xaa", null],
    });
  });

  it("waits, then reports an unknown tenant", async () => {
    const lookup = vi.fn(async () => [] as (string | null)[]);
    const check = createTenantOwnersCheck(lookup, WAIT, "[t]");
    expect(await check("t1")).toStrictEqual({ ok: false, reason: "UNKNOWN" });
    expect(lookup.mock.calls.length).toBeGreaterThan(1);
  });

  it("fails closed when the projection table is missing (42P01), and logs", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const check = createTenantOwnersCheck(
      async () =>
        Promise.reject(Object.assign(new Error("x"), { code: "42P01" })),
      WAIT,
      "[t] probe",
    );
    expect(await check("t1")).toStrictEqual({
      ok: false,
      reason: "UNVERIFIABLE",
    });
    expect(error).toHaveBeenCalledWith(
      "[t] probe: tenant projection unreadable (42P01)",
    );
    error.mockRestore();
  });

  it("is BUSY when every waiter slot is taken, and rethrows other errors", async () => {
    const busy = createTenantOwnersCheck(
      async () => [],
      { ...WAIT, maxWaiters: 0 },
      "[t]",
    );
    expect(await busy("t1")).toStrictEqual({ ok: false, reason: "BUSY" });
    const broken = createTenantOwnersCheck(
      async () => Promise.reject(new Error("boom")),
      WAIT,
      "[t]",
    );
    await expect(broken("t1")).rejects.toThrow("boom");
  });
});
