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
    setSecrets: vi.fn(async () => {}),
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
    expect(res).toEqual({
      documentId: "doc-1",
      subdomain: "warm-newt-aaaa1111",
      tenantId: "warm-newt-aaaa1111-aaaa1111",
    });
  });

  it("writes all secrets + ADMINS in ONE batch (single notify → single pod bounce)", async () => {
    const d = deps();
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCALLER");
    // Exactly one batched write — NOT one-per-key (which would bounce the pod
    // once per secret).
    expect(d.setSecrets).toHaveBeenCalledTimes(1);
    const [tenantId, entries] = d.setSecrets.mock.calls[0];
    expect(tenantId).toBe("warm-newt-aaaa1111-aaaa1111");
    // The three Anthropic key names all carry the resolved key value...
    for (const name of SECRET_NAMES) {
      expect(entries).toContainEqual({ key: name, value: "sk-ant-real" });
    }
    // ...and ADMINS carries the claimant's lowercased address, so the owner is
    // an admin of the embedded switchboard without a gitops re-render.
    expect(entries).toContainEqual({ key: "ADMINS", value: "0xcaller" });
    expect(entries).toHaveLength(4);
  });

  it("injects the secrets BEFORE transferring ownership (setOwner)", async () => {
    const order: string[] = [];
    const d = deps({
      setSecrets: vi.fn(async () => {
        order.push("setSecrets");
      }),
      setOwner: vi.fn(async () => {
        order.push("setOwner");
      }),
    });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(order).toEqual(["setSecrets", "setOwner"]);
  });

  it("retries a transient setSecrets failure and still succeeds", async () => {
    const d = deps();
    let calls = 0;
    d.setSecrets = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    });
    const res = await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(res).not.toBeNull();
    expect(d.terminate).not.toHaveBeenCalled();
  });

  it("TERMINATES the half-claimed env and returns null when injection keeps failing", async () => {
    const d = deps();
    d.setSecrets = vi.fn(async () => {
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
    // Secrets are injected first now, so the batch DID run before the owner step.
    expect(d.setSecrets).toHaveBeenCalled();
  });
});
