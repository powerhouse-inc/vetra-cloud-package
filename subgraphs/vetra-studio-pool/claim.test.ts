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
    },
    getKeyForDid: vi.fn(async () => "sk-ant-real"),
    setOwner: vi.fn(async () => {}),
    setSecret: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    cfg: { version: "0.0.1-dev.19" },
    nowIso: () => "2026-06-15T00:00:00Z",
    sleep: vi.fn(async () => {}), // no real delay in tests
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("claimWarmEnvironment", () => {
  it("returns null when the caller has no attached key (without consuming an env)", async () => {
    const d = deps({ getKeyForDid: vi.fn(async () => null) });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.claimDb.claimOneAvailable).not.toHaveBeenCalled();
  });

  it("returns null when no env is available", async () => {
    const d = deps();
    d.claimDb.claimOneAvailable = vi.fn(async () => null);
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
  });

  it("looks up the key by full DID; sets owner + claims by derived address", async () => {
    const d = deps();
    const res = await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCALLER");
    expect(d.getKeyForDid).toHaveBeenCalledWith("did:pkh:eip155:1:0xCALLER");
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

  it("injects the key (setSecret) BEFORE transferring ownership (setOwner)", async () => {
    // Coalescing the claim to a single pod rollout depends on the
    // <tenant>-secrets Secret already materializing before the owner-change
    // re-render fires. So every setSecret must run before setOwner.
    const order: string[] = [];
    const d = deps({
      setSecret: vi.fn(async () => {
        order.push("setSecret");
      }),
      setOwner: vi.fn(async () => {
        order.push("setOwner");
      }),
    });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    // All three secrets dispatched, then the single owner transfer.
    expect(order).toEqual(["setSecret", "setSecret", "setSecret", "setOwner"]);
    // setOwner is the LAST mutating call (so the re-render sees the key).
    expect(order[order.length - 1]).toBe("setOwner");
  });

  it("retries a transient setSecret failure and still succeeds", async () => {
    const d = deps();
    let calls = 0;
    d.setSecret = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      // first call (ANTHROPIC_API_KEY) fails once then succeeds; rest succeed
    });
    const res = await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(res).not.toBeNull();
    expect(d.terminate).not.toHaveBeenCalled();
  });

  it("TERMINATES the half-claimed env and returns null when injection keeps failing", async () => {
    const d = deps();
    d.setSecret = vi.fn(async () => {
      throw new Error("inject boom");
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.terminate).toHaveBeenCalledWith("doc-1");
  });

  it("TERMINATES and returns null when setOwner fails (after the key was injected)", async () => {
    const d = deps();
    d.setOwner = vi.fn(async () => {
      throw new Error("owner boom");
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.terminate).toHaveBeenCalledWith("doc-1");
    // Key is injected first now, so the secrets DID run before the owner step.
    expect(d.setSecret).toHaveBeenCalled();
  });
});
