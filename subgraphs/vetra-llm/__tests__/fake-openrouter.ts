import {
  OpenRouterError,
  type LimitReset,
  type OpenRouterApi,
  type OpenRouterKey,
} from "../openrouter.js";

type Stored = OpenRouterKey & { secret: string; workspaceId: string | null };
type Op = "createKey" | "getKey" | "updateKey" | "deleteKey" | "listKeys";

export interface FakeOpenRouter {
  api: OpenRouterApi;
  keys: Map<string, Stored>;
  /** "createKey:<name>", "updateKey:<hash>:<json>", ... in call order. */
  calls: string[];
  /** The next call of `op` throws OpenRouterError(status). */
  failNext(op: Op, status: number): void;
  /** Put a key on the fake as if created elsewhere; returns its hash. */
  seed(input: {
    name: string;
    createdAt: string;
    workspaceId?: string | null;
    usageMonthly?: number;
    /** Defaults to usageMonthly. */
    usage?: number;
    limitUsd?: number | null;
  }): string;
  /** Set a key's usage (and usageMonthly); limitRemaining follows. */
  setUsage(hash: string, usd: number): void;
}

export function createFakeOpenRouter(
  now: () => Date = () => new Date(),
): FakeOpenRouter {
  const keys = new Map<string, Stored>();
  const calls: string[] = [];
  const failures = new Map<Op, number>();
  let seq = 0;

  const maybeFail = (op: Op) => {
    const status = failures.get(op);
    if (status === undefined) return;
    failures.delete(op);
    throw new OpenRouterError(status, `fake ${op} failed (${status})`);
  };
  const view = (k: Stored): OpenRouterKey => ({
    hash: k.hash,
    name: k.name,
    disabled: k.disabled,
    limit: k.limit,
    limitRemaining: k.limitRemaining,
    limitReset: k.limitReset,
    usage: k.usage,
    usageMonthly: k.usageMonthly,
    createdAt: k.createdAt,
  });
  const mint = (
    name: string,
    limit: number | null,
    limitReset: LimitReset | null,
    workspaceId: string | null,
    createdAt: string,
  ): Stored => {
    seq += 1;
    const k: Stored = {
      hash: `hash-${seq}`,
      name,
      disabled: false,
      limit,
      limitRemaining: limit,
      limitReset,
      usage: 0,
      usageMonthly: 0,
      createdAt,
      secret: `sk-or-v1-fake${seq}`,
      workspaceId,
    };
    keys.set(k.hash, k);
    return k;
  };

  const api: OpenRouterApi = {
    async createKey(input) {
      calls.push(`createKey:${input.name}`);
      maybeFail("createKey");
      const k = mint(
        input.name,
        input.limitUsd,
        input.limitReset,
        input.workspaceId,
        now().toISOString(),
      );
      return { key: k.secret, data: view(k) };
    },
    async getKey(hash) {
      calls.push(`getKey:${hash}`);
      maybeFail("getKey");
      const k = keys.get(hash);
      return k ? view(k) : null;
    },
    async updateKey(hash, patch) {
      calls.push(`updateKey:${hash}:${JSON.stringify(patch)}`);
      maybeFail("updateKey");
      const k = keys.get(hash);
      if (!k) throw new OpenRouterError(404, "fake: no such key");
      if (patch.limitUsd !== undefined) {
        k.limit = patch.limitUsd;
        k.limitRemaining = patch.limitUsd - k.usage;
      }
      if (patch.disabled !== undefined) k.disabled = patch.disabled;
      return view(k);
    },
    async deleteKey(hash) {
      calls.push(`deleteKey:${hash}`);
      maybeFail("deleteKey");
      keys.delete(hash);
    },
    async listKeys(input) {
      calls.push(`listKeys:${input.workspaceId ?? "default"}`);
      maybeFail("listKeys");
      return [...keys.values()]
        .filter((k) => k.workspaceId === input.workspaceId)
        .map(view);
    },
  };

  return {
    api,
    keys,
    calls,
    failNext: (op, status) => {
      failures.set(op, status);
    },
    setUsage: (hash, usd) => {
      const k = keys.get(hash);
      if (!k) throw new Error(`fake: no such key ${hash}`);
      k.usage = usd;
      k.usageMonthly = usd;
      k.limitRemaining = k.limit === null ? null : k.limit - usd;
    },
    seed: (input) => {
      const k = mint(
        input.name,
        null,
        null,
        input.workspaceId ?? null,
        input.createdAt,
      );
      k.usageMonthly = input.usageMonthly ?? 0;
      k.usage = input.usage ?? k.usageMonthly;
      k.limit = input.limitUsd ?? null;
      k.limitRemaining = k.limit === null ? null : k.limit - k.usage;
      return k.hash;
    },
  };
}
