import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { claimWarmEnvironment, legacyKeyFor } from "./claim.js";

const LEGACY_NAMES = ["ANTHROPIC_API_KEY", "VETRA_ANTHROPIC_API_KEY", "VETRA_CLI_ANTHROPIC_API_KEY"];

type ClaimedEnv = {
  id: string;
  tenantId: string;
  subdomain: string;
  poolState: string;
};
type SecretEntry = { key: string; value: string; secret?: boolean };
const WARM_STATE = { owner: null, ownerOrgId: null, services: [] };

function deps(over: Partial<any> = {}) {
  return {
    claimDb: {
      claimOneAvailable: vi.fn<
        (...args: unknown[]) => Promise<ClaimedEnv | null>
      >(async () => ({
        id: "doc-1",
        tenantId: "warm-newt-aaaa1111-aaaa1111",
        subdomain: "warm-newt-aaaa1111",
        poolState: "CLAIMED",
      })),
    },
    hasStudioAccess: vi.fn(async (_did: string) => true),
    grantLlmKey: vi.fn(async (_env: string, _did: string) => ({
      key: "sk-or-v1-real",
      model: "anthropic/claude-sonnet-4.6",
      fallbackModels: ["openai/gpt-5"],
    })),
    releaseLlmKey: vi.fn(async (_env: string) => {}),
    legacyAnthropicKey: vi.fn(async (_did: string) => "sk-ant-real" as string | null),
    setOwner: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    replaceTenantConfig: vi.fn<
      (tenantId: string, state: unknown, entries: SecretEntry[]) => Promise<void>
    >(async () => {}),
    storeLaunchSecretHash: vi.fn(async (_env: string, _hash: string) => {}),
    readEnv: vi.fn(async (_id: string) => ({ owner: null, ownerOrgId: null, state: WARM_STATE })),
    handOver: vi.fn(async (_id: string, _addr: string) => {}),
    deleteEnv: vi.fn(async () => {}),
    cfg: { version: "0.0.1-dev.19" },
    nowIso: () => "2026-06-15T00:00:00Z",
    sleep: vi.fn(async () => {}), // no real delay in tests
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("claimWarmEnvironment", () => {
  it("returns null without a usable studio licence (without consuming an env or minting a key)", async () => {
    const d = deps({ hasStudioAccess: vi.fn(async () => false) });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.claimDb.claimOneAvailable).not.toHaveBeenCalled();
    expect(d.grantLlmKey).not.toHaveBeenCalled();
  });

  it("returns null when no env is available", async () => {
    const d = deps();
    d.claimDb.claimOneAvailable = vi.fn<
      (...args: unknown[]) => Promise<ClaimedEnv | null>
    >(async () => null);
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
  });

  it("gates on the full DID; grants the key for the claimed env; sets owner + claims by derived address", async () => {
    const d = deps();
    const res = await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCALLER");
    expect(d.hasStudioAccess).toHaveBeenCalledWith("did:pkh:eip155:1:0xCALLER");
    expect(d.grantLlmKey).toHaveBeenCalledWith("doc-1", "did:pkh:eip155:1:0xCALLER");
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

  it("writes the model key, its model, legacy keys, ADMINS and the session secret in ONE batch", async () => {
    const d = deps();
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCALLER");
    expect(d.replaceTenantConfig).toHaveBeenCalledTimes(1);
    const [tenantId, state, entries] = d.replaceTenantConfig.mock.calls[0];
    expect(state).toBe(WARM_STATE);
    expect(tenantId).toBe("warm-newt-aaaa1111-aaaa1111");
    expect(entries).toContainEqual({ key: "OPENROUTER_API_KEY", value: "sk-or-v1-real" });
    // The model is a plain env var, not a secret.
    expect(entries).toContainEqual({ key: "VETRA_MODEL", value: "anthropic/claude-sonnet-4.6", secret: false });
    // Transition only (removed in phase 3): agents built before OpenRouter still read these.
    for (const name of LEGACY_NAMES) expect(entries).toContainEqual({ key: name, value: "sk-ant-real" });
    expect(entries).toContainEqual({ key: "ADMINS", value: "0xcaller" });
    expect(entries.find((e) => e.key === "VETRA_SESSION_EXPORT_SECRET")?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(entries).toContainEqual({ key: "VETRA_MODEL_FALLBACKS", value: "openai/gpt-5", secret: false });
    expect(entries).toHaveLength(9);
  });

  it("claim writes the launch secret in the same batched write", async () => {
    const order: string[] = [];
    const d = deps();
    d.storeLaunchSecretHash = vi.fn(async () => {
      order.push("storeLaunchSecretHash");
    });
    d.replaceTenantConfig = vi.fn(async () => {
      order.push("replaceTenantConfig");
    });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(d.replaceTenantConfig).toHaveBeenCalledTimes(1);
    const [, , entries] = d.replaceTenantConfig.mock.calls[0] as unknown as [string, unknown, SecretEntry[]];
    const launch = entries.filter((e) => e.key === "VETRA_STUDIO_LAUNCH_SECRET");
    expect(launch).toHaveLength(1);
    // A secret (the default), 32 random bytes, distinct from the session secret.
    expect(launch[0].secret).toBeUndefined();
    expect(launch[0].value).toMatch(/^[0-9a-f]{64}$/);
    expect(launch[0].value).not.toBe(entries.find((e) => e.key === "VETRA_SESSION_EXPORT_SECRET")?.value);
    // Only its sha256 is stored, for the claimed env, before the write.
    const sha = createHash("sha256").update(launch[0].value).digest("hex");
    expect(d.storeLaunchSecretHash).toHaveBeenCalledWith("doc-1", sha);
    expect(order).toEqual(["storeLaunchSecretHash", "replaceTenantConfig"]);
    // Never logged.
    for (const fn of [d.logger.info, d.logger.warn, d.logger.error]) {
      for (const call of fn.mock.calls) expect(String(call[0])).not.toContain(launch[0].value);
    }
    // A fresh secret per claim.
    const d2 = deps();
    await claimWarmEnvironment(d2 as never, "did:pkh:eip155:1:0xCaller");
    const [, , entries2] = d2.replaceTenantConfig.mock.calls[0];
    expect(entries2.find((e) => e.key === "VETRA_STUDIO_LAUNCH_SECRET")?.value).not.toBe(launch[0].value);
  });

  it("deletes the env and writes nothing when the launch-secret hash cannot be stored", async () => {
    const d = deps({
      storeLaunchSecretHash: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.storeLaunchSecretHash).toHaveBeenCalledTimes(3);
    expect(d.replaceTenantConfig).not.toHaveBeenCalled();
    expect(d.setOwner).not.toHaveBeenCalled();
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
    expect(d.releaseLlmKey).toHaveBeenCalledWith("doc-1");
  });

  it("re-states the Renown URL on claim when configured, and omits it when unset", async () => {
    const d = deps({ cfg: { version: "0.0.1-dev.19", renownUrl: "https://renown-staging.vetra.io" } });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(d.replaceTenantConfig.mock.calls[0][2]).toContainEqual({
      key: "VETRA_CLOUD_RENOWN_URL",
      value: "https://renown-staging.vetra.io",
      secret: false,
    });
    const d2 = deps();
    await claimWarmEnvironment(d2 as never, "did:pkh:eip155:1:0xCaller");
    expect(d2.replaceTenantConfig.mock.calls[0][2].map((e) => e.key)).not.toContain("VETRA_CLOUD_RENOWN_URL");
  });

  it("still claims without an LLM budget or legacy key: the Studio comes up in connect-a-model mode", async () => {
    const d = deps({ grantLlmKey: vi.fn(async () => null), legacyAnthropicKey: vi.fn(async () => null) });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).not.toBeNull();
    const [, , entries] = d.replaceTenantConfig.mock.calls[0];
    expect(entries.map((e) => e.key).sort()).toStrictEqual([
      "ADMINS",
      "VETRA_SESSION_EXPORT_SECRET",
      "VETRA_STUDIO_LAUNCH_SECRET",
    ]);
    expect(d.releaseLlmKey).not.toHaveBeenCalled();
  });

  it("releases the minted key and deletes the env when the claim fails after the grant", async () => {
    const d = deps();
    d.replaceTenantConfig = vi.fn(async () => {
      throw new Error("inject boom");
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.releaseLlmKey).toHaveBeenCalledWith("doc-1");
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
  });

  it("releases the minted key when setOwner fails after the grant", async () => {
    const d = deps({
      setOwner: vi.fn(async () => {
        throw new Error("owner boom");
      }),
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.releaseLlmKey).toHaveBeenCalledWith("doc-1");
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
  });

  it("deletes the env even when the key release itself fails", async () => {
    const d = deps({
      releaseLlmKey: vi.fn(async () => {
        throw new Error("release boom");
      }),
    });
    d.replaceTenantConfig = vi.fn(async () => {
      throw new Error("inject boom");
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
  });

  it("releases a key the broker minted before the grant threw (secret write failed)", async () => {
    const live = new Set<string>();
    const d = deps({
      grantLlmKey: vi.fn(async (env: string) => {
        live.add(env);
        throw new Error("secret write failed");
      }),
      releaseLlmKey: vi.fn(async (env: string) => {
        live.delete(env);
      }),
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.replaceTenantConfig).not.toHaveBeenCalled();
    expect(d.releaseLlmKey).toHaveBeenCalledWith("doc-1");
    expect(live.size).toBe(0);
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
  });

  it("legacyKeyFor: flag on looks the key up, flag off never does", async () => {
    const lookup = vi.fn(async () => "sk-ant-real" as string | null);
    expect(await legacyKeyFor(true, lookup, "did:x")).toBe("sk-ant-real");
    expect(lookup).toHaveBeenCalledWith("did:x");
    lookup.mockClear();
    expect(await legacyKeyFor(false, lookup, "did:x")).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("flag off: no Anthropic names are written", async () => {
    const d = deps({ legacyAnthropicKey: (did: string) => legacyKeyFor(false, async () => "sk-ant-real", did) });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    const [, , entries] = d.replaceTenantConfig.mock.calls[0];
    for (const n of LEGACY_NAMES) expect(entries.map((e) => e.key)).not.toContain(n);
  });

  it("logs only the error name when the key release fails", async () => {
    const d = deps({
      releaseLlmKey: vi.fn(async () => {
        throw new Error("boom sk-or-v1-leak");
      }),
    });
    d.replaceTenantConfig = vi.fn(async () => {
      throw new Error("inject boom");
    });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    const lines = d.logger.warn.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes("key release failed"))).toBe(true);
    for (const l of lines) expect(l).not.toContain("sk-or-");
  });

  it("never logs the model key", async () => {
    const d = deps();
    d.replaceTenantConfig = vi.fn(async () => {
      throw new Error("upstream said sk-or-v1-leak");
    });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    const lines = [...d.logger.info.mock.calls, ...d.logger.warn.mock.calls, ...d.logger.error.mock.calls].flat();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(String(line)).not.toMatch(/sk-or-|sk-ant-/);
  });

  it("injects the secrets BEFORE transferring ownership (setOwner)", async () => {
    const order: string[] = [];
    const d = deps({
      replaceTenantConfig: vi.fn(async () => {
        order.push("replaceTenantConfig");
      }),
      setOwner: vi.fn(async () => {
        order.push("setOwner");
      }),
    });
    await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(order).toEqual(["replaceTenantConfig", "setOwner"]);
  });

  it("re-checks the document first: an env someone already owns is deleted, never handed out", async () => {
    for (const doc of [
      { owner: "0xattacker", ownerOrgId: null, state: WARM_STATE },
      { owner: null, ownerOrgId: "org-1", state: WARM_STATE },
      null,
    ]) {
      const d = deps({ readEnv: vi.fn(async () => doc) });
      expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
      expect(d.replaceTenantConfig).not.toHaveBeenCalled();
      expect(d.setOwner).not.toHaveBeenCalled();
      expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
      expect(d.logger.warn).toHaveBeenCalled();
    }
  });

  it("hands the document's protection to the new owner after SET_OWNER", async () => {
    const order: string[] = [];
    const d = deps({
      setOwner: vi.fn(async () => void order.push("setOwner")),
      handOver: vi.fn(async (id: string, addr: string) => void order.push(`handOver:${id}:${addr}`)),
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCALLER")).not.toBeNull();
    expect(order).toEqual(["setOwner", "handOver:doc-1:0xcaller"]);
  });

  it("keeps the claim when the protection hand-over fails (the env protector retries it)", async () => {
    const d = deps({
      handOver: vi.fn(async () => {
        throw new Error("perm down");
      }),
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).not.toBeNull();
    expect(d.deleteEnv).not.toHaveBeenCalled();
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it("retries a transient replaceTenantConfig failure and still succeeds", async () => {
    const d = deps();
    let calls = 0;
    d.replaceTenantConfig = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    });
    const res = await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller");
    expect(res).not.toBeNull();
    expect(d.deleteEnv).not.toHaveBeenCalled();
  });

  it("TERMINATES the half-claimed env and returns null when injection keeps failing", async () => {
    const d = deps();
    d.replaceTenantConfig = vi.fn(async () => {
      throw new Error("inject boom");
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
  });

  it("TERMINATES and returns null when setOwner fails (after the key was injected)", async () => {
    const d = deps();
    d.setOwner = vi.fn(async () => {
      throw new Error("owner boom");
    });
    expect(await claimWarmEnvironment(d as never, "did:pkh:eip155:1:0xCaller")).toBeNull();
    expect(d.deleteEnv).toHaveBeenCalledWith("doc-1");
    // Secrets are injected first now, so the batch DID run before the owner step.
    expect(d.replaceTenantConfig).toHaveBeenCalled();
  });
});
