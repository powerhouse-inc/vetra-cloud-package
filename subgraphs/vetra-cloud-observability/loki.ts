import { METRIC_RANGE_VALUES } from "./prometheus.js";

export interface LogEntry {
  timestamp: number;
  line: string;
}

const MAX_LIMIT = 500;

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

interface LokiQueryRangeResponse {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
  };
}

function parseStreams(streams: LokiStream[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const stream of streams) {
    for (const [nsTs, line] of stream.values) {
      // Loki timestamps are nanoseconds
      const timestamp = parseInt(nsTs, 10) / 1e9;
      entries.push({ timestamp, line });
    }
  }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

export class LokiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async queryRange(
    logQuery: string,
    since: string,
    limit: number,
  ): Promise<LogEntry[]> {
    const cappedLimit = Math.min(limit, MAX_LIMIT);
    const duration =
      METRIC_RANGE_VALUES[since] ?? METRIC_RANGE_VALUES.ONE_HOUR;
    const end = Math.floor(Date.now() / 1000);
    const durationSeconds = parseDurationToSeconds(duration);
    const start = end - durationSeconds;

    const params = new URLSearchParams({
      query: logQuery,
      start: String(start),
      end: String(end),
      limit: String(cappedLimit),
    });

    try {
      const res = await fetch(
        `${this.baseUrl}/loki/api/v1/query_range?${params.toString()}`,
      );
      if (!res.ok) {
        return [];
      }
      const json = (await res.json()) as LokiQueryRangeResponse;
      if (json.status !== "success" || json.data.resultType !== "streams") {
        return [];
      }
      return parseStreams(json.data.result);
    } catch {
      return [];
    }
  }

  async logs(
    tenantId: string,
    service: string | null | undefined,
    since = "ONE_HOUR",
    limit = 100,
    /**
     * When provided, restrict the stream to these pod names via Loki's
     * `pod=~` regex matcher. Used by the agent-scoped query path: the
     * resolver looks up pod names labelled `clint.vetra.io/agent=<prefix>`
     * and passes them in. Mutually exclusive with `service` at the
     * resolver layer; this method just trusts the caller.
     */
    podNames?: readonly string[] | null,
  ): Promise<LogEntry[]> {
    let query = `{namespace="${tenantId}"}`;
    if (service) {
      query = `{namespace="${tenantId}", container="${service.toLowerCase()}"}`;
    } else if (podNames && podNames.length > 0) {
      // Loki regex requires escaping any regex metachars present in pod
      // names (k8s names are alphanumeric + `-`, so `-` is the only one
      // that needs escaping but it's harmless — guard anyway).
      const alternation = podNames
        .map((n) => n.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&"))
        .join("|");
      // `pod` is structured metadata in our Alloy/Loki pipeline, NOT an
      // indexed stream label, so it cannot go inside the `{...}` stream
      // selector (Loki silently matches nothing). Filter it after the
      // selector with a label-filter expression. `container` (used by the
      // service path above) IS a real stream label, so that path is fine.
      query = `{namespace="${tenantId}"} | pod=~"${alternation}"`;
    }
    return this.queryRange(query, since, limit);
  }

  async errorLogs(
    tenantId: string,
    since = "ONE_HOUR",
    limit = 100,
  ): Promise<LogEntry[]> {
    const query = `{namespace="${tenantId}"} |= "error" | json | level="error"`;
    return this.queryRange(query, since, limit);
  }
}

function parseDurationToSeconds(duration: string): number {
  const match = duration.match(/^(\d+)([mhd])$/);
  if (!match) return 3600;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    default:
      return 3600;
  }
}
