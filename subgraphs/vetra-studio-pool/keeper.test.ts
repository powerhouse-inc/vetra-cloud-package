import { describe, it, expect, vi } from "vitest";
import { PoolKeeper } from "./keeper.js";

function deps(rows: any[]) {
  return {
    db: {
      listPoolRows: vi.fn(async () => rows),
      seedWarming: vi.fn(async () => {}),
      promoteReadyToAvailable: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    },
    createEnv: vi.fn(async () => ({
      documentId: "new",
      subdomain: "warm-newt-aaaa1111",
      tenantId: "warm-newt-aaaa1111-aaaa1111",
    })),
    terminate: vi.fn(async () => {}),
    cfg: {
      size: 2,
      version: "0.0.1-dev.19",
      sizeName: "VETRA_AGENT_XXL",
      registry: "https://r",
      enabled: true,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("PoolKeeper.reconcileOnce", () => {
  it("promotes, then creates the deficit and seeds WARMING", async () => {
    const d = deps([
      { id: "a", poolState: "AVAILABLE", pinnedVersion: "0.0.1-dev.19", status: "READY" },
    ]);
    await new PoolKeeper(d as never).reconcileOnce();
    expect(d.db.promoteReadyToAvailable).toHaveBeenCalledOnce();
    expect(d.createEnv).toHaveBeenCalledOnce(); // size 2, 1 current → 1
    expect(d.db.seedWarming).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new", pinnedVersion: "0.0.1-dev.19" }),
    );
  });

  it("recycles stale-version unclaimed envs", async () => {
    const d = deps([
      { id: "old", poolState: "AVAILABLE", pinnedVersion: "0.0.1-dev.18", status: "READY" },
    ]);
    await new PoolKeeper(d as never).reconcileOnce();
    expect(d.terminate).toHaveBeenCalledWith("old");
  });

  it("does not crash when create throws", async () => {
    const d = deps([]);
    d.createEnv = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(new PoolKeeper(d as never).reconcileOnce()).resolves.toBeUndefined();
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    const d = deps([]);
    d.cfg.enabled = false;
    await new PoolKeeper(d as never).reconcileOnce();
    expect(d.db.listPoolRows).not.toHaveBeenCalled();
  });
});
