/** An acquire with `timeoutMs` did not get the key in time; its fn never runs. */
export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
}

interface Waiter {
  /** Hands the key to this waiter; a no-op once it has given up. */
  start(): void;
}

export interface AcquireOptions {
  /** Give up waiting after this long: the slot is left and fn is never run. */
  timeoutMs?: number;
}

/**
 * In-process keyed mutex: callers with the same key run one at a time, in
 * order; different keys run concurrently. A rejected call releases the key.
 * An acquire with a timeout that expires leaves the queue (callers behind it
 * move up) and rejects with LockTimeoutError without ever running its fn.
 */
export function keyedMutex(): <T>(key: string, fn: () => Promise<T>, opts?: AcquireOptions) => Promise<T> {
  /** key -> waiters; the first one holds the key. */
  const queues = new Map<string, Waiter[]>();
  return async <T>(key: string, fn: () => Promise<T>, opts: AcquireOptions = {}): Promise<T> => {
    let queue = queues.get(key);
    if (!queue) {
      queue = [];
      queues.set(key, queue);
    }
    const q = queue;
    const dropIfEmpty = () => {
      if (q.length === 0 && queues.get(key) === q) queues.delete(key);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = { start: () => {} };
    // Settled exactly once, synchronously: either the key was handed over or
    // the waiter gave up, never both.
    const acquired = new Promise<boolean>((resolve) => {
      let settled = false;
      waiter.start = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          q.splice(q.indexOf(waiter), 1);
          dropIfEmpty();
          resolve(false);
        }, opts.timeoutMs);
      }
    });
    q.push(waiter);
    if (q.length === 1) waiter.start();
    if (!(await acquired)) {
      throw new LockTimeoutError(`gave up waiting for ${key} after ${opts.timeoutMs}ms`);
    }
    try {
      return await fn();
    } finally {
      q.shift();
      const next = q.at(0);
      if (next) next.start();
      else dropIfEmpty();
    }
  };
}
