import { describe, expect, it } from "vitest";
import {
  MAX_LLM_BUDGET_USD,
  isValidLlmBudget,
  roundUsd,
} from "./llm-budget.js";

describe("llm budget values", () => {
  it("accepts 0 up to the cap, rejects the rest", () => {
    expect(MAX_LLM_BUDGET_USD).toBe(10_000);
    for (const ok of [0, 0.01, 20, 10_000])
      expect(isValidLlmBudget(ok)).toBe(true);
    for (const bad of [-0.01, 10_000.01, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isValidLlmBudget(bad)).toBe(false);
  });

  it("rounds to cents", () => {
    expect(roundUsd(12.346)).toBe(12.35);
    expect(roundUsd(20)).toBe(20);
  });
});
