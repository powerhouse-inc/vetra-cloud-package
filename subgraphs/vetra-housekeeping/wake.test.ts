import { describe, expect, it, vi } from "vitest";
import { createWake } from "./wake.js";

const row = { envId: "e1", subdomain: "s", status: "STOPPED", owner: "0x1", poolState: null, tenantId: "t", services: null };

describe("housekeeping wake", () => {
  it("wakes a sleeping studio", async () => {
    const dispatchWake = vi.fn(async () => {});
    const wake = createWake({ findStudioByHost: async () => row, dispatchWake, isLicenceStopped: async () => false });
    expect((await wake("s.vetra.io")).status).toBe("WAKING");
    expect(dispatchWake).toHaveBeenCalledWith("e1");
  });
  it("refuses to wake an environment licensing has stopped", async () => {
    const dispatchWake = vi.fn(async () => {});
    const wake = createWake({ findStudioByHost: async () => row, dispatchWake, isLicenceStopped: async () => true });
    expect((await wake("s.vetra.io")).status).toBe("SLEEPING");
    expect(dispatchWake).not.toHaveBeenCalled();
  });
  it("throws STUDIO_NOT_FOUND for an unknown host", async () => {
    const wake = createWake({ findStudioByHost: async () => null, dispatchWake: vi.fn(), isLicenceStopped: async () => false });
    await expect(wake("x.vetra.io")).rejects.toThrow("STUDIO_NOT_FOUND");
  });
});

describe("housekeeping wake (other states)", () => {
  it("reports an awake studio without waking it", async () => {
    const dispatchWake = vi.fn(async () => {});
    const awake = { ...row, status: "READY", poolState: "CLAIMED" };
    const wake = createWake({ findStudioByHost: async () => awake, dispatchWake, isLicenceStopped: async () => false });
    expect((await wake("s.vetra.io")).status).not.toBe("WAKING");
    expect(dispatchWake).not.toHaveBeenCalled();
  });
});
