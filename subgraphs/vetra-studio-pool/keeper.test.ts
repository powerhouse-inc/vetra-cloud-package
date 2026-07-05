import { describe, it, expect, vi } from "vitest";
import { PoolKeeper } from "./keeper.js";

function deps(rows: any[]) {
  return {
    db: {
      listPoolRows: vi.fn(async () => rows),
      seedWarming: vi.fn(async () => {}),
      promoteReadyToAvailable: vi.fn(async () => {}),
      clearPoolState: vi.fn(async () => {}),
    },
    createEnv: vi.fn(async () => ({
      documentId: "new",
      subdomain: "warm-newt-aaaa1111",
      tenantId: "warm-newt-aaaa1111-aaaa1111",
    })),
    deleteEnv: vi.fn(async () => {}),
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

  it("recycles stale-version unclaimed envs by DELETING them (full teardown, not a TERMINATING husk)", async () => {
    const d = deps([
      { id: "old", poolState: "AVAILABLE", pinnedVersion: "0.0.1-dev.18", status: "READY" },
    ]);
    await new PoolKeeper(d as never).reconcileOnce();
    expect(d.deleteEnv).toHaveBeenCalledWith("old");
  });

  it("TERMINATES (deletes) a dead unclaimed warm env, not merely clearing it", async () => {
    const d = deps([
      { id: "z", poolState: "AVAILABLE", pinnedVersion: "0.0.1-dev.19", status: "TERMINATING" },
    ]);
    await new PoolKeeper(d as never).reconcileOnce();
    expect(d.deleteEnv).toHaveBeenCalledWith("z");
    expect(d.db.clearPoolState).not.toHaveBeenCalledWith(["z"]);
    // dead env not counted → still needs to create the full pool
    expect(d.createEnv).toHaveBeenCalledTimes(2);
  });

  it("clears (never deletes) a dead CLAIMED env — owner controls its lifecycle", async () => {
    const d = deps([
      { id: "c", poolState: "CLAIMED", pinnedVersion: "0.0.1-dev.19", status: "DESTROYED" },
    ]);
    await new PoolKeeper(d as never).reconcileOnce();
    expect(d.db.clearPoolState).toHaveBeenCalledWith(["c"]);
    expect(d.deleteEnv).not.toHaveBeenCalledWith("c");
  });

  it("deletes the orphan doc when seeding fails after creation", async () => {
    const d = deps([]);
    d.db.seedWarming = vi.fn(async () => {
      throw new Error("db down");
    });
    await new PoolKeeper(d as never).reconcileOnce();
    // createEnv returns documentId "new" twice (size 2); each seed fails → delete
    expect(d.deleteEnv).toHaveBeenCalledWith("new");
    expect(d.logger.warn).toHaveBeenCalled();
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
