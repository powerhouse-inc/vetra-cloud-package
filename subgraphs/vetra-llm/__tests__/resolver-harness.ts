import { vi } from "vitest";
import { OWNER_ONLY_ACCESS } from "../../vetra-cloud-observability/env-access.js";
import { createLlmBroker } from "../broker.js";
import { DEFAULT_STUDIO_MODEL } from "../config.js";
import { createLlmResolvers, type LlmResolverDeps } from "../resolvers.js";
import { createBudgetStore, createLlmKeyStore } from "../store.js";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import { createFakeSecrets, fakeKeyVault } from "./fakes.js";
import { openLlmDb } from "./llm-db.js";

export const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const ADMIN = "0xcccccccccccccccccccccccccccccccccccccccc";
export const TENANT = "warm-newt-75-aa726a95";
export const ENV = "aa726a95-1111-2222-3333-444455556666";
const STUDIO = {
  packages: [
    { name: "vetra", registry: "https://registry.vetra.io", version: "1" },
  ],
};
export const asUser = (address: string) => ({
  user: { address },
  isAdmin: (a: string) => a.toLowerCase() === ADMIN,
});

type Fn = (p: unknown, a: object, c: object) => Promise<unknown>;
type R = {
  VetraLlmQueries: Record<string, Fn>;
  VetraLlmMutations: Record<string, Fn>;
};

/** vetra-llm resolvers over a real namespace db, a fake OpenRouter and a movable clock. */
export async function resolverHarness(
  opts: { budgetUsd?: number; over?: Partial<LlmResolverDeps> } = {},
) {
  const h = await openLlmDb();
  const fake = createFakeOpenRouter();
  const secrets = createFakeSecrets();
  const store = createLlmKeyStore(h.db);
  const budgets = createBudgetStore(h.db);
  const clock = { now: new Date("2026-10-15T12:00:00.000Z") };
  const logs: { level: string; msg: string }[] = [];
  const logger = {
    info: (msg: string) => void logs.push({ level: "info", msg }),
    warn: (msg: string) => void logs.push({ level: "warn", msg }),
    error: (msg: string) => void logs.push({ level: "error", msg }),
  };
  const broker = createLlmBroker({
    store,
    openrouter: fake.api,
    keyVault: fakeKeyVault,
    secrets,
    budgetForDid: async () => ({
      allowed: true,
      budgetUsd: opts.budgetUsd ?? 20,
    }),
    budgetOverride: (env) => budgets.getOverride(env),
    cfg: {
      defaultModel: DEFAULT_STUDIO_MODEL,
      workspaceId: null,
      fallbackModels: [],
    },
    now: () => clock.now,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const r = createLlmResolvers({
    broker,
    budgets,
    tenantOwners: async () => ({ ok: true, owners: [OWNER] }),
    envIdsByTenant: async (t) => (t === TENANT ? [ENV] : []),
    envRow: async (id) =>
      id === ENV
        ? { owner: OWNER, ownerOrgId: null, appId: null, tenantId: TENANT }
        : null,
    envState: async (id) => (id === ENV ? (STUDIO as never) : null),
    keyStatus: async (id) => (await store.get(id))?.status ?? null,
    access: OWNER_ONLY_ACCESS,
    secrets,
    logger,
    now: () => clock.now,
    migrate: vi.fn(),
    ...opts.over,
  }) as unknown as R;
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "OK",
      (e: { extensions?: { code?: unknown } }) => e.extensions?.code,
    );
  const provision = () =>
    r.VetraLlmMutations.provisionStudioLlm(
      {},
      { tenantId: TENANT },
      asUser(OWNER),
    );
  return {
    r,
    fake,
    secrets,
    store,
    budgets,
    clock,
    logs,
    code,
    provision,
    db: h.db,
    destroy: h.destroy,
  };
}
