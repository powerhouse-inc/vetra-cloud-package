import { describe, expect, it, vi } from "vitest";
import { INVITE_KEY_TRANSIT_TENANT, KeyStorageUnavailableError, createKeyVault } from "../key-vault.js";

describe("key vault", () => {
  it("is unavailable without a transit client", () => {
    expect(createKeyVault(null)).toBeNull();
    expect(new KeyStorageUnavailableError().message).toMatch(/OPENBAO_ADDR/);
  });

  it("encrypts and decrypts under the access-codes tenant, so keys stored before the move still decrypt", async () => {
    // vetra-access-codes encrypted under the same pseudo-tenant.
    expect(INVITE_KEY_TRANSIT_TENANT).toBe("access-codes");
    const transit = {
      ensureTenantKey: vi.fn(async () => {}),
      encrypt: vi.fn(async (_t: string, p: string) => `vault:v1:${p}`),
      decrypt: vi.fn(async (_t: string, c: string) => c.replace("vault:v1:", "")),
    };
    const vault = createKeyVault(transit)!;
    expect(await vault.encrypt("sk-ant")).toBe("vault:v1:sk-ant");
    expect(await vault.decrypt("vault:v1:sk-ant")).toBe("sk-ant");
    expect(transit.ensureTenantKey).toHaveBeenCalledWith("access-codes");
    expect(transit.encrypt).toHaveBeenCalledWith("access-codes", "sk-ant");
    expect(transit.decrypt).toHaveBeenCalledWith("access-codes", "vault:v1:sk-ant");
  });
});
