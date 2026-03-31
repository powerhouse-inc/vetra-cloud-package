import { PrometheusClient, METRIC_RANGE_VALUES } from "../prometheus.js";
import type { MetricSeries } from "../prometheus.js";

const BASE_URL = "http://prometheus.example.com";

function makeMatrixResponse(
  results: Array<{ metric: Record<string, string>; values: [number, string][] }>,
) {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: results,
    },
  };
}

describe("PrometheusClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: PrometheusClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    client = new PrometheusClient(BASE_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("METRIC_RANGE_VALUES", () => {
    it("exports correct PromQL duration strings", () => {
      expect(METRIC_RANGE_VALUES.ONE_MIN).toBe("1m");
      expect(METRIC_RANGE_VALUES.FIVE_MIN).toBe("5m");
      expect(METRIC_RANGE_VALUES.FIFTEEN_MIN).toBe("15m");
      expect(METRIC_RANGE_VALUES.ONE_HOUR).toBe("1h");
      expect(METRIC_RANGE_VALUES.SIX_HOURS).toBe("6h");
      expect(METRIC_RANGE_VALUES.TWENTY_FOUR_HOURS).toBe("24h");
    });
  });

  describe("cpuUsage", () => {
    it("calls query_range with correct namespace in PromQL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeMatrixResponse([
            { metric: { pod: "connect-pod" }, values: [[1700000000, "0.5"]] },
          ]),
      });

      await client.cpuUsage("tenant-abc", "FIVE_MIN");

      expect(mockFetch).toHaveBeenCalledOnce();
      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("/api/v1/query_range");
      expect(url).toContain("namespace%3D%22tenant-abc%22");
    });

    it("interpolates the range duration into PromQL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });

      await client.cpuUsage("tenant-abc", "FIFTEEN_MIN");

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("15m");
    });

    it("parses matrix response into MetricSeries[]", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeMatrixResponse([
            {
              metric: { pod: "connect-pod" },
              values: [
                [1700000000, "0.5"],
                [1700000060, "0.6"],
              ],
            },
            {
              metric: { pod: "switchboard-pod" },
              values: [[1700000000, "0.3"]],
            },
          ]),
      });

      const result = await client.cpuUsage("tenant-abc", "ONE_HOUR");

      expect(result).toHaveLength(2);
      expect(result[0].label).toBe("connect-pod");
      expect(result[0].datapoints).toHaveLength(2);
      expect(result[0].datapoints[0]).toEqual({
        timestamp: 1700000000,
        value: 0.5,
      });
      expect(result[1].label).toBe("switchboard-pod");
    });
  });

  describe("memoryUsage", () => {
    it("calls query_range with memory PromQL for namespace", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });

      await client.memoryUsage("my-tenant", "ONE_HOUR");

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("container_memory_working_set_bytes");
      expect(url).toContain("my-tenant");
    });
  });

  describe("podRestartRate", () => {
    it("includes kube_pod_container_status_restarts_total in query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });

      await client.podRestartRate("my-tenant", "ONE_HOUR");

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("kube_pod_container_status_restarts_total");
    });
  });

  describe("httpRequestRate", () => {
    it("includes http request metric in query", async () => {
      // httpRequestRate tries multiple OTel metric names in order;
      // the first call uses http_server_duration_count
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });

      await client.httpRequestRate("my-tenant", "ONE_HOUR");

      // Verify all three query variants were tried
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const url0: string = mockFetch.mock.calls[0][0];
      const url2: string = mockFetch.mock.calls[2][0];
      expect(url0).toContain("http_server_duration_count");
      expect(url2).toContain("http_requests_total");
    });
  });

  describe("httpLatency", () => {
    it("includes histogram_quantile in query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });

      await client.httpLatency("my-tenant", "ONE_HOUR");

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("histogram_quantile");
    });
  });

  describe("error handling", () => {
    it("returns [] when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));
      const result = await client.cpuUsage("tenant-abc");
      expect(result).toEqual([]);
    });

    it("returns [] when response is not ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      const result = await client.memoryUsage("tenant-abc");
      expect(result).toEqual([]);
    });

    it("returns [] when result is empty", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeMatrixResponse([]),
      });
      const result = await client.podRestartRate("tenant-abc");
      expect(result).toEqual([]);
    });

    it("returns [] when status is not success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "error",
          data: { resultType: "matrix", result: [] },
        }),
      });
      const result = await client.httpRequestRate("tenant-abc");
      expect(result).toEqual([]);
    });
  });
});
