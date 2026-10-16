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

export interface VetraLlmDB {
  studio_llm_keys: StudioLlmKeys;
}
