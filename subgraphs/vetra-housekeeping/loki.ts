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

/**
 * Build the LogQL instant query that counts *proper* requests to `host` over the
 * trailing `windowSeconds` — i.e. requests whose path and user-agent are NOT on
 * the automation denylist.
 */
export function buildProperRequestCountQuery(
  selector: string,
  host: string,
  windowSeconds: number,
  fields: LokiFields = DEFAULT_LOKI_FIELDS,
): string {
  const stream =
    `${selector} | json` +
    ` | ${fields.host}=\`${host}\`` +
    ` | ${fields.path}!~\`${automationPathRegex()}\`` +
    ` | ${fields.userAgent}!~\`${automationUaRegex()}\``;
  return `sum(count_over_time((${stream})[${windowSeconds}s]))`;
}

export interface LokiClient {
  /** True if `host` received at least one proper request in the last `windowSeconds`. */
  hasRecentProperRequest(host: string, windowSeconds: number): Promise<boolean>;
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
  return {
    async hasRecentProperRequest(host, windowSeconds) {
      const query = buildProperRequestCountQuery(opts.selector, host, windowSeconds, fields);
      const url = `${opts.lokiUrl}/loki/api/v1/query?query=${encodeURIComponent(query)}`;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) throw new Error(`loki ${res.status}`);
        const body = (await res.json()) as {
          data?: { result?: Array<{ value?: [number, string] }> };
        };
        const result = body.data?.result ?? [];
        const count = result.reduce((acc, r) => acc + Number(r.value?.[1] ?? 0), 0);
        return count > 0;
      } catch (err) {
        // Fail-safe: if we can't measure, treat the studio as active so we
        // never sleep something we can't prove is idle.
        opts.logger?.warn(
          `[loki] query failed for ${host}: ${err instanceof Error ? err.message : String(err)} — treating as active`,
        );
        return true;
      } finally {
        clearTimeout(t);
      }
    },
  };
}
