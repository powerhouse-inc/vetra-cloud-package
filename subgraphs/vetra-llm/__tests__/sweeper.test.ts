import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioLlmBudget } from "../../vetra-licensing/studio-access.js";
import type { StudioLlmKeys } from "../db/schema.js";
import { createLlmKeyStore } from "../store.js";
import {
  ORPHAN_GRACE_MS,
  runLlmSweepOnce,
  type SweepDeps,
} from "../sweeper.js";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import { createFakeSecrets, fakeKeyVault, holderDid } from "./fakes.js";
import { openLlmDb } from "./llm-db.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

async function setup(
  opts: {
    envs?: Record<
      string,
      { tenantId: string | null; status: string | null } | null
    >;
    budgets?: Record<string, StudioLlmBudget>;
    /** App licence budgets by root licence id (absent: null). */
    appBudgets?: Record<string, number | null>;
    workspaceId?: string | null;
  } = {},
) {
  const h = await openLlmDb();
  destroy = h.destroy;
  const fake = createFakeOpenRouter(() => NOW);
  const secrets = createFakeSecrets();
  const store = createLlmKeyStore(h.db);
  const logs: string[] = [];
  const deps: SweepDeps = {
    store,
    openrouter: fake.api,
    keyVault: fakeKeyVault,
    secrets,
    budgetForDid: vi.fn(
      async (did: string) =>
        opts.budgets?.[did] ?? { allowed: true, budgetUsd: 20 },
    ),
    budgetOverride: async () => null,
    appBudget: vi.fn(
      async (root: string, _did: string) => opts.appBudgets?.[root] ?? null,
    ),
    envOf: async (id) =>
      opts.envs && id in opts.envs
        ? opts.envs[id]
        : { tenantId: `t-${id}`, status: "READY" },
    workspaceId: opts.workspaceId === undefined ? "ws-1" : opts.workspaceId,
    now: () => NOW,
    logger: {
      info: (m) => void logs.push(m),
      warn: (m) => void logs.push(m),
      error: (m) => void logs.push(m),
    },
  };
  /** A Studio row whose key exists on the fake (in the workspace). */
  const held = async (env: string, over: Partial<StudioLlmKeys> = {}) => {
    const hash = fake.seed({
      name: over.root_license_id ? `app:${env}` : `studio:${env}`,
      createdAt: ago(60 * 60_000),
      workspaceId: "ws-1",
    });
    fake.keys.get(hash)!.limit = 20;
    await store.upsert({
      environment_id: env,
      source: "VETRA",
      key_hash: hash,
      key_ciphertext: await fakeKeyVault.encrypt(fake.keys.get(hash)!.secret),
      limit_usd: 20,
      limit_reset: "monthly",
      model: "anthropic/claude-sonnet-4.6",
      owner_did: holderDid(),
      status: "ACTIVE",
      created_at: ago(60 * 60_000),
      updated_at: ago(60 * 60_000),
      ...over,
    });
    return hash;
  };
  return { fake, secrets, store, deps, held, logs };
}

describe("runLlmSweepOnce", () => {
  it("deletes the key of a deleted or released Studio", async () => {
    const s = await setup({
      envs: { gone: null, released: { tenantId: "t", status: "DESTROYED" } },
    });
    const a = await s.held("gone");
    const b = await s.held("released");
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({
      deleted: 2,
      failed: 0,
    });
    expect(s.fake.keys.has(a) || s.fake.keys.has(b)).toBe(false);
    expect(await s.store.get("gone")).toMatchObject({
      status: "DELETED",
      key_ciphertext: null,
    });
  });

  it("disables the key and removes the secret when the licence is no longer usable", async () => {
    const s = await setup({
      budgets: { [holderDid()]: { allowed: false, budgetUsd: 0 } },
    });
    const hash = await s.held("e1");
    await s.secrets.setSecret("t-e1", "OPENROUTER_API_KEY", "sk-or-v1-x");
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ disabled: 1 });
    expect(s.fake.keys.get(hash)!.disabled).toBe(true);
    expect(s.secrets.secret("t-e1", "OPENROUTER_API_KEY")).toBeUndefined();
    expect((await s.store.get("e1"))?.status).toBe("DISABLED");
  });

  it("re-enables a renewed licence's key, updates its limit and writes the secret back", async () => {
    const s = await setup({
      budgets: { [holderDid()]: { allowed: true, budgetUsd: 30 } },
    });
    const hash = await s.held("e1", { status: "DISABLED" });
    s.fake.keys.get(hash)!.disabled = true;
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ enabled: 1 });
    expect(s.fake.keys.get(hash)).toMatchObject({ disabled: false, limit: 30 });
    expect(s.secrets.secret("t-e1", "OPENROUTER_API_KEY")).toBe(
      s.fake.keys.get(hash)!.secret,
    );
  });

  it("PATCHes the limit when the budget on the code changed, and nothing when it did not", async () => {
    const s = await setup({
      budgets: { [holderDid()]: { allowed: true, budgetUsd: 45 } },
    });
    const hash = await s.held("e1");
    await s.held("e2", {
      owner_did: holderDid("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ limited: 1 });
    expect(s.fake.keys.get(hash)!.limit).toBe(45);
    expect((await s.store.get("e1"))?.limit_usd).toBe(45);
    expect(s.fake.calls.filter((c) => c.startsWith("updateKey"))).toHaveLength(
      1,
    );
  });

  it("deletes old studio: orphans in the workspace but keeps fresh ones, known ones and foreign names (Review Focus 3)", async () => {
    const s = await setup();
    const known = await s.held("e1");
    const old = s.fake.seed({
      name: "studio:lost",
      createdAt: ago(ORPHAN_GRACE_MS + 60_000),
      workspaceId: "ws-1",
    });
    const fresh = s.fake.seed({
      name: "studio:in-flight",
      createdAt: ago(60_000),
      workspaceId: "ws-1",
    });
    const foreign = s.fake.seed({
      name: "someone-else",
      createdAt: ago(ORPHAN_GRACE_MS * 10),
      workspaceId: "ws-1",
    });
    const otherDeployment = s.fake.seed({
      name: "studio:prod-env",
      createdAt: ago(ORPHAN_GRACE_MS * 10),
      workspaceId: "ws-prod",
    });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ orphans: 1 });
    expect(s.fake.keys.has(old)).toBe(false);
    for (const h of [known, fresh, foreign, otherDeployment])
      expect(s.fake.keys.has(h)).toBe(true);
  });

  it("never sweeps orphans without a workspace (staging and prod share the organisation)", async () => {
    const s = await setup({ workspaceId: null });
    s.fake.seed({
      name: "studio:lost",
      createdAt: ago(ORPHAN_GRACE_MS * 10),
      workspaceId: null,
    });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ orphans: 0 });
    expect(s.fake.calls.some((c) => c.startsWith("listKeys"))).toBe(false);
  });

  it("isolates a failing row and never logs keys", async () => {
    const s = await setup({
      budgets: { [holderDid()]: { allowed: true, budgetUsd: 45 } },
    });
    await s.held("e1");
    await s.held("e2");
    s.fake.failNext("updateKey", 500);
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({
      limited: 1,
      failed: 1,
    });
    for (const line of s.logs) expect(line).not.toMatch(/sk-or-|vault:v\d+:/);
  });
});
describe("runLlmSweepOnce: app licence keys", () => {
  it("leaves an app: key alone while its licence is active and its code has a budget, even without a Studio licence", async () => {
    const s = await setup({
      budgets: { [holderDid()]: { allowed: false, budgetUsd: 0 } },
      appBudgets: { "root-1": 20 },
    });
    const hash = await s.held("app-env", { root_license_id: "root-1" });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({
      deleted: 0,
      disabled: 0,
      limited: 0,
      failed: 0,
    });
    expect(s.fake.keys.get(hash)).toMatchObject({ disabled: false, limit: 20 });
    expect(await s.store.get("app-env")).toMatchObject({ status: "ACTIVE" });
    expect(s.deps.appBudget).toHaveBeenCalledWith("root-1", holderDid());
    expect(s.deps.budgetForDid).not.toHaveBeenCalled();
  });

  it("releases an app: key when its environment is gone", async () => {
    const s = await setup({
      envs: { "app-env": null },
      appBudgets: { "root-1": 20 },
    });
    const hash = await s.held("app-env", { root_license_id: "root-1" });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ deleted: 1 });
    expect(s.fake.keys.has(hash)).toBe(false);
    expect(await s.store.get("app-env")).toMatchObject({ status: "DELETED" });
  });

  it("disables an app: key once its licence ended, keeping the secret the app mounts", async () => {
    const s = await setup({ appBudgets: { "root-1": null } });
    const hash = await s.held("app-env", { root_license_id: "root-1" });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ disabled: 1 });
    expect(s.fake.keys.get(hash)!.disabled).toBe(true);
    expect(s.secrets.deleteSecret).not.toHaveBeenCalled();
  });

  it("deletes old app: orphans too", async () => {
    const s = await setup();
    const old = s.fake.seed({
      name: "app:lost",
      createdAt: ago(ORPHAN_GRACE_MS + 60_000),
      workspaceId: "ws-1",
    });
    expect(await runLlmSweepOnce(s.deps)).toMatchObject({ orphans: 1 });
    expect(s.fake.keys.has(old)).toBe(false);
  });
});
