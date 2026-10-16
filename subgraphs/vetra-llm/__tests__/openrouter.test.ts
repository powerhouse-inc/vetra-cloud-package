import { describe, expect, it } from "vitest";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import {
  createOpenRouterApi,
  fetchOpenRouterModels,
  OpenRouterError,
} from "../openrouter.js";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function stubFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses.shift() ?? {
      status: 500,
      body: { error: { message: "no stubbed response" } },
    };
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      {
        status: next.status,
      },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const RAW_KEY = {
  hash: "f01d52",
  name: "studio:env-1",
  label: "sk-or-v1-0e6...1c96",
  disabled: false,
  limit: 20,
  limit_remaining: 17.5,
  limit_reset: "monthly",
  usage: 2.5,
  usage_monthly: 2.5,
  created_at: "2026-10-15T10:00:00Z",
};

describe("OpenRouter management client", () => {
  it("creates a monthly-capped key in the workspace with the management bearer", async () => {
    const { calls, fetchImpl } = stubFetch([
      { status: 201, body: { data: RAW_KEY, key: "sk-or-v1-secret" } },
    ]);
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    const res = await api.createKey({
      name: "studio:env-1",
      limitUsd: 20,
      limitReset: "monthly",
      workspaceId: "ws-1",
    });
    expect(calls[0]).toMatchObject({
      url: "https://openrouter.ai/api/v1/keys",
      method: "POST",
      body: {
        name: "studio:env-1",
        limit: 20,
        limit_reset: "monthly",
        workspace_id: "ws-1",
      },
    });
    expect(calls[0].headers.Authorization).toBe("Bearer mgmt");
    expect(res.key).toBe("sk-or-v1-secret");
    expect(res.data).toStrictEqual({
      hash: "f01d52",
      name: "studio:env-1",
      disabled: false,
      limit: 20,
      limitRemaining: 17.5,
      limitReset: "monthly",
      usage: 2.5,
      usageMonthly: 2.5,
      createdAt: "2026-10-15T10:00:00Z",
    });
  });

  it("omits workspace_id without a workspace", async () => {
    const { calls, fetchImpl } = stubFetch([
      { status: 201, body: { data: RAW_KEY, key: "sk-or-v1-secret" } },
    ]);
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    await api.createKey({
      name: "studio:env-1",
      limitUsd: 5,
      limitReset: "monthly",
      workspaceId: null,
    });
    expect(calls[0].body).toStrictEqual({
      name: "studio:env-1",
      limit: 5,
      limit_reset: "monthly",
    });
  });

  it("patches only the given fields", async () => {
    const { calls, fetchImpl } = stubFetch([
      { status: 200, body: { data: { ...RAW_KEY, limit: 25 } } },
      { status: 200, body: { data: { ...RAW_KEY, disabled: true } } },
    ]);
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    expect((await api.updateKey("f01d52", { limitUsd: 25 })).limit).toBe(25);
    expect((await api.updateKey("f01d52", { disabled: true })).disabled).toBe(
      true,
    );
    expect(calls.map((c) => [c.method, c.url, c.body])).toStrictEqual([
      ["PATCH", "https://openrouter.ai/api/v1/keys/f01d52", { limit: 25 }],
      ["PATCH", "https://openrouter.ai/api/v1/keys/f01d52", { disabled: true }],
    ]);
  });

  it("reads a missing key as null and deletes a missing key without error", async () => {
    const { fetchImpl } = stubFetch([
      { status: 404, body: { error: { message: "not found" } } },
      { status: 404, body: { error: { message: "not found" } } },
    ]);
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    expect(await api.getKey("gone")).toBeNull();
    await expect(api.deleteKey("gone")).resolves.toBeUndefined();
  });

  it("lists every page, including disabled keys, in the workspace", async () => {
    const { calls, fetchImpl } = stubFetch([
      { status: 200, body: { data: [RAW_KEY, { ...RAW_KEY, hash: "b" }] } },
      { status: 200, body: { data: [{ ...RAW_KEY, hash: "c" }] } },
      { status: 200, body: { data: [] } },
    ]);
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    const keys = await api.listKeys({ workspaceId: "ws-1" });
    expect(keys.map((k) => k.hash)).toStrictEqual(["f01d52", "b", "c"]);
    expect(calls.map((c) => c.url)).toStrictEqual([
      "https://openrouter.ai/api/v1/keys?include_disabled=true&offset=0&workspace_id=ws-1",
      "https://openrouter.ai/api/v1/keys?include_disabled=true&offset=2&workspace_id=ws-1",
      "https://openrouter.ai/api/v1/keys?include_disabled=true&offset=3&workspace_id=ws-1",
    ]);
  });

  it("throws OpenRouterError with the status and never the key text", async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 500,
        body: { error: { message: "boom for sk-or-v1-leaked123 Bearer mgmt" } },
      },
    ]);
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    const err = await api.getKey("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect((err as OpenRouterError).status).toBe(500);
    expect((err as Error).message).not.toContain("sk-or-");
    expect((err as Error).message).not.toContain("Bearer mgmt");
    expect((err as Error).message).toContain("[redacted]");
  });
});

describe("key-bearing bodies never surface", () => {
  it("does not quote a malformed success body", async () => {
    const fetchImpl = (async () =>
      new Response('{"key":"sk-or-v1-leakme" oops', {
        status: 201,
      })) as unknown as typeof fetch;
    const api = createOpenRouterApi({
      managementKey: "mgmt",
      fetch: fetchImpl,
    });
    const err = await api
      .createKey({
        name: "n",
        limitUsd: 1,
        limitReset: "monthly",
        workspaceId: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect((err as Error).message).toBe("invalid JSON from POST /keys");
    const models = await fetchOpenRouterModels({ fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect((models as Error).message).toBe("invalid JSON from GET /models");
  });

  it("redacts an echoed management key whatever its format", async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 401,
        body: { error: { message: "bad credential plainmgmt42 given" } },
      },
    ]);
    const api = createOpenRouterApi({
      managementKey: "plainmgmt42",
      fetch: fetchImpl,
    });
    const err = await api.getKey("x").catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("plainmgmt42");
    expect((err as Error).message).toContain("[redacted]");
  });
});

describe("fake OpenRouter", () => {
  it("seeds consistent usage and limitRemaining", async () => {
    const fake = createFakeOpenRouter();
    const hash = fake.seed({
      name: "studio:a",
      createdAt: "2026-10-15T00:00:00Z",
      usageMonthly: 4,
      limitUsd: 10,
    });
    expect(await fake.api.getKey(hash)).toMatchObject({
      usage: 4,
      usageMonthly: 4,
      limitRemaining: 6,
    });
    fake.setUsage(hash, 7);
    expect(await fake.api.getKey(hash)).toMatchObject({
      usage: 7,
      usageMonthly: 7,
      limitRemaining: 3,
    });
  });
});

describe("fetchOpenRouterModels", () => {
  it("maps tools support, context and per-token prices", async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        status: 200,
        body: {
          data: [
            {
              id: "anthropic/claude-sonnet-4.6",
              name: "Anthropic: Claude Sonnet 4.6",
              context_length: 1000000,
              supported_parameters: ["tools", "temperature"],
              pricing: { prompt: "0.000003", completion: "0.000015" },
            },
            {
              id: "x/no-tools",
              name: "No tools",
              context_length: 8000,
              supported_parameters: ["temperature"],
              pricing: { prompt: "0", completion: "0" },
            },
          ],
        },
      },
    ]);
    const models = await fetchOpenRouterModels({ fetch: fetchImpl });
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(models).toStrictEqual([
      {
        id: "anthropic/claude-sonnet-4.6",
        name: "Anthropic: Claude Sonnet 4.6",
        contextLength: 1000000,
        supportsTools: true,
        promptUsdPerToken: 0.000003,
        completionUsdPerToken: 0.000015,
      },
      {
        id: "x/no-tools",
        name: "No tools",
        contextLength: 8000,
        supportsTools: false,
        promptUsdPerToken: 0,
        completionUsdPerToken: 0,
      },
    ]);
  });
});
