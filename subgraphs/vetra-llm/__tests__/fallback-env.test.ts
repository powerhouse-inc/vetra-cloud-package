import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimWarmEnvironment,
  type ClaimDeps,
} from "../../vetra-studio-pool/claim.js";
import { createLlmBroker, MODEL_FALLBACKS_VAR } from "../broker.js";
import { DEFAULT_STUDIO_MODEL, loadLlmConfig } from "../config.js";
import { createLlmKeyStore } from "../store.js";
import { createFakeOpenRouter } from "./fake-openrouter.js";
import { createFakeSecrets, fakeKeyVault, holderDid } from "./fakes.js";
import { openLlmDb } from "./llm-db.js";

const TENANT = "warm-newt-75-aa726a95";

let destroy: (() => Promise<void>) | null = null;
afterEach(async () => {
  await destroy?.();
  destroy = null;
});

async function broker(fallbackModels: string[]) {
  const h = await openLlmDb();
  destroy = h.destroy;
  const secrets = createFakeSecrets();
  const b = createLlmBroker({
    store: createLlmKeyStore(h.db),
    openrouter: createFakeOpenRouter().api,
    keyVault: fakeKeyVault,
    secrets,
    budgetForDid: async () => ({ allowed: true, budgetUsd: 20 }),
    budgetOverride: async () => null,
    cfg: {
      defaultModel: DEFAULT_STUDIO_MODEL,
      workspaceId: null,
      fallbackModels,
    },
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { b, secrets };
}

describe("VETRA_LLM_FALLBACK_MODELS", () => {
  it("parses a trimmed, comma-separated list; unset is empty", () => {
    expect(loadLlmConfig({}).fallbackModels).toStrictEqual([]);
    expect(
      loadLlmConfig({
        VETRA_LLM_FALLBACK_MODELS: " openai/gpt-5 , ,google/gemini-2.5-pro,",
      }).fallbackModels,
    ).toStrictEqual(["openai/gpt-5", "google/gemini-2.5-pro"]);
  });

  it("claim and broker write VETRA_MODEL_FALLBACKS", async () => {
    expect(MODEL_FALLBACKS_VAR).toBe("VETRA_MODEL_FALLBACKS");

    // Broker (cold provision): alongside VETRA_MODEL.
    const { b, secrets } = await broker([
      "openai/gpt-5",
      "google/gemini-2.5-pro",
    ]);
    await b.provisionVetraKey({
      environmentId: "env-1",
      tenantId: TENANT,
      ownerDid: holderDid(),
    });
    expect(secrets.envVar(TENANT, "VETRA_MODEL")).toBe(DEFAULT_STUDIO_MODEL);
    expect(secrets.envVar(TENANT, "VETRA_MODEL_FALLBACKS")).toBe(
      "openai/gpt-5,google/gemini-2.5-pro",
    );

    // Warm-pool claim: in the replaceTenantConfig entries, so it survives the replace.
    const grant = await b.ensureVetraKey({
      environmentId: "env-2",
      ownerDid: holderDid(),
    });
    const replaceTenantConfig = vi.fn<ClaimDeps["replaceTenantConfig"]>(
      async () => {},
    );
    const d: ClaimDeps = {
      claimDb: {
        claimOneAvailable: async () => ({
          id: "env-2",
          tenantId: TENANT,
          subdomain: "warm-newt-75",
        }),
      } as never,
      hasStudioAccess: async () => true,
      grantLlmKey: async () => grant,
      releaseLlmKey: async () => {},
      legacyAnthropicKey: async () => null,
      setOwner: async () => {},
      readEnv: async () => ({
        owner: null,
        ownerOrgId: null,
        state: { owner: null, ownerOrgId: null, services: [] } as never,
      }),
      replaceTenantConfig,
      handOver: async () => {},
      deleteEnv: async () => {},
      cfg: { version: "1" },
      nowIso: () => "2026-10-15T12:00:00.000Z",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    expect(await claimWarmEnvironment(d, holderDid())).not.toBeNull();
    const entries = replaceTenantConfig.mock.calls[0][2];
    expect(entries).toContainEqual({
      key: "VETRA_MODEL_FALLBACKS",
      value: "openai/gpt-5,google/gemini-2.5-pro",
      secret: false,
    });
  });

  it("writes an empty VETRA_MODEL_FALLBACKS when unset, so a removed list converges", async () => {
    const { b, secrets } = await broker([]);
    await b.provisionVetraKey({
      environmentId: "env-1",
      tenantId: TENANT,
      ownerDid: holderDid(),
    });
    expect(secrets.envVar(TENANT, "VETRA_MODEL_FALLBACKS")).toBe("");
  });
});
