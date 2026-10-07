import { describe, it, expect, vi } from "vitest";
import {
  resolveOwnerApp,
  NotAppOwnerError,
  UnknownAppError,
  type PublisherAuthDeps,
} from "../publisher-auth.js";
import { UnauthenticatedError, AppIdentityInactiveError } from "../auth.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const deps = (app: Partial<{ status: string; owner_address: string }> = {}) =>
  ({
    findAppById: vi.fn(async () => ({
      id: "app-1",
      name: "Knowledge Vault",
      status: "ACTIVE",
      owner_address: OWNER,
      ...app,
    })),
    listAppsForOwner: vi.fn(async () => []),
  }) satisfies PublisherAuthDeps;

const ctx = (address?: string) =>
  address ? { user: { address, networkId: "eip155", chainId: 1 } } : {};

describe("resolveOwnerApp", () => {
  it("authorises the owner", async () => {
    await expect(resolveOwnerApp(deps(), ctx(OWNER), "app-1")).resolves.toEqual({
      appId: "app-1",
    });
  });

  it("matches the owner case-insensitively", async () => {
    await expect(
      resolveOwnerApp(deps(), ctx(OWNER.toUpperCase()), "app-1"),
    ).resolves.toEqual({ appId: "app-1" });
  });

  it("refuses an unauthenticated caller", async () => {
    const d = deps();
    await expect(resolveOwnerApp(d, ctx(), "app-1")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    // Refused before any lookup: an anonymous caller learns nothing.
    expect(d.findAppById).not.toHaveBeenCalled();
  });

  it("reports an unknown app as unknown", async () => {
    const d = { ...deps(), findAppById: vi.fn(async () => null) };
    await expect(resolveOwnerApp(d, ctx(OWNER), "nope")).rejects.toBeInstanceOf(
      UnknownAppError,
    );
  });

  it("refuses a stranger", async () => {
    await expect(
      resolveOwnerApp(deps(), ctx(STRANGER), "app-1"),
    ).rejects.toBeInstanceOf(NotAppOwnerError);
  });

  it("refuses the owner when the app is not ACTIVE", async () => {
    await expect(
      resolveOwnerApp(deps({ status: "PENDING_IDENTITY" }), ctx(OWNER), "app-1"),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });

  it("authorises a platform admin who is not the owner", async () => {
    const adminCtx = {
      ...ctx(STRANGER),
      isAdmin: (a: string) => a.toLowerCase() === STRANGER,
    };
    await expect(
      resolveOwnerApp(deps(), adminCtx, "app-1"),
    ).resolves.toEqual({ appId: "app-1" });
  });
});
