import { describe, it, expect, vi } from "vitest";
import { makeClaimDb, makeKeeperDb } from "./pool-db.js";

function fakeKysely(rows: any[]) {
  const exec = vi.fn(async () => rows);
  const execFirst = vi.fn(async () => rows[0]);
  const chain: any = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === "execute") return exec;
        if (p === "executeTakeFirst") return execFirst;
        return () => chain;
      },
    },
  );
  return { db: chain, exec, execFirst };
}

describe("makeClaimDb", () => {
  it("claimOneAvailable issues the atomic update and returns the row", async () => {
    const { db, execFirst } = fakeKysely([{ id: "d1", tenantId: "t", subdomain: "s", poolState: "CLAIMED" }]);
    const row = await makeClaimDb(db as never).claimOneAvailable("0xabc", "0.0.1-dev.19", "2026-06-15T00:00:00Z");
    expect(execFirst).toHaveBeenCalledOnce();
    expect(row).toEqual({ id: "d1", tenantId: "t", subdomain: "s", poolState: "CLAIMED" });
  });
  it("returns null when nothing is available", async () => {
    const { db } = fakeKysely([]);
    expect(await makeClaimDb(db as never).claimOneAvailable("0xabc", "v", "t")).toBeNull();
  });
});

describe("makeKeeperDb", () => {
  it("listPoolRows returns rows", async () => {
    const { db, exec } = fakeKysely([{ id: "a" }]);
    expect(await makeKeeperDb(db as never).listPoolRows()).toEqual([{ id: "a" }]);
    expect(exec).toHaveBeenCalledOnce();
  });
  it("seedWarming upserts by id", async () => {
    const { db, exec } = fakeKysely([]);
    await makeKeeperDb(db as never).seedWarming({
      id: "d",
      subdomain: "s",
      tenantId: "t",
      pinnedVersion: "0.0.1-dev.19",
    });
    expect(exec).toHaveBeenCalledOnce();
  });
  it("promoteReadyToAvailable updates", async () => {
    const { db, exec } = fakeKysely([]);
    await makeKeeperDb(db as never).promoteReadyToAvailable();
    expect(exec).toHaveBeenCalledOnce();
  });
  it("clearPoolState updates the given ids", async () => {
    const { db, exec } = fakeKysely([]);
    await makeKeeperDb(db as never).clearPoolState(["d1", "d2"]);
    expect(exec).toHaveBeenCalledOnce();
  });
  it("clearPoolState is a no-op for empty ids", async () => {
    const { db, exec } = fakeKysely([]);
    await makeKeeperDb(db as never).clearPoolState([]);
    expect(exec).not.toHaveBeenCalled();
  });
});
