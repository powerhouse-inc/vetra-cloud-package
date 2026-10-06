import { describe, it, expect, vi } from "vitest";
import { releaseEnvironment } from "../release.js";

const deps = (over: Record<string, unknown> = {}) => ({
  findRowByEnvironment: vi.fn(async () => ({
    app_id: "app-1",
    user_address: "0xaaa",
    environment_id: "env-1",
  })),
  stopEnvironment: vi.fn(async () => undefined),
  deleteRow: vi.fn(async () => undefined),
  ...over,
});

describe("releaseEnvironment", () => {
  it("stops the environment and drops its row", async () => {
    const d = deps();
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(
      true,
    );
    expect(d.stopEnvironment).toHaveBeenCalledWith("env-1");
    expect(d.deleteRow).toHaveBeenCalledWith("app-1", "0xaaa");
  });

  it("is a no-op when the row is already gone", async () => {
    const d = deps({ findRowByEnvironment: vi.fn(async () => null) });
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(
      false,
    );
    expect(d.stopEnvironment).not.toHaveBeenCalled();
  });

  it("refuses an environment belonging to another app", async () => {
    const d = deps();
    await expect(releaseEnvironment(d as never, "app-2", "env-1")).resolves.toBe(
      false,
    );
    expect(d.stopEnvironment).not.toHaveBeenCalled();
    expect(d.deleteRow).not.toHaveBeenCalled();
  });
});
