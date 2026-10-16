import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphQLError } from "graphql";
import type { StudioLlmBudget } from "../../vetra-licensing/studio-access.js";
import {
  createLlmBroker,
  MODEL_VAR,
  nextMonthlyReset,
  OPENROUTER_KEY_SECRET,
  type BrokerDeps,
  type LlmBroker,
} from "../broker.js";
import { DEFAULT_STUDIO_MODEL } from "../config.js";
import { isNotConfigured, toLlmGraphQLError } from "../errors.js";
import { OpenRouterError } from "../openrouter.js";
import { createLlmKeyStore } from "../store.js";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import { createFakeSecrets, fakeKeyVault, holderDid } from "./fakes.js";
import { openLlmDb } from "./llm-db.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ENV = "env-1";
const TENANT = "warm-newt-75-aa726a95";

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

async function setup(
  budget: StudioLlmBudget = { allowed: true, budgetUsd: 20 },
  over: Partial<BrokerDeps> = {},
) {
  const h = await openLlmDb();
  destroy = h.destroy;
  const fake = createFakeOpenRouter(() => NOW);
  const secrets = createFakeSecrets();
  const logs: string[] = [];
  const logger = {
    info: (m: string) => void logs.push(m),
    warn: (m: string) => void logs.push(m),
    error: (m: string) => void logs.push(m),
  };
  const budgetForDid = vi.fn(async (_did: string) => budget);
  const store = createLlmKeyStore(h.db);
  const broker = createLlmBroker({
    store,
    openrouter: fake.api,
    keyVault: fakeKeyVault,
    secrets,
    budgetForDid,
    cfg: { defaultModel: DEFAULT_STUDIO_MODEL, workspaceId: "ws-staging" },
    now: () => NOW,
    logger,
    ...over,
  });
  return { fake, secrets, logs, budgetForDid, store, broker };
}

const provision = (b: LlmBroker) =>
  b.provisionVetraKey({
    environmentId: ENV,
    tenantId: TENANT,
    ownerDid: holderDid(),
  });

describe("provisionVetraKey", () => {
  it("creates a monthly-capped studio:<env> key, stores hash + ciphertext, writes OPENROUTER_API_KEY and VETRA_MODEL", async () => {
    const s = await setup();
    expect(await provision(s.broker)).toStrictEqual({
      connected: true,
      llmBudgetUsd: 20,
    });
    const [key] = [...s.fake.keys.values()];
    expect(key).toMatchObject({
      name: `studio:${ENV}`,
      limit: 20,
      limitReset: "monthly",
      workspaceId: "ws-staging",
    });
    const row = await s.store.get(ENV);
    expect(row).toMatchObject({
      source: "VETRA",
      key_hash: key.hash,
      limit_usd: 20,
      status: "ACTIVE",
      model: DEFAULT_STUDIO_MODEL,
    });
    expect(row!.key_ciphertext).not.toContain(key.secret);
    expect(await fakeKeyVault.decrypt(row!.key_ciphertext!)).toBe(key.secret);
    // Review Focus 2: exactly the name the agent reads.
    expect(OPENROUTER_KEY_SECRET).toBe("OPENROUTER_API_KEY");
    expect(MODEL_VAR).toBe("VETRA_MODEL");
    expect(s.secrets.secret(TENANT, "OPENROUTER_API_KEY")).toBe(key.secret);
    expect(s.secrets.envVar(TENANT, "VETRA_MODEL")).toBe(DEFAULT_STUDIO_MODEL);
    // Exactly one secret and one var, nothing else.
    expect(s.secrets.setSecret.mock.calls).toStrictEqual([
      [TENANT, "OPENROUTER_API_KEY", key.secret],
    ]);
    expect(s.secrets.setEnvVar.mock.calls).toStrictEqual([
      [TENANT, "VETRA_MODEL", DEFAULT_STUDIO_MODEL],
    ]);
  });

  it("is idempotent per env: a second provision reuses the key and rewrites it", async () => {
    const s = await setup();
    await provision(s.broker);
    await provision(s.broker);
    expect(s.fake.calls.filter((c) => c.startsWith("createKey"))).toHaveLength(
      1,
    );
    expect(s.secrets.setSecret).toHaveBeenCalledTimes(2);
  });

  it("mints exactly one key when two provisions race for the same env (Review Focus 4)", async () => {
    const s = await setup();
    await Promise.all([
      provision(s.broker),
      provision(s.broker),
      provision(s.broker),
    ]);
    expect(s.fake.keys.size).toBe(1);
    expect(s.fake.calls.filter((c) => c.startsWith("createKey"))).toHaveLength(
      1,
    );
  });

  it("undoes the key when the secret write fails, and rethrows", async () => {
    const s = await setup();
    s.secrets.setSecret.mockRejectedValueOnce(new Error("secrets down"));
    await expect(provision(s.broker)).rejects.toThrow("secrets down");
    expect(s.fake.keys.size).toBe(0);
    expect(s.fake.calls.some((c) => c.startsWith("deleteKey:"))).toBe(true);
    expect((await s.store.get(ENV))?.status).toBe("DELETED");
  });

  it("writes the key last: a failed var write leaves no key in the tenant and undoes the mint (I2)", async () => {
    const s = await setup();
    s.secrets.setEnvVar.mockRejectedValueOnce(new Error("vars down"));
    await expect(provision(s.broker)).rejects.toThrow("vars down");
    expect(s.secrets.setSecret).not.toHaveBeenCalled();
    expect(s.secrets.secret(TENANT, "OPENROUTER_API_KEY")).toBeUndefined();
    expect(s.fake.keys.size).toBe(0);
    expect((await s.store.get(ENV))?.status).toBe("DELETED");
  });

  it("keeps the key when the row cannot be released, so an ACTIVE row never points at a deleted key (I3)", async () => {
    const s = await setup();
    s.secrets.setSecret.mockRejectedValueOnce(new Error("secrets down"));
    vi.spyOn(s.store, "update").mockRejectedValueOnce(new Error("pg down"));
    await expect(provision(s.broker)).rejects.toThrow("secrets down");
    const [key] = [...s.fake.keys.values()];
    expect(s.fake.calls.some((c) => c.startsWith("deleteKey:"))).toBe(false);
    expect(await s.store.get(ENV)).toMatchObject({
      status: "ACTIVE",
      key_hash: key.hash,
    });
    expect(
      s.logs.some(
        (l) => l.includes(key.hash) && l.includes("could not release"),
      ),
    ).toBe(true);
  });

  it("undoes the key when storing the row fails", async () => {
    const s = await setup(undefined, {
      keyVault: {
        encrypt: async () => Promise.reject(new Error("transit down")),
        decrypt: fakeKeyVault.decrypt,
      },
    });
    await expect(provision(s.broker)).rejects.toThrow("transit down");
    expect(s.fake.keys.size).toBe(0);
    expect(await s.store.get(ENV)).toBeNull();
  });

  it("keeps a pre-existing key when only the secret write fails", async () => {
    const s = await setup();
    await provision(s.broker);
    s.secrets.setSecret.mockRejectedValueOnce(new Error("secrets down"));
    await expect(provision(s.broker)).rejects.toThrow("secrets down");
    expect(s.fake.keys.size).toBe(1);
    expect((await s.store.get(ENV))?.status).toBe("ACTIVE");
  });

  it("budget 0 or no licence: no key, not connected; an existing key is disabled", async () => {
    const s = await setup({ allowed: true, budgetUsd: 0 });
    expect(await provision(s.broker)).toStrictEqual({
      connected: false,
      llmBudgetUsd: 0,
    });
    expect(s.fake.keys.size).toBe(0);
    expect(s.secrets.setSecret).not.toHaveBeenCalled();

    s.budgetForDid.mockResolvedValue({ allowed: true, budgetUsd: 10 });
    await provision(s.broker);
    s.budgetForDid.mockResolvedValue({ allowed: false, budgetUsd: 0 });
    expect(await provision(s.broker)).toStrictEqual({
      connected: false,
      llmBudgetUsd: 0,
    });
    expect([...s.fake.keys.values()][0].disabled).toBe(true);
    expect((await s.store.get(ENV))?.status).toBe("DISABLED");
    // The tenant must not keep a disabled key: the agent falls back to
    // no-model mode instead of 401ing.
    expect(s.secrets.secret(TENANT, OPENROUTER_KEY_SECRET)).toBeUndefined();
  });

  it("no grant and no Vetra key: leaves the tenant's own key alone", async () => {
    const s = await setup({ allowed: false, budgetUsd: 0 });
    await s.secrets.setSecret(TENANT, OPENROUTER_KEY_SECRET, "user-own-key");
    await provision(s.broker);
    expect(s.secrets.deleteSecret).not.toHaveBeenCalled();
    expect(s.secrets.secret(TENANT, OPENROUTER_KEY_SECRET)).toBe(
      "user-own-key",
    );
  });

  it("no grant: a failed secret delete rejects and the next call retries it", async () => {
    const s = await setup();
    await provision(s.broker);
    s.budgetForDid.mockResolvedValue({ allowed: false, budgetUsd: 0 });
    s.secrets.deleteSecret.mockRejectedValueOnce(new Error("secrets down"));
    await expect(provision(s.broker)).rejects.toThrow("secrets down");
    expect((await s.store.get(ENV))?.status).toBe("DISABLED");
    await provision(s.broker);
    expect(s.secrets.secret(TENANT, OPENROUTER_KEY_SECRET)).toBeUndefined();
  });

  it("re-enables a key disabled on OpenRouter while the row stayed ACTIVE", async () => {
    const s = await setup();
    await provision(s.broker);
    const key = [...s.fake.keys.values()][0];
    key.disabled = true;
    await provision(s.broker);
    expect(key.disabled).toBe(false);
    expect(s.fake.keys.size).toBe(1);
  });

  it("re-enables a disabled key and applies a changed budget", async () => {
    const s = await setup();
    await provision(s.broker);
    s.budgetForDid.mockResolvedValue({ allowed: false, budgetUsd: 0 });
    await provision(s.broker);
    s.budgetForDid.mockResolvedValue({ allowed: true, budgetUsd: 35 });
    expect(await provision(s.broker)).toStrictEqual({
      connected: true,
      llmBudgetUsd: 35,
    });
    expect([...s.fake.keys.values()][0]).toMatchObject({
      disabled: false,
      limit: 35,
    });
    expect(await s.store.get(ENV)).toMatchObject({
      status: "ACTIVE",
      limit_usd: 35,
    });
  });

  it("mints a fresh key when the stored one was deleted on OpenRouter", async () => {
    const s = await setup();
    await provision(s.broker);
    s.fake.keys.clear();
    s.budgetForDid.mockResolvedValue({ allowed: true, budgetUsd: 25 });
    expect(await provision(s.broker)).toStrictEqual({
      connected: true,
      llmBudgetUsd: 25,
    });
    expect(s.fake.keys.size).toBe(1);
  });

  it("re-mints when the key is gone on OpenRouter and nothing changed (fast path, I3)", async () => {
    const s = await setup();
    await provision(s.broker);
    const [old] = [...s.fake.keys.values()];
    s.fake.keys.clear();
    expect(await provision(s.broker)).toStrictEqual({
      connected: true,
      llmBudgetUsd: 20,
    });
    expect(s.fake.calls.filter((c) => c.startsWith("createKey"))).toHaveLength(
      2,
    );
    const [fresh] = [...s.fake.keys.values()];
    expect(fresh.hash).not.toBe(old.hash);
    expect(s.secrets.secret(TENANT, "OPENROUTER_API_KEY")).toBe(fresh.secret);
    expect(await s.store.get(ENV)).toMatchObject({
      status: "ACTIVE",
      key_hash: fresh.hash,
    });
  });

  it("refuses with SERVICE_NOT_CONFIGURED without a management key or key storage", async () => {
    const s1 = await setup(undefined, { openrouter: null });
    const e1 = await provision(s1.broker).catch((e: unknown) => e);
    expect(isNotConfigured(e1)).toBe(true);
    await destroy?.();
    const s2 = await setup(undefined, { keyVault: null });
    expect(
      isNotConfigured(await provision(s2.broker).catch((e: unknown) => e)),
    ).toBe(true);
  });

  it("logs the hash for the sweeper when the undo delete also fails, and rethrows the write error", async () => {
    const s = await setup();
    s.secrets.setSecret.mockRejectedValueOnce(new Error("secrets down"));
    const deleteKey = vi
      .spyOn(s.fake.api, "deleteKey")
      .mockRejectedValueOnce(new OpenRouterError(503, "unavailable"));
    await expect(provision(s.broker)).rejects.toThrow("secrets down");
    expect(deleteKey).toHaveBeenCalledTimes(1);
    const [key] = [...s.fake.keys.values()];
    expect(s.fake.keys.size).toBe(1); // still on OpenRouter: the sweeper's job now
    expect(s.logs.some((l) => l.includes(key.hash))).toBe(true);
    expect(await s.store.get(ENV)).toMatchObject({
      status: "DELETED",
      key_ciphertext: null,
      key_hash: key.hash,
    });
  });

  it("never logs a key or ciphertext, even when upstream errors echo one", async () => {
    const LEAK = "sk-or-v1-leakdeadbeef0123";
    const s = await setup();
    // A minted key, then a secret write and an undo delete that both echo a key.
    s.secrets.setSecret.mockRejectedValueOnce(
      new Error(`secrets down: ${LEAK} vault:v1:QUJD`),
    );
    vi.spyOn(s.fake.api, "deleteKey").mockRejectedValueOnce(
      new OpenRouterError(500, `boom ${LEAK}`),
    );
    await expect(provision(s.broker)).rejects.toThrow();
    // The record fails after a mint: the undo delete echoes a key again.
    const firstLogs = [...s.logs];
    const firstMinted = [...s.fake.keys.values()].map((k) => k.secret);
    await destroy?.();
    const s2 = await setup(undefined, {
      keyVault: {
        encrypt: async () => Promise.reject(new Error(`transit: ${LEAK}`)),
        decrypt: fakeKeyVault.decrypt,
      },
    });
    vi.spyOn(s2.fake.api, "deleteKey").mockRejectedValueOnce(
      new OpenRouterError(500, `boom ${LEAK}`),
    );
    await expect(provision(s2.broker)).rejects.toThrow();
    const minted = [...firstMinted, "sk-or-v1-fake1"];
    const logs = [...firstLogs, ...s2.logs];
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const line of logs) {
      expect(line).not.toContain(LEAK);
      for (const k of minted) expect(line).not.toContain(k);
      expect(line).not.toMatch(/sk-or-/);
      expect(line).not.toMatch(/vault:v\d+:/);
    }
  });
});

describe("releaseVetraKey", () => {
  it("deletes the key and marks the row DELETED; a second release is a no-op", async () => {
    const s = await setup();
    await provision(s.broker);
    await s.broker.releaseVetraKey(ENV);
    await s.broker.releaseVetraKey(ENV);
    expect(s.fake.keys.size).toBe(0);
    expect(await s.store.get(ENV)).toMatchObject({
      status: "DELETED",
      key_ciphertext: null,
    });
    expect(s.fake.calls.filter((c) => c.startsWith("deleteKey"))).toHaveLength(
      1,
    );
  });
});

describe("studioLlmUsage", () => {
  it("reports this month's usage and the reset date, cached for 60 seconds", async () => {
    const s = await setup();
    await provision(s.broker);
    [...s.fake.keys.values()][0].usageMonthly = 3.2;
    expect(await s.broker.studioLlmUsage(ENV)).toStrictEqual({
      source: "VETRA",
      model: DEFAULT_STUDIO_MODEL,
      usageUsd: 3.2,
      limitUsd: 20,
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    await s.broker.studioLlmUsage(ENV);
    expect(s.fake.calls.filter((c) => c.startsWith("getKey"))).toHaveLength(1);
    expect(await s.broker.studioLlmUsage("no-such-env")).toBeNull();
  });

  it("a provision or release drops the cached usage of that env", async () => {
    const s = await setup();
    expect(await s.broker.studioLlmUsage(ENV)).toBeNull();
    await provision(s.broker);
    expect(await s.broker.studioLlmUsage(ENV)).toMatchObject({
      source: "VETRA",
      limitUsd: 20,
    });
    await s.broker.releaseVetraKey(ENV);
    expect(await s.broker.studioLlmUsage(ENV)).toBeNull();
  });

  it("computes the next monthly reset across a year end", () => {
    expect(nextMonthlyReset(new Date("2026-12-31T23:59:00.000Z"))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("toLlmGraphQLError", () => {
  it("passes GraphQL errors through, maps OpenRouter errors to UPSTREAM_ERROR and hides the rest", () => {
    const logger = { error: vi.fn() };
    const g = new GraphQLError("x", { extensions: { code: "FORBIDDEN" } });
    expect(toLlmGraphQLError(g, logger)).toBe(g);
    const up = toLlmGraphQLError(
      new OpenRouterError(502, "bad gateway sk-or-v1-x"),
      logger,
    );
    expect(up.extensions.code).toBe("UPSTREAM_ERROR");
    expect(up.message).toBe("OpenRouter request failed (502)");
    const internal = toLlmGraphQLError(
      new Error("pg said vault:v1:abc="),
      logger,
    );
    expect(internal.extensions.code).toBe("INTERNAL");
    expect(internal.message).toBe("Internal error");
    for (const [line] of logger.error.mock.calls)
      expect(String(line)).not.toMatch(/sk-or-|vault:v1:/);
  });
});
