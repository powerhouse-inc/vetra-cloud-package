/** The largest monthly LLM budget (USD) a code or the deployment default may set. */
export const MAX_LLM_BUDGET_USD = 10_000;

export function isValidLlmBudget(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= MAX_LLM_BUDGET_USD;
}

export function roundUsd(v: number): number {
  return Math.round(v * 100) / 100;
}
