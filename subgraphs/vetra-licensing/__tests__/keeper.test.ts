import { describe, it, expect, vi, afterEach } from "vitest";
import { LicenseKeeper } from "../keeper.js";
import type { LicenseRow } from "../transitions.js";

const cfg = { enabled: true, dryRun: false, scanIntervalMs: 60_000 };
const rows: LicenseRow[] = [
  { id: "a", status: "ISSUED", start: "2026-01-01T00:00:00.000Z", end: null },
  { id: "b", status: "ACTIVE", start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
];

const deps = (over: Record<string, unknown> = {}) => ({
  listLicenses: vi.fn(async () => rows),
  activate: vi.fn(async () => undefined),
  expire: vi.fn(async () => undefined),
  now: () => "2026-10-06T12:00:00.000Z",
  cfg,
  logger: { info: vi.fn(), warn: vi.fn() },
  ...over,
});

describe("LicenseKeeper", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  it("activates and expires in one pass", async () => {
    const d = deps();
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.activate).toHaveBeenCalledWith("a");
    expect(d.expire).toHaveBeenCalledWith("b");
  });

  it("does nothing when disabled", async () => {
    const d = deps({ cfg: { ...cfg, enabled: false } });
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.listLicenses).not.toHaveBeenCalled();
  });

  it("logs but does not act in dry run", async () => {
    const d = deps({ cfg: { ...cfg, dryRun: true } });
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.expire).not.toHaveBeenCalled();
    expect(d.logger.info).toHaveBeenCalled();
  });

  it("keeps going when one transition throws", async () => {
    const d = deps({
      activate: vi.fn(async () => { throw new Error("boom"); }),
    });
    await new LicenseKeeper(d as never).reconcileOnce();
    expect(d.expire).toHaveBeenCalledWith("b");
    expect(d.logger.warn).toHaveBeenCalled();
  });
});
