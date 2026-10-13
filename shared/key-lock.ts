/**
 * Process-wide in-memory lock per key: calls for one key run one after the
 * other, calls for different keys run concurrently. Shared by every subgraph
 * in the process (vetra-cloud-observability's org sync and vetra-apps'
 * ownership sync both lock environments by document id here), so it must
 * stay in one module instance.
 */
const locks = new Map<string, Promise<unknown>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** The lock of one environment document (org sync, hand-overs, app ownership moves). */
export function withEnvLock<T>(envId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(envId, fn);
}

/** The lock of one App row (ownership sync); never an environment id. */
export function withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`app:${appId}`, fn);
}
