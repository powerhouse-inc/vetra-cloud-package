import { describe, it, expect, vi } from "vitest";
import { releaseEnvironment } from "../release.js";

const deps = (over: Record<string, unknown> = {}) => ({
  findRowByEnvironment: vi.fn(async () => ({
    app_id: "app-1",
    user_address: "0xaaa",
    environment_id: "env-1",
  })),
  environmentStatus: vi.fn(async () => "READY"),
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

  // Housekeeping sleeps idle environments on its own, so a licence can easily
  // expire against an already-STOPPED environment. SLEEP_ENVIRONMENT would be
  // rejected and the row would survive forever.
  it.each(["STOPPED", "TERMINATING", "DESTROYED", "ARCHIVED"])(
    "drops the row without sleeping a %s environment",
    async (status) => {
      const d = deps({ environmentStatus: vi.fn(async () => status) });
      await expect(
        releaseEnvironment(d as never, "app-1", "env-1"),
      ).resolves.toBe(true);
      expect(d.stopEnvironment).not.toHaveBeenCalled();
      expect(d.deleteRow).toHaveBeenCalledWith("app-1", "0xaaa");
    },
  );

  it("drops the row when the environment document is gone", async () => {
    const d = deps({ environmentStatus: vi.fn(async () => null) });
    await expect(releaseEnvironment(d as never, "app-1", "env-1")).resolves.toBe(
      true,
    );
    expect(d.stopEnvironment).not.toHaveBeenCalled();
    expect(d.deleteRow).toHaveBeenCalled();
  });

  // A transient status must keep failing so the next tick retries, rather than
  // dropping the row and forgetting a live environment.
  it("lets a rejection from a transient status propagate and keeps the row", async () => {
    const d = deps({
      environmentStatus: vi.fn(async () => "DEPLOYING"),
      stopEnvironment: vi.fn(async () => {
        throw new Error("SLEEP_ENVIRONMENT rejected");
      }),
    });
    await expect(
      releaseEnvironment(d as never, "app-1", "env-1"),
    ).rejects.toThrow("SLEEP_ENVIRONMENT rejected");
    expect(d.deleteRow).not.toHaveBeenCalled();
  });
});
