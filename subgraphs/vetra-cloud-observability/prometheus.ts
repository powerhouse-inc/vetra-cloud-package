/** Simple HTTP GET using fetch. */
async function httpGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface Datapoint {
  timestamp: number;
  value: number;
}

export interface MetricSeries {
  label: string;
  datapoints: Datapoint[];
}

export const METRIC_RANGE_VALUES: Record<string, string> = {
  ONE_MIN: "1m",
  FIVE_MIN: "5m",
  FIFTEEN_MIN: "15m",
  ONE_HOUR: "1h",
  SIX_HOURS: "6h",
  TWENTY_FOUR_HOURS: "24h",
};

interface PrometheusMatrixResult {
  metric: Record<string, string>;
  values: [number, string][];
}

interface PrometheusQueryRangeResponse {
  status: string;
  data: {
    resultType: string;
    result: PrometheusMatrixResult[];
  };
}

function parseMatrixResult(result: PrometheusMatrixResult[]): MetricSeries[] {
  return result.map((series) => {
    const label =
      series.metric.pod ??
      series.metric.container ??
      series.metric.namespace ??
      JSON.stringify(series.metric);
    const datapoints: Datapoint[] = series.values.map(([ts, val]) => ({
      timestamp: ts,
      value: parseFloat(val),
    }));
    return { label, datapoints };
  });
}

export class PrometheusClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async queryRange(
    query: string,
    range: string,
  ): Promise<MetricSeries[]> {
    const end = Math.floor(Date.now() / 1000);
    const duration = METRIC_RANGE_VALUES[range] ?? METRIC_RANGE_VALUES.ONE_HOUR;
    // Parse duration string to seconds for start offset
    const durationSeconds = parseDurationToSeconds(duration);
    const start = end - durationSeconds;
    // Step: at most 60 data points
    const step = Math.max(Math.floor(durationSeconds / 60), 15);

    const params = new URLSearchParams({
      query,
      start: String(start),
      end: String(end),
      step: String(step),
    });

    const url = `${this.baseUrl}/api/v1/query_range?${params.toString()}`;
    try {
      const json = await httpGet<PrometheusQueryRangeResponse>(url);
      if (json.status !== "success" || json.data.resultType !== "matrix") {
        return [];
      }
      return parseMatrixResult(json.data.result);
    } catch {
      return [];
    }
  }

  async cpuUsage(tenantId: string, range = "ONE_HOUR"): Promise<MetricSeries[]> {
    const query = `sum(rate(container_cpu_usage_seconds_total{namespace="${tenantId}"}[${METRIC_RANGE_VALUES[range] ?? "1h"}])) by (pod)`;
    return this.queryRange(query, range);
  }

  async memoryUsage(
    tenantId: string,
    range = "ONE_HOUR",
  ): Promise<MetricSeries[]> {
    const query = `sum(container_memory_working_set_bytes{namespace="${tenantId}"}) by (pod)`;
    return this.queryRange(query, range);
  }

  async podRestartRate(
    tenantId: string,
    range = "ONE_HOUR",
  ): Promise<MetricSeries[]> {
    const query = `sum(increase(kube_pod_container_status_restarts_total{namespace="${tenantId}"}[${METRIC_RANGE_VALUES[range] ?? "1h"}])) by (pod)`;
    return this.queryRange(query, range);
  }

  async httpRequestRate(
    tenantId: string,
    range = "ONE_HOUR",
  ): Promise<MetricSeries[]> {
    const r = METRIC_RANGE_VALUES[range] ?? "1h";
    // Try OTel metric names in order of likelihood
    const queries = [
      `sum(rate(http_server_duration_count{namespace="${tenantId}"}[${r}])) by (pod)`,
      `sum(rate(http_server_request_duration_seconds_count{namespace="${tenantId}"}[${r}])) by (pod)`,
      `sum(rate(http_requests_total{namespace="${tenantId}"}[${r}])) by (pod)`,
    ];
    for (const query of queries) {
      const result = await this.queryRange(query, range);
      if (result.length > 0) return result;
    }
    return [];
  }

  async httpLatency(
    tenantId: string,
    range = "ONE_HOUR",
  ): Promise<MetricSeries[]> {
    const r = METRIC_RANGE_VALUES[range] ?? "1h";
    // Try OTel metric names in order — note http_server_duration is in ms, not seconds
    const queries = [
      `histogram_quantile(0.99, sum(rate(http_server_duration_bucket{namespace="${tenantId}"}[${r}])) by (le, pod)) / 1000`,
      `histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket{namespace="${tenantId}"}[${r}])) by (le, pod))`,
      `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{namespace="${tenantId}"}[${r}])) by (le, pod))`,
    ];
    for (const query of queries) {
      const result = await this.queryRange(query, range);
      if (result.length > 0) return result;
    }
    return [];
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
