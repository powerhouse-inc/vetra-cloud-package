import { redactSecrets } from "../../shared/redact.js";

/**
 * OpenRouter REST client: management keys (provisioning, one per Studio) and
 * the public model list. Shapes verified against https://openrouter.ai/openapi.yaml
 * on 2026-10-15. Error messages are redacted: an upstream body may echo a key.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type LimitReset = "daily" | "weekly" | "monthly";

export interface OpenRouterKey {
  hash: string;
  name: string;
  disabled: boolean;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: LimitReset | null;
  usage: number;
  usageMonthly: number;
  createdAt: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

export interface OpenRouterApi {
  createKey(input: {
    name: string;
    limitUsd: number;
    limitReset: LimitReset;
    workspaceId: string | null;
  }): Promise<{ key: string; data: OpenRouterKey }>;
  /** Null when the key does not exist (404). */
  getKey(hash: string): Promise<OpenRouterKey | null>;
  updateKey(
    hash: string,
    patch: { limitUsd?: number; disabled?: boolean },
  ): Promise<OpenRouterKey>;
  /** A key that is already gone (404) counts as deleted. */
  deleteKey(hash: string): Promise<void>;
  /** Every key of the workspace (the default workspace when null), disabled ones included. */
  listKeys(input: { workspaceId: string | null }): Promise<OpenRouterKey[]>;
}

export class OpenRouterError extends Error {
  override name = "OpenRouterError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Raw = Record<string, unknown>;

const RESETS = new Set<string>(["daily", "weekly", "monthly"]);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function toKey(raw: Raw): OpenRouterKey {
  const reset =
    typeof raw.limit_reset === "string" && RESETS.has(raw.limit_reset)
      ? (raw.limit_reset as LimitReset)
      : null;
  return {
    hash: str(raw.hash),
    name: str(raw.name),
    disabled: raw.disabled === true,
    limit: numOrNull(raw.limit),
    limitRemaining: numOrNull(raw.limit_remaining),
    limitReset: reset,
    usage: num(raw.usage),
    usageMonthly: num(raw.usage_monthly),
    createdAt: str(raw.created_at),
  };
}

/** Pages of GET /keys are followed until an empty page; this caps a runaway loop. */
const MAX_KEY_PAGES = 100;

async function errorFor(
  res: Response,
  method: string,
  path: string,
): Promise<OpenRouterError> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string")
      detail = parsed.error.message;
  } catch {
    // Not JSON: keep the raw text (redacted below).
  }
  return new OpenRouterError(
    res.status,
    redactSecrets(
      `OpenRouter ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`,
    ),
  );
}

export function createOpenRouterApi(opts: {
  managementKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): OpenRouterApi {
  const base = (opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function call(
    method: string,
    path: string,
    body?: Raw,
    allow404 = false,
  ): Promise<Raw | null> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.managementKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw await errorFor(res, method, path);
    const text = await res.text();
    return text ? (JSON.parse(text) as Raw) : {};
  }

  return {
    async createKey(input) {
      const res = (await call("POST", "/keys", {
        name: input.name,
        limit: input.limitUsd,
        limit_reset: input.limitReset,
        ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
      }))!;
      return {
        key: str(res.key),
        data: toKey((res.data ?? {}) as Raw),
      };
    },
    async getKey(hash) {
      const res = await call(
        "GET",
        `/keys/${encodeURIComponent(hash)}`,
        undefined,
        true,
      );
      return res ? toKey((res.data ?? {}) as Raw) : null;
    },
    async updateKey(hash, patch) {
      const body: Raw = {};
      if (patch.limitUsd !== undefined) body.limit = patch.limitUsd;
      if (patch.disabled !== undefined) body.disabled = patch.disabled;
      const res = (await call(
        "PATCH",
        `/keys/${encodeURIComponent(hash)}`,
        body,
      ))!;
      return toKey((res.data ?? {}) as Raw);
    },
    async deleteKey(hash) {
      await call(
        "DELETE",
        `/keys/${encodeURIComponent(hash)}`,
        undefined,
        true,
      );
    },
    async listKeys(input) {
      const all: OpenRouterKey[] = [];
      for (let page = 0; page < MAX_KEY_PAGES; page++) {
        const params = new URLSearchParams({
          include_disabled: "true",
          offset: String(all.length),
        });
        if (input.workspaceId) params.set("workspace_id", input.workspaceId);
        const res = (await call("GET", `/keys?${params.toString()}`))!;
        const data = Array.isArray(res.data) ? (res.data as Raw[]) : [];
        if (data.length === 0) break;
        all.push(...data.map(toKey));
      }
      return all;
    },
  };
}

/** The public model list (no auth). */
export async function fetchOpenRouterModels(
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<OpenRouterModel[]> {
  const base = (opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const res = await (opts.fetch ?? fetch)(`${base}/models`, { method: "GET" });
  if (!res.ok) throw await errorFor(res, "GET", "/models");
  const body = (await res.json()) as { data?: Raw[] };
  return (body.data ?? []).map((m) => {
    const pricing = (m.pricing ?? {}) as Raw;
    const params = Array.isArray(m.supported_parameters)
      ? m.supported_parameters
      : [];
    return {
      id: str(m.id),
      name: str(m.name ?? m.id),
      contextLength: num(m.context_length),
      supportsTools: params.includes("tools"),
      promptUsdPerToken: Number(pricing.prompt ?? 0) || 0,
      completionUsdPerToken: Number(pricing.completion ?? 0) || 0,
    };
  });
}
