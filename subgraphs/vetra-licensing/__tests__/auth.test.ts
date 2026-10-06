import { describe, it, expect, vi } from "vitest";
import {
  resolveCallerApp,
  UnauthenticatedError,
  UnknownAppIdentityError,
  AppIdentityInactiveError,
} from "../auth.js";

const ctx = (address?: string) =>
  address ? { user: { address, networkId: "eip155", chainId: 1 } } : {};

const deps = (app: unknown) => ({
  findAppByIdentityDid: vi.fn(async () => app),
});

describe("resolveCallerApp", () => {
  it("resolves an active app from the caller DID", async () => {
    const d = deps({ id: "app-1", status: "ACTIVE" });
    await expect(
      resolveCallerApp(d as never, ctx("0xAbC") as never),
    ).resolves.toEqual({ appId: "app-1" });
    expect(d.findAppByIdentityDid).toHaveBeenCalledWith(
      "did:pkh:eip155:1:0xabc",
    );
  });

  it("prefers the app key (the App's did:key) carried by the delegation", async () => {
    const d = deps({ id: "app-1", status: "ACTIVE" });
    const c = {
      user: {
        address: "0xAbC",
        networkId: "eip155",
        chainId: 1,
        appKey: "did:key:z6Mk",
      },
    };
    await resolveCallerApp(d as never, c as never);
    expect(d.findAppByIdentityDid).toHaveBeenCalledWith("did:key:z6Mk");
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(
      resolveCallerApp(deps(null) as never, ctx() as never),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("rejects a DID that matches no app", async () => {
    await expect(
      resolveCallerApp(deps(null) as never, ctx("0xAbC") as never),
    ).rejects.toBeInstanceOf(UnknownAppIdentityError);
  });

  // Review Focus 5: an expired delegation must fail closed.
  it("rejects an app whose identity has lapsed", async () => {
    const d = deps({ id: "app-1", status: "PENDING_IDENTITY" });
    await expect(
      resolveCallerApp(d as never, ctx("0xAbC") as never),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });

  it("rejects a disconnected app", async () => {
    const d = deps({ id: "app-1", status: "DISCONNECTED" });
    await expect(
      resolveCallerApp(d as never, ctx("0xAbC") as never),
    ).rejects.toBeInstanceOf(AppIdentityInactiveError);
  });
});
