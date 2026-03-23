import { vi } from "vitest";
import { OpenBaoClient } from "../openbao.js";

const BASE_URL = "http://openbao.example.com";
const MOCK_SA_TOKEN = "mock-sa-token-from-file";
const MOCK_VAULT_TOKEN = "s.mock-vault-client-token";

describe("OpenBaoClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockTokenReader: ReturnType<typeof vi.fn>;

  function makeClient(): OpenBaoClient {
    return new OpenBaoClient(BASE_URL, mockTokenReader as any);
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockTokenReader = vi.fn().mockReturnValue(MOCK_SA_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe("authenticate", () => {
    it("reads SA token from the serviceaccount path", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          auth: { client_token: MOCK_VAULT_TOKEN },
        }),
      });

      const client = makeClient();
      await client.authenticate();

      expect(mockTokenReader).toHaveBeenCalledWith(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      );
    });

    it("POSTs to /v1/auth/kubernetes/login with jwt and role", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          auth: { client_token: MOCK_VAULT_TOKEN },
        }),
      });

      const client = makeClient();
      await client.authenticate();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/auth/kubernetes/login`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body as string);
      expect(body.jwt).toBe(MOCK_SA_TOKEN);
      expect(body.role).toBe("vetra-observability");
    });

    it("returns the vault client token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          auth: { client_token: MOCK_VAULT_TOKEN },
        }),
      });

      const client = makeClient();
      const token = await client.authenticate();

      expect(token).toBe(MOCK_VAULT_TOKEN);
    });

    it("throws when response is not ok", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "permission denied",
      });

      const client = makeClient();
      await expect(client.authenticate()).rejects.toThrow("403");
    });
  });

  describe("getK8sToken", () => {
    it("authenticates first then GETs kubernetes creds", async () => {
      // First call: authenticate
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          auth: { client_token: MOCK_VAULT_TOKEN },
        }),
      });
      // Second call: get k8s token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { service_account_token: "k8s-token-abc" },
          lease_id: "lease-123",
          lease_duration: 3600,
        }),
      });

      const client = makeClient();
      const creds = await client.getK8sToken();

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [getUrl, getOpts] = mockFetch.mock.calls[1];
      expect(getUrl).toContain("/v1/kubernetes/creds/vetra-observability");
      expect(getOpts.method).toBe("GET");
      expect(getOpts.headers["X-Vault-Token"]).toBe(MOCK_VAULT_TOKEN);

      expect(creds.token).toBe("k8s-token-abc");
      expect(creds.leaseId).toBe("lease-123");
      expect(creds.leaseDuration).toBe(3600);
    });

    it("throws when creds endpoint fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: MOCK_VAULT_TOKEN } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "internal error",
      });

      const client = makeClient();
      await expect(client.getK8sToken()).rejects.toThrow("500");
    });
  });

  describe("revokeLease", () => {
    it("authenticates then PUTs to /v1/sys/leases/revoke with lease_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: MOCK_VAULT_TOKEN } }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = makeClient();
      await client.revokeLease("lease-456");

      const [revokeUrl, revokeOpts] = mockFetch.mock.calls[1];
      expect(revokeUrl).toBe(`${BASE_URL}/v1/sys/leases/revoke`);
      expect(revokeOpts.method).toBe("PUT");
      const body = JSON.parse(revokeOpts.body as string);
      expect(body.lease_id).toBe("lease-456");
      expect(revokeOpts.headers["X-Vault-Token"]).toBe(MOCK_VAULT_TOKEN);
    });

    it("throws when revoke fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: MOCK_VAULT_TOKEN } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "lease not found",
      });

      const client = makeClient();
      await expect(client.revokeLease("bad-lease")).rejects.toThrow("404");
    });
  });

  describe("renewLease", () => {
    it("PUTs to /v1/sys/leases/renew with lease_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ auth: { client_token: MOCK_VAULT_TOKEN } }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true });

      const client = makeClient();
      await client.renewLease("lease-789");

      const [renewUrl, renewOpts] = mockFetch.mock.calls[1];
      expect(renewUrl).toBe(`${BASE_URL}/v1/sys/leases/renew`);
      expect(renewOpts.method).toBe("PUT");
      const body = JSON.parse(renewOpts.body as string);
      expect(body.lease_id).toBe("lease-789");
    });
  });
});
