import { describe, it, expect, vi } from "vitest";
import { makeClaimDb } from "./pool-db.js";

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
