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

const deps = (
  app: Partial<{
    status: string;
    owner_address: string;
    owner_org_id: string | null;
    org_disputed: boolean | null;
  }> = {},
) =>
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
    const isAdmin = vi.fn(() => false);
    await expect(
      resolveOwnerApp(deps(), { ...ctx(STRANGER), isAdmin }, "app-1"),
    ).rejects.toBeInstanceOf(NotAppOwnerError);
  });

  it("refuses the owner when the app is not ACTIVE", async () => {
    await expect(
      resolveOwnerApp(deps({ status: "PENDING_IDENTITY" }), ctx(OWNER), "app-1"),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });

  it("refuses a stranger against an inactive app before checking status", async () => {
    const isAdmin = vi.fn(() => false);
    await expect(
      resolveOwnerApp(
        deps({ status: "PENDING_IDENTITY" }),
        { ...ctx(STRANGER), isAdmin },
        "app-1",
      ),
    ).rejects.toBeInstanceOf(NotAppOwnerError);
  });

  it("uses identical messages for unknown and not-owner errors", async () => {
    const d = { ...deps(), findAppById: vi.fn(async () => null) };
    let unknownMessage: string;
    try {
      await resolveOwnerApp(d, ctx(OWNER), "app-1");
    } catch (e) {
      unknownMessage = (e as Error).message;
    }

    const isAdmin = vi.fn(() => false);
    let notOwnerMessage: string;
    try {
      await resolveOwnerApp(deps(), { ...ctx(STRANGER), isAdmin }, "app-1");
    } catch (e) {
      notOwnerMessage = (e as Error).message;
    }

    expect(unknownMessage!).toBe(notOwnerMessage!);
  });

  it("matches the owner case-insensitively with uppercase owner_address", async () => {
    const isAdmin = vi.fn(() => false);
    await expect(
      resolveOwnerApp(
        deps({ owner_address: OWNER.toUpperCase() }),
        { ...ctx(OWNER.toLowerCase()), isAdmin },
        "app-1",
      ),
    ).resolves.toEqual({ appId: "app-1" });
  });

  it("does not call isAdmin when the caller is the owner", async () => {
    const isAdmin = vi.fn(() => false);
    await resolveOwnerApp(deps(), { ...ctx(OWNER), isAdmin }, "app-1");
    expect(isAdmin).not.toHaveBeenCalled();
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

describe("resolveOwnerApp for organisation apps", () => {
  const orgApp = (membership: unknown) => ({
    ...deps({ owner_address: OWNER }),
    findAppById: vi.fn(async () => ({
      id: "app-1", name: "Vault", status: "ACTIVE", owner_address: OWNER,
      owner_org_id: "o1", identity_did: "did:key:vault",
    })),
    orgs: { membership: vi.fn(async () => membership as never) },
  });

  it("authorises a publisher of the org and refuses the creator who left", async () => {
    const publisher = { role: "PUBLISHER", effectiveScope: { all: false, appDids: ["did:key:vault"] } };
    await expect(resolveOwnerApp(orgApp(publisher), ctx(STRANGER), "app-1")).resolves.toEqual({ appId: "app-1" });
    await expect(resolveOwnerApp(orgApp(null), ctx(OWNER), "app-1")).rejects.toBeInstanceOf(NotAppOwnerError);
  });

  it("fails closed with the same opaque refusal when Renown is down", async () => {
    const down = orgApp(null);
    down.orgs.membership.mockRejectedValue(new Error("down"));
    await expect(resolveOwnerApp(down, ctx(STRANGER), "app-1")).rejects.toThrow("no such app");
  });
});

describe("resolveOwnerApp: org apps whose Renown publisher disagrees", () => {
  const orgs = {
    membership: vi.fn(async () => ({ role: "OWNER" as const, effectiveScope: { all: true, appDids: [] } })),
  };
  it("lets an org owner issue, but not while the app is disputed", async () => {
    const ok = { ...deps({ owner_org_id: "org-1" }), orgs };
    await expect(resolveOwnerApp(ok, ctx(STRANGER), "app-1")).resolves.toEqual({ appId: "app-1" });
    const disputed = { ...deps({ owner_org_id: "org-1", org_disputed: true }), orgs };
    await expect(resolveOwnerApp(disputed, ctx(STRANGER), "app-1")).rejects.toBeInstanceOf(NotAppOwnerError);
  });
});
