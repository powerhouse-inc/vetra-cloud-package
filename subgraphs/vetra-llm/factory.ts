import type { Kysely } from "kysely";
import { OpenBaoTransitClient } from "../vetra-cloud-secrets/openbao-transit.js";
import type { SecretsService } from "../vetra-cloud-secrets/services/secrets-service.js";
import { createKeyVault, type KeyVault } from "../vetra-licensing/key-vault.js";
import {
  studioLlmBudgetForDid,
  type StudioAccessDeps,
} from "../vetra-licensing/studio-access.js";
import { createLlmBroker, type LlmBroker } from "./broker.js";
import { loadLlmConfig, type LlmConfig } from "./config.js";
import type { VetraLlmDB } from "./db/schema.js";
import { createOpenRouterApi, type OpenRouterApi } from "./openrouter.js";
import { createLlmKeyStore } from "./store.js";

const DEFAULT_TRANSIT_ROLE = "vetra-secrets";

/** Built exactly as the pool and licensing build it (OPENBAO_TRANSIT_ROLE, OPENBAO_TRANSIT_KEY_PREFIX). */
export function transitFromEnv(
  env: Record<string, string | undefined>,
): OpenBaoTransitClient | null {
  const addr = env.OPENBAO_ADDR;
  if (!addr) return null;
  return new OpenBaoTransitClient({
    addr,
    role: env.OPENBAO_TRANSIT_ROLE ?? DEFAULT_TRANSIT_ROLE,
    keyNamePrefix: env.OPENBAO_TRANSIT_KEY_PREFIX,
  });
}

export interface ProcessBroker {
  broker: LlmBroker;
  cfg: LlmConfig;
  openrouter: OpenRouterApi | null;
  keyVault: KeyVault | null;
}

/** One broker definition for every subgraph that provisions keys (vetra-llm, vetra-studio-pool). */
export function createProcessBroker(input: {
  db: Kysely<VetraLlmDB>;
  transit: OpenBaoTransitClient | null;
  secrets: Pick<SecretsService, "setSecret" | "setEnvVar"> | null;
  studio: StudioAccessDeps;
  env: Record<string, string | undefined>;
}): ProcessBroker {
  const cfg = loadLlmConfig(input.env);
  const openrouter = cfg.managementKey
    ? createOpenRouterApi({
        managementKey: cfg.managementKey,
        baseUrl: cfg.baseUrl,
      })
    : null;
  const keyVault = createKeyVault(input.transit);
  const broker = createLlmBroker({
    store: createLlmKeyStore(input.db),
    openrouter,
    keyVault,
    secrets: input.secrets,
    budgetForDid: (did) => studioLlmBudgetForDid(input.studio, did),
    cfg,
    now: () => new Date(),
    logger: console,
  });
  return { broker, cfg, openrouter, keyVault };
}
