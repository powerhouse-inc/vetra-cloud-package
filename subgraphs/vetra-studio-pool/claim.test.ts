import { describe, it, expect, vi } from "vitest";
import { claimWarmEnvironment } from "./claim.js";

const SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "VETRA_ANTHROPIC_API_KEY",
  "VETRA_CLI_ANTHROPIC_API_KEY",
];

function deps(over: Partial<any> = {}) {
  return {
    claimDb: {
      claimOneAvailable: vi.fn(async () => ({
        id: "doc-1",
        tenantId: "warm-newt-aaaa1111-aaaa1111",
        subdomain: "warm-newt-aaaa1111",
        poolState: "CLAIMED",
      })),
      markFailed: vi.fn(async () => {}),
    },
    getKeyForDid: vi.fn(async () => "sk-ant-real"),
    setOwner: vi.fn(async () => {}),
    setSecret: vi.fn(async () => {}),
    cfg: { version: "0.0.1-dev.19" },
    nowIso: () => "2026-06-15T00:00:00Z",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("claimWarmEnvironment", () => {
  it("returns null when the caller has no attached key (without consuming an env)", async () => {
    const d = deps({ getKeyForDid: vi.fn(async () => null) });
    expect(await claimWarmEnvironment(d as never, "0xCaller")).toBeNull();
    expect(d.claimDb.claimOneAvailable).not.toHaveBeenCalled();
  });

  it("returns null when no env is available", async () => {
    const d = deps();
    d.claimDb.claimOneAvailable = vi.fn(async () => null);
    expect(await claimWarmEnvironment(d as never, "0xCaller")).toBeNull();
  });

  it("assigns, sets owner (lowercased), injects 3 secrets, returns ids", async () => {
    const d = deps();
    const res = await claimWarmEnvironment(d as never, "0xCALLER");
    expect(d.claimDb.claimOneAvailable).toHaveBeenCalledWith(
      "0xcaller",
      "0.0.1-dev.19",
      "2026-06-15T00:00:00Z",
    );
    expect(d.setOwner).toHaveBeenCalledWith("doc-1", "0xcaller");
    expect(d.setSecret.mock.calls.map((c: any[]) => c[1]).sort()).toEqual(
      [...SECRET_NAMES].sort(),
    );
    for (const call of d.setSecret.mock.calls) {
      expect(call).toEqual([
        "warm-newt-aaaa1111-aaaa1111",
        expect.any(String),
        "sk-ant-real",
      ]);
    }
    expect(res).toEqual({
      documentId: "doc-1",
      subdomain: "warm-newt-aaaa1111",
      tenantId: "warm-newt-aaaa1111-aaaa1111",
    });
  });

  it("marks FAILED and returns null when injection throws after assign", async () => {
    const d = deps();
    d.setSecret = vi.fn(async () => {
      throw new Error("inject boom");
    });
    expect(await claimWarmEnvironment(d as never, "0xCaller")).toBeNull();
    expect(d.claimDb.markFailed).toHaveBeenCalledWith("doc-1");
  });
});
