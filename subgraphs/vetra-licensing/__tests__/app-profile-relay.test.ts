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

describe("vetraPublisher.updateAppProfile for an organisation app", () => {
  const ORG_APP = "9e1d2e3f-5d0e-4e3e-9a55-1c3b9b8f2a66";
  const PUBLISHER = "0x3333333333333333333333333333333333333333";
  const orgs = {
    membership: async (_o: string, a: string) =>
      a === PUBLISHER ? { role: "PUBLISHER" as const, effectiveScope: { all: true, appDids: [] } } : null,
  } as never;
  const input = { appId: ORG_APP, supportContact: "help@acme.example", securityContact: "" };

  beforeAll(async () => {
    await h.addApp(ORG_APP, OWNER);
    const row = h.rows.get(ORG_APP);
    if (row) h.rows.set(ORG_APP, { ...row, owner_org_id: "o1", identity_did: DID });
  });

  const build = (fake: ReturnType<typeof relay>, publisher: unknown) =>
    h.build({ renownProfile: fake, auth: { ...h.deps.auth, orgs }, appPublisher: { appPublisher: async () => publisher } as never });

  it("sends publisherOrgId on the first claim only, with the contacts passed through", async () => {
    const fake = relay();
    expect(await update(build(fake, null), input, withBearer(PUBLISHER))).toBe(true);
    expect(fake.upsert).toHaveBeenCalledWith(DID, "user-bearer", { ...input, publisherOrgId: "o1" });
  });

  it("omits publisherOrgId once Renown has a publisher for the app", async () => {
    const fake = relay();
    await update(build(fake, { orgId: "o2", address: null }), input, withBearer(PUBLISHER));
    expect(fake.upsert).toHaveBeenCalledWith(DID, "user-bearer", input);
  });

  it("refuses the creator who is no longer a publisher, without calling Renown", async () => {
    const fake = relay();
    expect(await codeOf(update(build(fake, null), input, withBearer(OWNER)))).toBe("NOT_FOUND");
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it("answers PROFILE_UNAVAILABLE when the first-claim check cannot reach Renown", async () => {
    const fake = relay();
    const r = h.build({
      renownProfile: fake,
      auth: { ...h.deps.auth, orgs },
      appPublisher: { appPublisher: async () => { throw new Error("down"); } } as never,
    });
    expect(await codeOf(update(r, input, withBearer(PUBLISHER)))).toBe("PROFILE_UNAVAILABLE");
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it("lists the org's apps for an operator, and none for a stranger", async () => {
    const withLister = {
      ...h.deps.auth,
      orgs,
      listAppsForOrg: async () => [h.rows.get(ORG_APP)!],
    };
    const q = (addr: string) => h.build({ auth: withLister }).VetraPublisherQueries.myApps!({}, { orgId: "o1" }, asUser(addr));
    expect(((await q(PUBLISHER)) as { id: string }[]).map((a) => a.id)).toStrictEqual([ORG_APP]);
    expect(await q(OTHER)).toStrictEqual([]);
  });
});

describe("vetraPublisher.updateAppProfile metrics", () => {
  it("passes the metric list to Renown with the owner's bearer", async () => {
    const fake = relay();
    const input = {
      appId: APP,
      metrics: [{ id: "m1", key: "notes", label: "Notes", unit: null, description: null, aggregation: "SUM", public: true }],
    };
    expect(await update(h.build({ renownProfile: fake }), input, withBearer(OWNER))).toBe(true);
    expect(fake.upsert).toHaveBeenCalledWith(DID, "user-bearer", input);
  });

  it("shows Renown's refusal of a metric list on the metrics field", async () => {
    const fake = relay(async () => {
      throw new RenownProfileError("INVALID_INPUT", 'Metric key "notes" is declared twice', "metrics");
    });
    const error = (await update(h.build({ renownProfile: fake }), { appId: APP, metrics: [] }, withBearer(OWNER)).catch(
      (e: unknown) => e,
    )) as GraphQLError;
    expect(error.extensions).toEqual({ code: "INVALID_INPUT", field: "metrics" });
  });
});
