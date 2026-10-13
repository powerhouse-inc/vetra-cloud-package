import { describe, expect, it } from "vitest";
import { authorizeDump } from "../dumps/auth.js";
import { createEnvAccess, OWNER_ONLY_ACCESS } from "../env-access.js";

const personal = (owner: string | null) => ({ owner, ownerOrgId: null, appId: null });

describe("authorizeDump", () => {
  it("throws UNAUTHENTICATED when caller is missing", async () => {
    await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller: null, env: personal("0xAbC") })).rejects.toThrow("UNAUTHENTICATED");
    await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller: undefined, env: personal("0xAbC") })).rejects.toThrow("UNAUTHENTICATED");
  });

  it("throws ENV_NOT_FOUND when the env is missing or has neither owner nor organisation", async () => {
    await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller: "0xabc", env: null })).rejects.toThrow("ENV_NOT_FOUND");
    await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller: "0xabc", env: undefined })).rejects.toThrow("ENV_NOT_FOUND");
    await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller: "0xabc", env: personal(null) })).rejects.toThrow("ENV_NOT_FOUND");
  });

  it("throws FORBIDDEN when caller is not the owner", async () => {
    await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller: "0xdef", env: personal("0xAbC") })).rejects.toThrow("FORBIDDEN");
  });

  it("passes when caller matches owner case-insensitively", async () => {
    for (const [caller, owner] of [["0xabc", "0xABC"], ["0xABC", "0xabc"], ["0xAbC", "0xAbC"]]) {
      await expect(authorizeDump(OWNER_ONLY_ACCESS, { caller, env: personal(owner) })).resolves.toBeUndefined();
    }
  });

  it("never lets an admin through (isAdmin is always false here)", async () => {
    let seenAdmin: boolean | null = null;
    const access = {
      ...OWNER_ONLY_ACCESS,
      canOperate: async (c: { isAdmin: boolean }) => {
        seenAdmin = c.isAdmin;
        return false;
      },
    };
    await expect(authorizeDump(access, { caller: "0xabc", env: personal("0xdef") })).rejects.toThrow("FORBIDDEN");
    expect(seenAdmin).toBe(false);
  });

  it("org env without an owner: covering publisher passes, others refused", async () => {
    const access = createEnvAccess({
      orgs: {
        membership: async (_org, address) =>
          address === "0xabc" ? { role: "PUBLISHER", effectiveScope: { all: true, appDids: [] } } : null,
      },
      appDidOf: async () => null,
    });
    const env = { owner: null, ownerOrgId: "o1", appId: null };
    await expect(authorizeDump(access, { caller: "0xABC", env })).resolves.toBeUndefined();
    await expect(authorizeDump(access, { caller: "0xdef", env })).rejects.toThrow("FORBIDDEN");
  });
});
