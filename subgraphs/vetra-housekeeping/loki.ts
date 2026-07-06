import { AUTOMATION_PATHS, AUTOMATION_USER_AGENTS } from "./policy.js";

/**
 * Loki access-log field names (Traefik JSON access log, flattened by Loki's
 * `| json`). Overridable via env in case the shipped field names differ — the
 * exact names are validated against real logs during rollout.
 */
export interface LokiFields {
  host: string;
  path: string;
  userAgent: string;
}

export const DEFAULT_LOKI_FIELDS: LokiFields = {
  host: process.env.LOKI_FIELD_HOST ?? "RequestHost",
  path: process.env.LOKI_FIELD_PATH ?? "RequestPath",
  userAgent: process.env.LOKI_FIELD_UA ?? "request_User_Agent",
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex (anchored) matching automation request paths from the shared denylist. */
export function automationPathRegex(): string {
  const alts = AUTOMATION_PATHS.map((p) =>
    p.endsWith("/") ? `${escapeRe(p)}.*` : escapeRe(p),
  );
  return `^(${alts.join("|")})$`;
}

/** Case-insensitive regex matching automation user-agents from the shared denylist. */
export function automationUaRegex(): string {
  return `(?i)(${AUTOMATION_USER_AGENTS.map(escapeRe).join("|")})`;
}

/** Stream selector for a single host's Traefik access logs. */
function hostStream(selector: string, host: string, fields: LokiFields): string {
  // Pre-filter with a line match on the host string BEFORE `| json`: RequestHost
  // is a *parsed* field, not a stream label, so without this Loki must JSON-parse
  // every Traefik log line in the window (all of vetra.io's traffic) for every
  // host — a full 24h scan that reliably times out the query. The literal host
  // appears verbatim in each of its log lines, so `|= host` prunes ~all
  // non-matching lines with a cheap substring grep before the expensive parse.
  return `${selector} |= \`${host}\` | json | ${fields.host}=\`${host}\``;
}

/**
 * LogQL instant query counting *proper* requests to `host` over the trailing
 * window — requests whose path and user-agent are NOT on the automation denylist.
 */
export function buildProperRequestCountQuery(
  selector: string,
  host: string,
  windowSeconds: number,
  fields: LokiFields = DEFAULT_LOKI_FIELDS,
): string {
  const stream =
    `${hostStream(selector, host, fields)}` +
    ` | ${fields.path}!~\`${automationPathRegex()}\`` +
    ` | ${fields.userAgent}!~\`${automationUaRegex()}\``;
  return `sum(count_over_time((${stream})[${windowSeconds}s]))`;
}

/** LogQL counting ALL requests to `host` (incl. automation) over the window. */
export function buildTotalRequestCountQuery(
  selector: string,
  host: string,
  windowSeconds: number,
  fields: LokiFields = DEFAULT_LOKI_FIELDS,
): string {
  return `sum(count_over_time((${hostStream(selector, host, fields)})[${windowSeconds}s]))`;
}

/**
 * Stream selector for MANY hosts at once: `| json` then `RequestHost=~` on the
 * host alternation. Grouping downstream (`sum by (RequestHost)`) yields a per-host
 * count from a single stream scan.
 *
 * NB: deliberately NO `|~` line pre-filter here. For a single host a `|=` literal
 * grep is cheap, but a `|~` regex alternation of 30–40 full domains evaluated
 * against every raw line before `| json` is pathological — it turned a ~6s scan
 * into a >120s timeout. `| json | RequestHost=~` alone does 32 hosts × 24h in ~6s.
 */
function hostsStream(selector: string, hosts: string[], fields: LokiFields): string {
  const alt = hosts.map(escapeRe).join("|");
  return `${selector} | json | ${fields.host}=~\`${alt}\``;
}

/**
 * Grouped variant of {@link buildProperRequestCountQuery} — one query counting
 * *proper* (non-automation) requests for every host in `hosts`, grouped by host.
 */
export function buildGroupedProperRequestCountQuery(
  selector: string,
  hosts: string[],
  windowSeconds: number,
  fields: LokiFields = DEFAULT_LOKI_FIELDS,
): string {
  const stream =
    `${hostsStream(selector, hosts, fields)}` +
    ` | ${fields.path}!~\`${automationPathRegex()}\`` +
    ` | ${fields.userAgent}!~\`${automationUaRegex()}\``;
  return `sum by (${fields.host}) (count_over_time((${stream})[${windowSeconds}s]))`;
}

/** Grouped variant of {@link buildTotalRequestCountQuery} — all requests per host. */
export function buildGroupedTotalRequestCountQuery(
  selector: string,
  hosts: string[],
  windowSeconds: number,
  fields: LokiFields = DEFAULT_LOKI_FIELDS,
): string {
  return `sum by (${fields.host}) (count_over_time((${hostsStream(selector, hosts, fields)})[${windowSeconds}s]))`;
}

/**
 * Activity classification for a studio host:
 *  - ACTIVE  — at least one proper (non-automation) request in the window.
 *  - IDLE    — access logs exist for the host but NONE are proper requests.
 *  - UNKNOWN — no access logs at all (signal unavailable) or the query failed.
 *
 * The UNKNOWN vs IDLE distinction is critical: a host with zero total log lines
 * means we can't measure (Traefik access logs off / not reaching Loki), NOT that
 * the studio is idle. Every live studio is polled by the observability worker
 * every 15s, so once access logs work total-requests is always > 0 — making
 * `total == 0` a reliable "can't measure" signal. The keeper sleeps only on IDLE.
 */
export type HostActivity = "ACTIVE" | "IDLE" | "UNKNOWN";

/**
 * Verdict for one host from its request counts + whether the log pipeline is
 * proven live this scan (a canary host known to always receive traffic had
 * requests in the window).
 *
 *  - proper > 0            → ACTIVE  (real user traffic)
 *  - total  > 0, proper 0  → IDLE    (logs exist, all automation)
 *  - total == 0, healthy   → IDLE    (pipeline proven live ⇒ zero requests is
 *                                     genuine idleness, not a missing signal)
 *  - total == 0, !healthy  → UNKNOWN (can't tell idle from a broken pipeline —
 *                                     fail safe, never slept; the dev.140 guard)
 *
 * The `pipelineHealthy` canary is what lets us reclaim genuinely-silent studios
 * (the common case) without risking a fleet-wide sleep when Traefik→Loki breaks.
 */
export function classifyActivity(
  proper: number,
  total: number,
  pipelineHealthy: boolean,
): HostActivity {
  if (proper > 0) return "ACTIVE";
  if (total > 0) return "IDLE";
  return pipelineHealthy ? "IDLE" : "UNKNOWN";
}

export interface LokiClient {
  /**
   * Classify a batch of hosts in as few Loki queries as possible (two grouped
   * queries per chunk). Returns a verdict for every input host. Preferred over
   * per-host calls: 40 studios was 80 separate queries that saturated Loki's
   * query queue (queueTime ≫ execTime) and timed out to all-UNKNOWN.
   */
  classifyHosts(hosts: string[], windowSeconds: number): Promise<Map<string, HostActivity>>;
  /** Single-host convenience wrapper over {@link classifyHosts} (optional; the
   * keeper only uses the batched form). */
  classifyHostActivity?(host: string, windowSeconds: number): Promise<HostActivity>;
}

/** Max hosts per grouped query — keeps the alternation regex + URL bounded. */
const HOSTS_PER_QUERY = 40;

export function createLokiClient(opts: {
  lokiUrl: string;
  selector: string;
  fields?: LokiFields;
  fetchTimeoutMs?: number;
  /**
   * A host known to ALWAYS receive Traefik traffic (e.g. the switchboard apex).
   * Each scan we check it has requests in the window; if so the Traefik→Loki
   * pipeline is proven live and a studio's `total == 0` is trusted as idle. If
   * unset (or the canary is silent), we fall back to the conservative
   * `total == 0 ⇒ UNKNOWN` (never sleep) behaviour.
   */
  canaryHost?: string;
  logger?: { warn: (m: string) => void };
}): LokiClient {
  const fields = opts.fields ?? DEFAULT_LOKI_FIELDS;
  const timeout = opts.fetchTimeoutMs ?? 30_000;

  /** Run a grouped query; return host→count for the hosts that had matches. */
  async function countByHost(query: string): Promise<Map<string, number>> {
    const url = `${opts.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(query)}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`loki ${res.status}`);
      const body = (await res.json()) as {
        data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
      };
      const out = new Map<string, number>();
      for (const r of body.data?.result ?? []) {
        const host = r.metric?.[fields.host];
        if (host) out.set(host, Number(r.value?.[1] ?? 0));
      }
      return out;
    } finally {
      clearTimeout(t);
    }
  }

  /** True if the canary host had ANY traffic in the window ⇒ pipeline is live. */
  async function canaryHealthy(windowSeconds: number): Promise<boolean> {
    if (!opts.canaryHost) return false;
    try {
      const counts = await countByHost(
        buildGroupedTotalRequestCountQuery(opts.selector, [opts.canaryHost], windowSeconds, fields),
      );
      return (counts.get(opts.canaryHost) ?? 0) > 0;
    } catch {
      return false; // can't confirm the pipeline ⇒ stay conservative
    }
  }

  async function classifyChunk(
    hosts: string[],
    windowSeconds: number,
    pipelineHealthy: boolean,
    out: Map<string, HostActivity>,
  ): Promise<void> {
    try {
      // Proper + total are independent — fire both at once to halve wall-time.
      const [proper, total] = await Promise.all([
        countByHost(buildGroupedProperRequestCountQuery(opts.selector, hosts, windowSeconds, fields)),
        countByHost(buildGroupedTotalRequestCountQuery(opts.selector, hosts, windowSeconds, fields)),
      ]);
      for (const host of hosts) {
        const p = proper.get(host) ?? 0;
        const tot = total.get(host) ?? 0;
        out.set(host, classifyActivity(p, tot, pipelineHealthy));
      }
    } catch (err) {
      // Fail-safe: anything we couldn't measure stays UNKNOWN (never slept).
      opts.logger?.warn(
        `[loki] grouped query failed for ${hosts.length} host(s): ${err instanceof Error ? err.message : String(err)} — UNKNOWN`,
      );
      for (const host of hosts) if (!out.has(host)) out.set(host, "UNKNOWN");
    }
  }

  const client: LokiClient = {
    async classifyHosts(hosts, windowSeconds) {
      const out = new Map<string, HostActivity>();
      // Prove the pipeline is live ONCE per scan via the canary, then trust
      // `total == 0` as genuine idleness for every host this scan.
      const healthy = await canaryHealthy(windowSeconds);
      for (let i = 0; i < hosts.length; i += HOSTS_PER_QUERY) {
        await classifyChunk(hosts.slice(i, i + HOSTS_PER_QUERY), windowSeconds, healthy, out);
      }
      return out;
    },
    async classifyHostActivity(host, windowSeconds) {
      return (await client.classifyHosts([host], windowSeconds)).get(host) ?? "UNKNOWN";
    },
  };
  return client;
}
