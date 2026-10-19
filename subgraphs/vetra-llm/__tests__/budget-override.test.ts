import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioLlmBudget } from "../../vetra-licensing/studio-access.js";
import { createLlmBroker } from "../broker.js";
import { DEFAULT_STUDIO_MODEL } from "../config.js";
import { createBudgetStore, createLlmKeyStore } from "../store.js";
import { runLlmSweepOnce } from "../sweeper.js";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import { createFakeSecrets, fakeKeyVault, holderDid } from "./fakes.js";
import { openLlmDb } from "./llm-db.js";
import {
  ADMIN,
  ENV,
  OWNER,
  asUser,
  resolverHarness,
} from "./resolver-harness.js";

const NOW = new Date("2026-10-15T12:00:00.000Z");

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

async function brokerSetup(budget: StudioLlmBudget) {
  const h = await openLlmDb();
  destroy = h.destroy;
  const fake = createFakeOpenRouter(() => NOW);
  const secrets = createFakeSecrets();
  const store = createLlmKeyStore(h.db);
  const budgets = createBudgetStore(h.db);
  const budgetForDid = vi.fn(async (_did: string) => budget);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const broker = createLlmBroker({
    store,
    openrouter: fake.api,
    keyVault: fakeKeyVault,
    secrets,
    budgetForDid,
    budgetOverride: (env) => budgets.getOverride(env),
    cfg: {
      defaultModel: DEFAULT_STUDIO_MODEL,
      workspaceId: "ws-1",
      fallbackModels: [],
    },
    now: () => NOW,
    logger,
  });
  const sweep = () =>
    runLlmSweepOnce({
      store,
      openrouter: fake.api,
      keyVault: fakeKeyVault,
      secrets,
      budgetForDid,
      budgetOverride: (env) => budgets.getOverride(env),
      envOf: async () => ({ tenantId: "t-1", status: "READY" }),
      workspaceId: null,
      now: () => NOW,
      logger,
    });
  const override = (limit: number) =>
    budgets.setOverride({
      environment_id: ENV,
      limit_usd: limit,
      set_by: ADMIN,
      updated_at: NOW.toISOString(),
    });
  return {
    fake,
    secrets,
    store,
    budgets,
    budgetForDid,
    broker,
    sweep,
    override,
  };
}

describe("per-Studio budget override", () => {
  it("override wins over invite-code and default budgets", async () => {
    // The licence's budget (invite-code or default) is $20; the override says $75.
    const s = await brokerSetup({ allowed: true, budgetUsd: 20 });
    await s.override(75);
    const grant = await s.broker.ensureVetraKey({
      environmentId: ENV,
      ownerDid: holderDid(),
    });
    expect(grant?.limitUsd).toBe(75);
    expect([...s.fake.keys.values()][0].limit).toBe(75);

    // The sweeper keeps the override, not the licence budget.
    expect((await s.sweep()).limited).toBe(0);
    expect((await s.store.get(ENV))?.limit_usd).toBe(75);

    // A changed override is PATCHed by the sweeper.
    await s.override(120);
    expect((await s.sweep()).limited).toBe(1);
    expect([...s.fake.keys.values()][0].limit).toBe(120);

    // An override of 0 disables the key like an exhausted licence budget.
    await s.override(0);
    expect((await s.sweep()).disabled).toBe(1);
  });

  it("an override never opens a Studio whose licence is not usable", async () => {
    const s = await brokerSetup({ allowed: false, budgetUsd: 0 });
    await s.override(75);
    expect(
      await s.broker.ensureVetraKey({
        environmentId: ENV,
        ownerDid: holderDid(),
      }),
    ).toBeNull();
    expect(s.fake.keys.size).toBe(0);
  });

  it("an override lifts a licence with no budget", async () => {
    const s = await brokerSetup({ allowed: true, budgetUsd: 0 });
    await s.override(30);
    const grant = await s.broker.ensureVetraKey({
      environmentId: ENV,
      ownerDid: holderDid(),
    });
    expect(grant?.limitUsd).toBe(30);
  });
});

describe("setStudioLlmBudget", () => {
  it("setStudioLlmBudget updates the key limit and handles open requests", async () => {
    const s = await resolverHarness();
    destroy = s.destroy;
    await s.provision();
    expect(
      await s.r.VetraLlmMutations.requestStudioLlmBudget(
        {},
        { environmentId: ENV },
        asUser(OWNER),
      ),
    ).toBe(true);

    const usage = await s.r.VetraLlmMutations.setStudioLlmBudget(
      {},
      { environmentId: ENV, limitUsd: 50 },
      asUser(ADMIN),
    );
    expect(usage).toMatchObject({ source: "VETRA", limitUsd: 50 });
    expect([...s.fake.keys.values()][0].limit).toBe(50);
    expect((await s.store.get(ENV))?.limit_usd).toBe(50);
    expect(await s.budgets.getOverride(ENV)).toBe(50);
    const reqs = await s.db
      .selectFrom("studio_llm_budget_requests")
      .selectAll()
      .execute();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].handled_at).toBe(s.clock.now.toISOString());
    const ov = await s.db
      .selectFrom("studio_llm_budget_overrides")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(ov.set_by).toBe(ADMIN);

    // The handled request no longer blocks a new one.
    expect(
      await s.r.VetraLlmMutations.requestStudioLlmBudget(
        {},
        { environmentId: ENV },
        asUser(OWNER),
      ),
    ).toBe(true);
  });

  it("writes the override for a Studio without a key yet and answers its usage", async () => {
    const s = await resolverHarness();
    destroy = s.destroy;
    const usage = await s.r.VetraLlmMutations.setStudioLlmBudget(
      {},
      { environmentId: ENV, limitUsd: 40 },
      asUser(ADMIN),
    );
    expect(usage).toMatchObject({ source: "VETRA", usageUsd: 0, limitUsd: 40 });
    expect(s.fake.keys.size).toBe(0);
    // The next provision uses the override.
    expect(await s.provision()).toMatchObject({ llmBudgetUsd: 40 });
  });

  it("an override of 0 caps the key at $0 now (the sweeper then disables it)", async () => {
    const s = await resolverHarness();
    destroy = s.destroy;
    await s.provision();
    await s.r.VetraLlmMutations.setStudioLlmBudget(
      {},
      { environmentId: ENV, limitUsd: 0 },
      asUser(ADMIN),
    );
    expect([...s.fake.keys.values()][0].limit).toBe(0);
    expect((await s.store.get(ENV))?.limit_usd).toBe(0);
  });

  it("setStudioLlmBudget is admin-only", async () => {
    const s = await resolverHarness();
    destroy = s.destroy;
    const set = (ctx: object, limitUsd = 50, environmentId = ENV) =>
      s.code(
        s.r.VetraLlmMutations.setStudioLlmBudget(
          {},
          { environmentId, limitUsd },
          ctx,
        ),
      );
    expect(await set({})).toBe("UNAUTHENTICATED");
    expect(await set(asUser(OWNER))).toBe("FORBIDDEN");
    expect(await set(asUser(ADMIN), -1)).toBe("BAD_USER_INPUT");
    expect(await set(asUser(ADMIN), Number.NaN)).toBe("BAD_USER_INPUT");
    expect(await set(asUser(ADMIN), 50, "nope")).toBe("NOT_FOUND");
    expect(await s.budgets.getOverride(ENV)).toBeNull();
  });
});
