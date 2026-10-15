/** The largest monthly LLM budget (USD) a code or the deployment default may set. */
export const MAX_LLM_BUDGET_USD = 10_000;

export function isValidLlmBudget(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= MAX_LLM_BUDGET_USD;
}

export function roundUsd(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * VETRA_LLM_DEFAULT_BUDGET_USD (per deployment): the monthly budget of a
 * usable studio licence whose code chain sets none. Unset or invalid: 0, so a
 * deployment that has not opted in provisions no Vetra keys.
 */
export function defaultLlmBudgetUsd(
  env: Record<string, string | undefined>,
): number {
  const raw = env.VETRA_LLM_DEFAULT_BUDGET_USD?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return isValidLlmBudget(n) ? roundUsd(n) : 0;
}
