/**
 * In-memory rate limits and counters of the licence gate route (releases
 * phase 3 slice 5, G6/G7). Per switchboard replica.
 */

/**
 * A token bucket per key: `burst` tokens, refilled continuously at
 * `ratePerSec`. Over `maxKeys` keys the least recently used goes (Map
 * insertion order, re-inserted on use).
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  private current(key: string): { tokens: number; at: number } {
    const t = this.now();
    const b = this.buckets.get(key);
    const tokens = b
      ? Math.min(
          this.burst,
          b.tokens + (Math.max(0, t - b.at) / 1000) * this.ratePerSec,
        )
      : this.burst;
    this.buckets.delete(key);
    const next = { tokens, at: t };
    this.buckets.set(key, next);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return next;
  }

  /** Takes one token; false when the key's bucket is empty. */
  take(key: string): boolean {
    const b = this.current(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Gives one token back (a take that turned out not to count). */
  refund(key: string): void {
    const b = this.current(key);
    b.tokens = Math.min(this.burst, b.tokens + 1);
  }
}

/** Counts per 5-minute log line: per instance (checks, allowed, denied) and totals. */
export class GateCounters {
  private perInstance = new Map<string, { allowed: number; denied: number }>();
  private totals = { unauthorized: 0, limited: 0, failed: 0 };

  hit(instanceId: string, allowed: boolean): void {
    const c = this.perInstance.get(instanceId) ?? { allowed: 0, denied: 0 };
    if (allowed) c.allowed++;
    else c.denied++;
    this.perInstance.set(instanceId, c);
  }
  unauthorized(): void {
    this.totals.unauthorized++;
  }
  limited(): void {
    this.totals.limited++;
  }
  failed(): void {
    this.totals.failed++;
  }

  /** One line, then reset; null when nothing happened. */
  flush(): string | null {
    let allowed = 0;
    let denied = 0;
    const per: string[] = [];
    for (const [id, c] of this.perInstance) {
      allowed += c.allowed;
      denied += c.denied;
      per.push(`${id}:${c.allowed + c.denied}/${c.allowed}/${c.denied}`);
    }
    const { unauthorized, limited, failed } = this.totals;
    const checks = allowed + denied;
    this.perInstance = new Map();
    this.totals = { unauthorized: 0, limited: 0, failed: 0 };
    if (checks + unauthorized + limited + failed === 0) return null;
    return (
      `checks=${checks} allowed=${allowed} denied=${denied} ` +
      `unauthorized=${unauthorized} limited=${limited} failed=${failed}` +
      (per.length ? ` instances(checks/allowed/denied)=${per.join(",")}` : "")
    );
  }
}
