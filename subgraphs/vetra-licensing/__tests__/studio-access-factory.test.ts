import { beforeAll, describe, expect, it, vi } from "vitest";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";
import { NOW, asUser, createPublisherHarness, type PublisherHarness } from "./publisher-harness.js";
import { createInviteCode } from "../invite-codes.js";
import { redeemInviteCode } from "../issuers/invite-code.js";
import { createGrantStore } from "../grants.js";
import { createHolderLicences } from "../licence-view.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { studioAccess, studioKeyForDid } from "../studio-access.js";
import { createSubscriptionResolvers, type SubscriptionDeps } from "../subscriptions-resolvers.js";
import { createStudioAccessDeps } from "../studio-access-factory.js";
import { STUDIO_APP_ID } from "../studio-app.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const fakeTransit = {
  ensureTenantKey: async () => {},
  encrypt: async (_t: string, p: string) => p,
  decrypt: async (_t: string, c: string) => (c === "enc" ? "sk-ant-plain" : c),
} as unknown as OpenBaoTransitClient;

let h: PublisherHarness;
let licenseId: string;
const SQUATTER = "app-squatter";
const make = (trusted: string[] = [STUDIO_APP_ID]) =>
  createStudioAccessDeps({
    client: h.client as never,
    licensingDb: h.db,
    trustedIds: async () => new Set(trusted),
    transit: fakeTransit,
  });

beforeAll(async () => {
  h = await createPublisherHarness();
  const pub = h.build();
  const pm = (field: string, args: object) => pub.VetraPublisherMutations[field]!({}, args, asUser(OWNER));
  await h.addApp(STUDIO_APP_ID, OWNER);
  await h.client.execute(STUDIO_APP_ID, "main", [appActions.setAppDetails({ name: "Vetra Studio", slug: "vetra-studio" })]);
  const templateId = (await pm("addTemplate", { input: { appId: STUDIO_APP_ID, name: "Studio", mode: "SHARED" } })) as string;
  const termId = (await pm("addTerm", {
    input: { appId: STUDIO_APP_ID, kind: "studio-early-access-30d", label: "Early access", templateId, validityDays: 30, issuers: ["INVITE_CODE"] },
  })) as string;
  await pm("publishTerm", { appId: STUDIO_APP_ID, termId });
  await createInviteCode(h.db, {
    appId: STUDIO_APP_ID, kind: "studio-early-access-30d", code: "studio-1", label: null, expiresAt: null, maxUses: null,
    anthropicKeyCiphertext: "enc", now: NOW,
  });
  const holderLicences = createHolderLicences({ licences: h.reads, lifecycle: h.lifecycle, grants: createGrantStore(h.db) });
  ({ licenseId } = await redeemInviteCode(
    { ...h.deps.issue, db: h.db, activeLicencesOf: async (a, d) => (await holderLicences(a, d)).filter((l) => l.status === "ACTIVE") },
    { code: "studio-1", user: DID, label: null, upgrades: null, now: NOW },
  ));
}, 120_000);

describe("createStudioAccessDeps", () => {
  it("resolves the key through the caller's studio licence, on any chain spelling", async () => {
    const deps = make();
    expect(await studioKeyForDid(deps, DID)).toBe("sk-ant-plain");
    expect(await studioKeyForDid(deps, `did:pkh:eip155:137:${ADDR}`)).toBe("sk-ant-plain");
    expect(await studioKeyForDid(deps, "did:pkh:eip155:1:0x9999999999999999999999999999999999999999")).toBeNull();
  });

  it("has no key without OpenBao", async () => {
    const deps = createStudioAccessDeps({
      client: h.client as never, licensingDb: h.db, trustedIds: async () => new Set([STUDIO_APP_ID]), transit: null,
    });
    expect(await studioKeyForDid(deps, DID)).toBeNull();
  });

  it("resolves the studio by its fixed id, not by slug: a trusted app carrying the studio slug changes nothing", async () => {
    // A row owner holds ADMIN on their own app document, so it can set any
    // slug; slug lookups would then find two trusted "vetra-studio" apps.
    await h.addApp(SQUATTER, OWNER);
    await h.client.execute(SQUATTER, "main", [appActions.setAppDetails({ name: "Not Studio", slug: "vetra-studio" })]);
    const deps = make([STUDIO_APP_ID, SQUATTER]);
    expect(await deps.studioAppId()).toBe(STUDIO_APP_ID);

    // studioAccess and the pool's key (studioKeyForDid is what the pool claim uses).
    expect(await studioAccess(deps, DID)).toMatchObject({ allowed: true, licenseId, hasAttachedKey: true });
    expect(await studioKeyForDid(deps, DID)).toBe("sk-ant-plain");

    // applyStudioKey, built on the same deps.
    const setSecret = vi.fn(async (_t: string, key: string, _v: string) => ({ key }));
    const r = createSubscriptionResolvers({
      studio: deps,
      secrets: { setSecret },
      tenantOwners: async () => [ADDR],
      tenantWait: { timeoutMs: 0, intervalMs: 1 },
      now: () => NOW,
    } as unknown as SubscriptionDeps) as { VetraSubscriptionsMutations: Record<string, (p: unknown, a: unknown, c: unknown) => Promise<unknown>> };
    await r.VetraSubscriptionsMutations.applyStudioKey!({}, { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY"] }, asUser(ADDR));
    expect(setSecret).toHaveBeenCalledWith("t-1", "ANTHROPIC_API_KEY", "sk-ant-plain");
  });

  it("finds no studio app while its document does not exist", async () => {
    const deps = createStudioAccessDeps({
      client: { get: async () => { throw Object.assign(new Error("gone"), { name: "DocumentNotFoundError" }); } } as never,
      licensingDb: h.db, trustedIds: async () => new Set([STUDIO_APP_ID]), transit: fakeTransit,
    });
    expect(await deps.studioAppId()).toBeNull();
  });

  it("loses the key when the licence is revoked", async () => {
    const gateway = createReactorLicenseGateway(h.client as never, { lifecycle: h.lifecycle });
    await gateway.execute(licenseId, [licenseActions.revokeLicense({ reason: null })]);
    expect(await studioKeyForDid(make(), DID)).toBeNull();
  });
});
