/**
 * Waiting for a just-created environment to be projected, bounded across
 * requests. vetra.io writes a new environment's configuration (secrets
 * subgraph mutations, licensing applyStudioKey) right after pushing its
 * document, before the environment processor may have projected it, so a
 * write to an unknown tenant polls the projection for a while. Unbounded,
 * any Renown identity could pin resolvers and database queries by sending
 * random tenant ids (GraphQL aliases multiply this inside one request).
 *
 * Bounds:
 *  - only callers that pass `wait: true` poll (mutations); reads fail fast;
 *  - one in-flight poll per key, shared by every caller asking for it;
 *  - at most `maxWaiters` (default 16) distinct keys polled at once. Beyond
 *    that the answer is `null` immediately: the caller refuses.
 */
export interface ProjectionWaitOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Max distinct keys being waited on at once (default 16). */
  maxWaiters?: number;
}

export const DEFAULT_MAX_WAITERS = 16;

/**
 * Returns `find(key, { wait })`: the projected rows for `key` (empty when
 * still unknown), or `null` when a wait was needed but every waiter slot is
 * taken. Lookup errors propagate (to every caller sharing the wait).
 */
export function createProjectionWait<T>(
  lookup: (key: string) => Promise<T[]>,
  opts: ProjectionWaitOptions,
): (key: string, o: { wait: boolean }) => Promise<T[] | null> {
  const maxWaiters = opts.maxWaiters ?? DEFAULT_MAX_WAITERS;
  const inFlight = new Map<string, Promise<T[]>>();

  // The caller has just looked (t=0): poll every interval up to the timeout.
  const poll = async (key: string): Promise<T[]> => {
    const attempts = Math.floor(opts.timeoutMs / opts.intervalMs);
    for (let i = 0; i < attempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
      const rows = await lookup(key);
      if (rows.length > 0) return rows;
    }
    return [];
  };

  return async (key, o) => {
    const rows = await lookup(key);
    if (rows.length > 0 || !o.wait) return rows;
    let pending = inFlight.get(key);
    if (!pending) {
      if (inFlight.size >= maxWaiters) return null;
      pending = poll(key).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return pending;
  };
}
