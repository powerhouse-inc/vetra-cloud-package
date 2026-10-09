import type { GraphQLError } from "graphql";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RenownProfileError, type RenownProfileRelay } from "../renown-profile.js";
import { asUser, codeOf, createPublisherHarness, type PublisherHarness, type Resolvers } from "./publisher-harness.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0x2222222222222222222222222222222222222222";
const APP = "7c1d2e3f-5d0e-4e3e-9a55-1c3b9b8f2a44";
const BARE = "8d1d2e3f-5d0e-4e3e-9a55-1c3b9b8f2a55";
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

let h: PublisherHarness;

beforeAll(async () => {
  h = await createPublisherHarness();
  await h.addApp(APP, OWNER);
  await h.addApp(BARE, OWNER);
  const row = h.rows.get(APP);
  if (row) h.rows.set(APP, { ...row, identity_did: DID });
});

const withBearer = (address: string) => ({ ...asUser(address), headers: { authorization: "Bearer user-bearer" } });

function relay(upsert: RenownProfileRelay["upsert"] = async () => undefined) {
  return { upsert: vi.fn(upsert) };
}

const update = (r: Resolvers, input: Record<string, unknown>, ctx: unknown) =>
  r.VetraPublisherMutations.updateAppProfile!({}, { input }, ctx);

describe("vetraPublisher.updateAppProfile", () => {
  it("forwards the owner's bearer and the fields for the app's Renown identity", async () => {
    const fake = relay();
    const input = { appId: APP, name: "Vault", links: [{ id: "l1", label: "Docs", url: "https://docs.example" }] };
    expect(await update(h.build({ renownProfile: fake }), input, withBearer(OWNER))).toBe(true);
    expect(fake.upsert).toHaveBeenCalledWith(DID, "user-bearer", input);
  });

  it("lists each app's identity DID in myApps", async () => {
    const apps = (await h.build().VetraPublisherQueries.myApps!({}, {}, asUser(OWNER))) as {
      id: string;
      identityDid: string | null;
    }[];
    expect(apps.find((a) => a.id === APP)?.identityDid).toBe(DID);
    expect(apps.find((a) => a.id === BARE)?.identityDid).toBeNull();
  });

  it.each([
    ["another wallet", () => withBearer(OTHER), APP, "NOT_FOUND"],
    ["a call without a bearer header", () => asUser(OWNER), APP, "UNAUTHENTICATED"],
    ["an app without a Renown identity", () => withBearer(OWNER), BARE, "NO_IDENTITY"],
  ])("refuses %s without calling Renown", async (_, ctx, appId, code) => {
    const fake = relay();
    expect(await codeOf(update(h.build({ renownProfile: fake }), { appId, name: "x" }, ctx()))).toBe(code);
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it("answers PROFILE_UNAVAILABLE when the relay is not configured", async () => {
    expect(await codeOf(update(h.build({ renownProfile: null }), { appId: APP, name: "x" }, withBearer(OWNER)))).toBe(
      "PROFILE_UNAVAILABLE",
    );
  });

  it("passes Renown's refusal through with the field to fix", async () => {
    const fake = relay(async () => {
      throw new RenownProfileError("INVALID_INPUT", "Description must be at most 2000 characters", "description");
    });
    const error = (await update(h.build({ renownProfile: fake }), { appId: APP, description: "x" }, withBearer(OWNER)).catch(
      (e: unknown) => e,
    )) as GraphQLError;
    expect(error.extensions).toEqual({ code: "INVALID_INPUT", field: "description" });
    expect(error.message).toBe("Description must be at most 2000 characters");
  });
});
