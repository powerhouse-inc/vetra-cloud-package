import http from "node:http";

/** Simple HTTP GET that bypasses any Vite SSR fetch interception. */
function httpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data) as T); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
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
    const query = `sum(rate(http_requests_total{namespace="${tenantId}"}[${METRIC_RANGE_VALUES[range] ?? "1h"}])) by (pod)`;
    return this.queryRange(query, range);
  }

  async httpLatency(
    tenantId: string,
    range = "ONE_HOUR",
  ): Promise<MetricSeries[]> {
    const query = `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{namespace="${tenantId}"}[${METRIC_RANGE_VALUES[range] ?? "1h"}])) by (le, pod))`;
    return this.queryRange(query, range);
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
