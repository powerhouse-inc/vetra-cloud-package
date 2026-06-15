import { describe, it, expect, vi } from "vitest";
import { makeClaimDb, makeKeeperDb } from "./pool-db.js";

function fakeKysely(rows: unknown[]) {
  const exec = vi.fn(async () => rows);
  const chain: any = new Proxy(
    {},
    {
      get(_t, p) {
        if (p === "execute") return exec;
        return () => chain;
      },
    },
  );
  return { db: chain, exec };
}

describe("makeClaimDb", () => {
  it("markFailed issues one update", async () => {
    const { db, exec } = fakeKysely([]);
    await makeClaimDb(db as never).markFailed("d1");
    expect(exec).toHaveBeenCalledOnce();
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
  it("markFailed updates one id", async () => {
    const { db, exec } = fakeKysely([]);
    await makeKeeperDb(db as never).markFailed("d");
    expect(exec).toHaveBeenCalledOnce();
  });
});
