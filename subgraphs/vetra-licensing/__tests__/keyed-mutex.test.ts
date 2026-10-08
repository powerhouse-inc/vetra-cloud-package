import { describe, expect, it, vi } from "vitest";
import { LockTimeoutError, keyedMutex } from "../keyed-mutex.js";

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("keyedMutex", () => {
  it("runs callers with one key one at a time, in order; other keys concurrently", async () => {
    const lock = keyedMutex();
    const order: string[] = [];
    const gate = deferred();
    const a = lock("k", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = lock("k", async () => {
      order.push("b");
    });
    await lock("other", async () => {
      order.push("other");
    });
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toStrictEqual(["a:start", "other", "a:end", "b"]);
  });

  it("releases the key when fn rejects", async () => {
    const lock = keyedMutex();
    await expect(lock("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await lock("k", async () => 1)).toBe(1);
  });

  it("an acquire that times out gives up its slot and never runs fn", async () => {
    const lock = keyedMutex();
    const gate = deferred();
    const holder = lock("k", () => gate.promise);
    const late = vi.fn(async () => "late");
    await expect(lock("k", late, { timeoutMs: 20 })).rejects.toBeInstanceOf(LockTimeoutError);
    // A caller queued behind the timed-out one runs as soon as the holder is done.
    const next = lock("k", async () => "next");
    gate.resolve();
    await holder;
    expect(await next).toBe("next");
    await sleep(20);
    expect(late).not.toHaveBeenCalled();
    // The key is free again.
    expect(await lock("k", async () => "free", { timeoutMs: 20 })).toBe("free");
  });

  it("a free key is acquired at once even with a timeout", async () => {
    const lock = keyedMutex();
    expect(await lock("k", async () => 7, { timeoutMs: 1 })).toBe(7);
  });
});
