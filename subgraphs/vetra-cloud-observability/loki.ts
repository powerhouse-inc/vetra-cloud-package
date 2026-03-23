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
  ): Promise<LogEntry[]> {
    let query = `{namespace="${tenantId}"}`;
    if (service) {
      query = `{namespace="${tenantId}", app="${service.toLowerCase()}"}`;
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
