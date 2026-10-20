export type LlmKeySource = "VETRA" | "BYO";
export type LlmKeyStatus = "ACTIVE" | "DISABLED" | "DELETED";

/** One model key per Studio environment (spec "Table studio_llm_keys"). */
export interface StudioLlmKeys {
  environment_id: string;
  source: LlmKeySource;
  /** OpenRouter key hash; VETRA keys only. */
  key_hash: string | null;
  /** The key, OpenBao transit ciphertext (createKeyVault); never logged, never returned. */
  key_ciphertext: string | null;
  /** double precision: read back as a JS number (numeric would be a string). */
  limit_usd: number | null;
  limit_reset: string;
  model: string;
  owner_did: string;
  status: LlmKeyStatus;
  created_at: string;
  updated_at: string;
}

/** An admin's per-Studio monthly budget; wins over invite-code and default budgets. */
export interface StudioLlmBudgetOverrides {
  environment_id: string;
  limit_usd: number;
  /** The admin's address. */
  set_by: string;
  updated_at: string;
}

/** A customer's "Request more budget"; open until an admin sets the Studio's budget. */
export interface StudioLlmBudgetRequests {
  id: string;
  environment_id: string;
  /** The operator's address. */
  requested_by: string;
  requested_at: string;
  handled_at: string | null;
}

export interface VetraLlmDB {
  studio_llm_keys: StudioLlmKeys;
  studio_llm_budget_overrides: StudioLlmBudgetOverrides;
  studio_llm_budget_requests: StudioLlmBudgetRequests;
}
