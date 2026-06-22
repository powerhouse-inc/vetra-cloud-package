import { describe, it, expect, vi } from "vitest";
import { createResolvers } from "./resolvers.js";

const ctx = (address?: string) =>
  address
    ? { user: { address, networkId: "eip155", chainId: "1" } }
    : { user: undefined };

describe("VetraStudioPool resolvers", () => {
  it("throws UNAUTHENTICATED without a caller", async () => {
    const claim = vi.fn();
    const r = createResolvers({ claim } as never);
    await expect(
      r.VetraStudioPoolMutations.claimStudioEnvironment({}, {}, ctx()),
    ).rejects.toThrow(/UNAUTHENTICATED/);
    expect(claim).not.toHaveBeenCalled();
  });

  it("passes the caller's did:pkh to claim and returns its result", async () => {
    const claim = vi.fn(async () => ({ documentId: "d", subdomain: "s", tenantId: "t" }));
    const r = createResolvers({ claim } as never);
    const res = await r.VetraStudioPoolMutations.claimStudioEnvironment({}, {}, ctx("0xAbc"));
    expect(claim).toHaveBeenCalledWith("did:pkh:eip155:1:0xabc");
    expect(res).toEqual({ documentId: "d", subdomain: "s", tenantId: "t" });
  });

  it("returns null when claim returns null", async () => {
    const claim = vi.fn(async () => null);
    const r = createResolvers({ claim } as never);
    expect(
      await r.VetraStudioPoolMutations.claimStudioEnvironment({}, {}, ctx("0xAbc")),
    ).toBeNull();
  });

  it("exposes the current studio CLI version under VetraStudioPool.config", async () => {
    const claim = vi.fn();
    const r = createResolvers({ claim, version: "0.0.1-dev.42" } as never);
    // Query namespace resolves to an empty object the field resolver hangs off.
    const ns = r.Query.VetraStudioPool();
    expect(r.VetraStudioPoolQueries.config(ns, {}, ctx())).toEqual({
      version: "0.0.1-dev.42",
    });
  });
});
