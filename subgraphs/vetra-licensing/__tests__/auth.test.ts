import { describe, it, expect, vi } from "vitest";
import {
  resolveCallerApp,
  UnauthenticatedError,
  UnknownAppIdentityError,
  AppIdentityInactiveError,
} from "../auth.js";

const DID = "did:key:z6MkApp";

const ctx = (appKey?: string) => ({
  user: { address: "0xAbC", networkId: "eip155", chainId: 1, appKey },
});

const deps = (app: unknown) => ({
  findAppByIdentityDid: vi.fn(async () => app),
});

describe("resolveCallerApp", () => {
  it("resolves an active app from the caller's did:key", async () => {
    const d = deps({ id: "app-1", status: "ACTIVE" });
    await expect(
      resolveCallerApp(d as never, ctx(DID) as never),
    ).resolves.toEqual({ appId: "app-1" });
    expect(d.findAppByIdentityDid).toHaveBeenCalledWith(DID);
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(
      resolveCallerApp(deps(null) as never, {} as never),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects a wallet caller with no appKey, without any lookup", async () => {
    const d = deps({ id: "app-1", status: "ACTIVE" });
    await expect(
      resolveCallerApp(d as never, ctx() as never),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(d.findAppByIdentityDid).not.toHaveBeenCalled();
  });

  it("rejects a DID that matches no app", async () => {
    await expect(
      resolveCallerApp(deps(null) as never, ctx(DID) as never),
    ).rejects.toBeInstanceOf(UnknownAppIdentityError);
  });

  it("rejects an app whose identity has lapsed", async () => {
    const d = deps({ id: "app-1", status: "PENDING_IDENTITY" });
    await expect(
      resolveCallerApp(d as never, ctx(DID) as never),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });

  it("rejects a disconnected app", async () => {
    const d = deps({ id: "app-1", status: "DISCONNECTED" });
    await expect(
      resolveCallerApp(d as never, ctx(DID) as never),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });
});
