import { beforeAll, describe, expect, it } from "vitest";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import type { OpenBaoTransitClient } from "../../vetra-cloud-secrets/openbao-transit.js";
import { NOW, asUser, createPublisherHarness, type PublisherHarness } from "./publisher-harness.js";
import { createInviteCode } from "../invite-codes.js";
import { redeemInviteCode } from "../issuers/invite-code.js";
import { createGrantStore } from "../grants.js";
import { createHolderLicences } from "../licence-view.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { studioKeyForDid } from "../studio-access.js";
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
const make = () =>
  createStudioAccessDeps({
    client: h.client as never,
    licensingDb: h.db,
    trustedIds: async () => new Set([STUDIO_APP_ID]),
    transit: fakeTransit,
    slug: "vetra-studio",
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
      client: h.client as never, licensingDb: h.db, trustedIds: async () => new Set([STUDIO_APP_ID]), transit: null, slug: "vetra-studio",
    });
    expect(await studioKeyForDid(deps, DID)).toBeNull();
  });

  it("finds no studio app when its id is not trusted", async () => {
    const deps = createStudioAccessDeps({
      client: h.client as never, licensingDb: h.db, trustedIds: async () => new Set(), transit: fakeTransit, slug: "vetra-studio",
    });
    expect(await studioKeyForDid(deps, DID)).toBeNull();
  });

  it("loses the key when the licence is revoked", async () => {
    const gateway = createReactorLicenseGateway(h.client as never, { lifecycle: h.lifecycle });
    await gateway.execute(licenseId, [licenseActions.revokeLicense({ reason: null })]);
    expect(await studioKeyForDid(make(), DID)).toBeNull();
  });
});
