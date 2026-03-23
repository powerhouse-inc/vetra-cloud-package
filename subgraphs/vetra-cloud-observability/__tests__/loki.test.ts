import { LokiClient } from "../loki.js";

const BASE_URL = "http://loki.example.com";

function makeLokiResponse(
  streams: Array<{
    stream: Record<string, string>;
    values: [string, string][];
  }>,
) {
  return {
    status: "success",
    data: {
      resultType: "streams",
      result: streams,
    },
  };
}

describe("LokiClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: LokiClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    client = new LokiClient(BASE_URL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("logs", () => {
    it("calls Loki query_range endpoint with correct namespace LogQL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeLokiResponse([]),
      });

      await client.logs("tenant-xyz", null, "ONE_HOUR", 50);

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("/loki/api/v1/query_range");
      expect(url).toContain("tenant-xyz");
    });

    it("adds service filter when service is provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeLokiResponse([]),
      });

      await client.logs("tenant-xyz", "CONNECT", "ONE_HOUR", 50);

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("connect");
    });

    it("does not add service filter when service is null", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeLokiResponse([]),
      });

      await client.logs("tenant-xyz", null, "ONE_HOUR", 50);

      const url: string = mockFetch.mock.calls[0][0];
      // Should only have namespace label, not app
      expect(url).not.toContain("app%3D");
    });

    it("caps limit at 500", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeLokiResponse([]),
      });

      await client.logs("tenant-xyz", null, "ONE_HOUR", 9999);

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("limit=500");
    });

    it("parses log entries from stream response", async () => {
      const nsTs1 = String(1700000000 * 1e9);
      const nsTs2 = String(1700000060 * 1e9);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          makeLokiResponse([
            {
              stream: { app: "connect", namespace: "tenant-xyz" },
              values: [
                [nsTs1, "first log line"],
                [nsTs2, "second log line"],
              ],
            },
          ]),
      });

      const result = await client.logs("tenant-xyz", null, "ONE_HOUR", 50);

      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBeCloseTo(1700000000, 0);
      expect(result[0].line).toBe("first log line");
      expect(result[1].line).toBe("second log line");
    });
  });

  describe("errorLogs", () => {
    it("includes error filter in LogQL query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeLokiResponse([]),
      });

      await client.errorLogs("tenant-abc", "FIVE_MIN", 100);

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("error");
      expect(url).toContain("tenant-abc");
    });

    it("caps limit at 500", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeLokiResponse([]),
      });

      await client.errorLogs("tenant-abc", "ONE_HOUR", 1000);

      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain("limit=500");
    });
  });

  describe("error handling", () => {
    it("returns [] when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));
      const result = await client.logs("tenant-abc");
      expect(result).toEqual([]);
    });

    it("returns [] when response is not ok", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });
      const result = await client.errorLogs("tenant-abc");
      expect(result).toEqual([]);
    });

    it("returns [] when status is not success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "error",
          data: { resultType: "streams", result: [] },
        }),
      });
      const result = await client.logs("tenant-abc");
      expect(result).toEqual([]);
    });
  });
});
