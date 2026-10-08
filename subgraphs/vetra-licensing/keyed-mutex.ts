/**
 * In-process keyed mutex: callers with the same key run one at a time, in
 * order; different keys run concurrently. A rejected call releases the key.
 */
export function keyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const tail = prev.then(() => new Promise<void>((r) => (release = r)));
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
