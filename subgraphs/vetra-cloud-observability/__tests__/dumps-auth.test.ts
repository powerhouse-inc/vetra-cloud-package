import { describe, expect, it } from "vitest";
import { requireOwner } from "../dumps/auth.js";

describe("requireOwner", () => {
  it("throws UNAUTHENTICATED when caller is missing", () => {
    expect(() => requireOwner({ caller: null, envOwner: "0xAbC" })).toThrow(
      "UNAUTHENTICATED",
    );
    expect(() =>
      requireOwner({ caller: undefined, envOwner: "0xAbC" }),
    ).toThrow("UNAUTHENTICATED");
  });

  it("throws ENV_NOT_FOUND when env owner is missing", () => {
    expect(() => requireOwner({ caller: "0xabc", envOwner: null })).toThrow(
      "ENV_NOT_FOUND",
    );
    expect(() =>
      requireOwner({ caller: "0xabc", envOwner: undefined }),
    ).toThrow("ENV_NOT_FOUND");
  });

  it("throws FORBIDDEN when caller is not the owner", () => {
    expect(() => requireOwner({ caller: "0xdef", envOwner: "0xAbC" })).toThrow(
      "FORBIDDEN",
    );
  });

  it("passes when caller matches owner case-insensitively", () => {
    expect(() =>
      requireOwner({ caller: "0xabc", envOwner: "0xABC" }),
    ).not.toThrow();
    expect(() =>
      requireOwner({ caller: "0xABC", envOwner: "0xabc" }),
    ).not.toThrow();
    expect(() =>
      requireOwner({ caller: "0xAbC", envOwner: "0xAbC" }),
    ).not.toThrow();
  });
});
