import { vi } from "vitest";
import { OpenBaoKVClient } from "../openbao-kv.js";

const BASE_URL = "http://openbao.example.com";
const MOCK_SA_TOKEN = "mock-sa-token";
const MOCK_VAULT_TOKEN = "s.mock-vault-token";

describe("OpenBaoKVClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockTokenReader: ReturnType<typeof vi.fn>;

  function makeClient(): OpenBaoKVClient {
    return new OpenBaoKVClient(BASE_URL, mockTokenReader as any);
  }

  function mockAuth(...additionalResponses: object[]) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ auth: { client_token: MOCK_VAULT_TOKEN } }),
    });
    for (const resp of additionalResponses) {
      mockFetch.mockResolvedValueOnce(resp);
    }
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
    it("POSTs to /v1/auth/kubernetes/login with vetra-secrets role", async () => {
      mockAuth();
      const client = makeClient();
      const token = await client.authenticate();
      expect(token).toBe(MOCK_VAULT_TOKEN);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/v1/auth/kubernetes/login`);
      const body = JSON.parse(opts.body as string);
      expect(body.role).toBe("vetra-secrets");
    });

    it("throws on auth failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "permission denied",
      });
      await expect(makeClient().authenticate()).rejects.toThrow("403");
    });
  });

  describe("readSecrets", () => {
    it("returns data from KV v2 path", async () => {
      mockAuth({
        ok: true,
        json: async () => ({
          data: { data: { API_KEY: "abc123", DB_PASS: "secret" } },
        }),
      });
      const result = await makeClient().readSecrets("my-tenant-1234abcd");
      expect(result).toEqual({ API_KEY: "abc123", DB_PASS: "secret" });
      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(`${BASE_URL}/v1/kv/data/tenants/my-tenant-1234abcd/secrets`);
      expect(opts.method).toBe("GET");
      expect(opts.headers["X-Vault-Token"]).toBe(MOCK_VAULT_TOKEN);
    });

    it("returns empty object when path has no data (404)", async () => {
      mockAuth({ ok: false, status: 404, text: async () => "not found" });
      const result = await makeClient().readSecrets("new-tenant-00000000");
      expect(result).toEqual({});
    });

    it("throws on non-404 errors", async () => {
      mockAuth({ ok: false, status: 500, text: async () => "internal error" });
      await expect(makeClient().readSecrets("my-tenant-1234abcd")).rejects.toThrow("500");
    });
  });

  describe("writeSecrets", () => {
    it("PUTs data to KV v2 path", async () => {
      mockAuth({ ok: true, json: async () => ({}) });
      await makeClient().writeSecrets("my-tenant-1234abcd", { API_KEY: "abc123", NEW_KEY: "new-value" });
      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toBe(`${BASE_URL}/v1/kv/data/tenants/my-tenant-1234abcd/secrets`);
      expect(opts.method).toBe("PUT");
      const body = JSON.parse(opts.body as string);
      expect(body).toEqual({ data: { API_KEY: "abc123", NEW_KEY: "new-value" } });
    });

    it("throws on write failure", async () => {
      mockAuth({ ok: false, status: 403, text: async () => "permission denied" });
      await expect(makeClient().writeSecrets("my-tenant-1234abcd", { KEY: "val" })).rejects.toThrow("403");
    });
  });

  describe("deleteSecret (single key)", () => {
    it("reads existing data, removes key, writes back, returns remaining", async () => {
      mockAuth({ ok: true, json: async () => ({ data: { data: { KEEP: "yes", REMOVE: "bye" } } }) });
      mockAuth({ ok: true, json: async () => ({}) });
      const remaining = await makeClient().deleteSecret("my-tenant-1234abcd", "REMOVE");
      expect(remaining).toEqual({ KEEP: "yes" });
    });

    it("returns empty object when deleting the last key", async () => {
      mockAuth({ ok: true, json: async () => ({ data: { data: { ONLY_KEY: "value" } } }) });
      mockAuth({ ok: true, json: async () => ({}) });
      const remaining = await makeClient().deleteSecret("my-tenant-1234abcd", "ONLY_KEY");
      expect(remaining).toEqual({});
    });
  });
});
