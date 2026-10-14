import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectionWait } from "./projection-wait.js";

describe("createProjectionWait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const opts = { timeoutMs: 1_000, intervalMs: 100 };

  it("answers from the first look when rows exist, without waiting", async () => {
    const lookup = vi.fn(async () => ["row"]);
    const find = createProjectionWait(lookup, opts);
    expect(await find("t", { wait: true })).toStrictEqual(["row"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not wait unless asked to", async () => {
    const lookup = vi.fn(async () => []);
    const find = createProjectionWait(lookup, opts);
    expect(await find("t", { wait: false })).toStrictEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("polls until the rows appear", async () => {
    let calls = 0;
    const find = createProjectionWait(async () => (++calls < 4 ? [] : ["row"]), opts);
    const p = find("t", { wait: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toStrictEqual(["row"]);
    expect(calls).toBe(4);
  });

  it("gives up after the window with no rows", async () => {
    const lookup = vi.fn(async () => []);
    const find = createProjectionWait(lookup, opts);
    const p = find("t", { wait: true });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await p).toStrictEqual([]);
    // first look at t=0 + one every 100 ms up to 1 s
    expect(lookup).toHaveBeenCalledTimes(11);
  });

  it("shares one in-flight poll per key", async () => {
    const lookup = vi.fn(async (_k: string) => [] as string[]);
    const find = createProjectionWait(lookup, opts);
    const ps = [find("t", { wait: true }), find("t", { wait: true }), find("t", { wait: true })];
    await vi.advanceTimersByTimeAsync(1_100);
    for (const p of ps) expect(await p).toStrictEqual([]);
    // 3 first looks + ONE shared poll of 10, not three
    expect(lookup).toHaveBeenCalledTimes(3 + 10);
  });

  it("refuses (null) beyond the waiter cap, immediately, and frees slots afterwards", async () => {
    const lookup = vi.fn(async (_k: string) => [] as string[]);
    const find = createProjectionWait(lookup, { ...opts, maxWaiters: 2 });
    const a = find("a", { wait: true });
    const b = find("b", { wait: true });
    expect(await find("c", { wait: true })).toBeNull();
    // Joining an existing wait is not a new waiter.
    const a2 = find("a", { wait: true });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await a).toStrictEqual([]);
    expect(await a2).toStrictEqual([]);
    expect(await b).toStrictEqual([]);
    const d = find("d", { wait: true });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await d).toStrictEqual([]);
  });

  it("defaults the cap to 16", async () => {
    const find = createProjectionWait(async () => [] as string[], opts);
    const ps = Array.from({ length: 16 }, (_, i) => find(`k${i}`, { wait: true }));
    expect(await find("k16", { wait: true })).toBeNull();
    await vi.advanceTimersByTimeAsync(1_100);
    await Promise.all(ps);
  });

  it("propagates lookup errors to every joined caller and frees the slot", async () => {
    let fail = false;
    const find = createProjectionWait(
      async () => {
        if (fail) throw new Error("db down");
        return [] as string[];
      },
      { ...opts, maxWaiters: 1 },
    );
    const p = find("t", { wait: true });
    const q = find("t", { wait: true });
    fail = true;
    const outcomes = Promise.allSettled([p, q]);
    await vi.advanceTimersByTimeAsync(200);
    for (const o of await outcomes) expect(o.status).toBe("rejected");
    fail = false;
    const r = find("u", { wait: true });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await r).toStrictEqual([]);
  });
});
