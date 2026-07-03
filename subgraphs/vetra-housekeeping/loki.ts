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

export interface LokiClient {
  classifyHostActivity(host: string, windowSeconds: number): Promise<HostActivity>;
}

export function createLokiClient(opts: {
  lokiUrl: string;
  selector: string;
  fields?: LokiFields;
  fetchTimeoutMs?: number;
  logger?: { warn: (m: string) => void };
}): LokiClient {
  const fields = opts.fields ?? DEFAULT_LOKI_FIELDS;
  const timeout = opts.fetchTimeoutMs ?? 10_000;

  async function count(query: string): Promise<number> {
    const url = `${opts.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(query)}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`loki ${res.status}`);
      const body = (await res.json()) as {
        data?: { result?: Array<{ value?: [number, string] }> };
      };
      return (body.data?.result ?? []).reduce((acc, r) => acc + Number(r.value?.[1] ?? 0), 0);
    } finally {
      clearTimeout(t);
    }
  }

  return {
    async classifyHostActivity(host, windowSeconds) {
      try {
        const proper = await count(buildProperRequestCountQuery(opts.selector, host, windowSeconds, fields));
        if (proper > 0) return "ACTIVE";
        // No proper requests — but is that real idle, or just no logs at all?
        const total = await count(buildTotalRequestCountQuery(opts.selector, host, windowSeconds, fields));
        if (total === 0) return "UNKNOWN"; // no access logs ⇒ can't measure
        return "IDLE"; // logs exist, all automation
      } catch (err) {
        // Fail-safe: never sleep something we can't measure.
        opts.logger?.warn(
          `[loki] query failed for ${host}: ${err instanceof Error ? err.message : String(err)} — UNKNOWN (treated as active)`,
        );
        return "UNKNOWN";
      }
    },
  };
}
