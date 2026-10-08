import { beforeAll, describe, expect, it } from "vitest";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import {
  NOW,
  asUser,
  codeOf,
  createPublisherHarness,
  type PublisherHarness,
  type Resolvers,
} from "./publisher-harness.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOLDER = "0x1111111111111111111111111111111111111111";
const HOLDER_DID = `did:pkh:eip155:1:${HOLDER}`;
const OTHER = "0x2222222222222222222222222222222222222222";
const OTHER_DID = `did:pkh:eip155:1:${OTHER}`;
const APP = "0b8a3c0e-5d0e-4e3e-9a55-1c3b9b8f2a22";
/** Written outside Vetra after its ledger was seeded: held as tampered. */
const HELD = "4c1d2e3f-5d0e-4e3e-9a55-1c3b9b8f2a33";
const asOwner = asUser(OWNER);

let h: PublisherHarness;
let r: Resolvers;
const q = (field: string, args: object) => r.VetraPublisherQueries[field]!({}, args, asOwner);
const m = (field: string, args: object) => r.VetraPublisherMutations[field]!({}, args, asOwner);

beforeAll(async () => {
  h = await createPublisherHarness();
  await h.addApp(APP, OWNER);
  await h.addApp(HELD, OWNER);
  r = h.build();
}, 120_000);

type TemplateOut = {
  id: string;
  name: string | null;
  mode: string;
  size: string | null;
  baseDomain: string | null;
  services: { id: string; type: string; artifactName: string | null; artifactChannel: string | null }[];
  packages: { id: string; packageName: string | null; version: string | null }[];
  templateHash: string;
  environmentCount: number;
};

describe("vetraPublisher end to end", () => {
  let templateId: string;
  let termId: string;
  let licenseId: string;
  let replacement: string;

  it("lists the caller's apps from the apps table", async () => {
    expect(await q("myApps", {})).toStrictEqual([
      { id: APP, name: `App ${APP.slice(0, 4)}`, status: "ACTIVE" },
      { id: HELD, name: `App ${HELD.slice(0, 4)}`, status: "ACTIVE" },
    ]);
    expect(await r.VetraPublisherQueries.myApps!({}, {}, asUser(OTHER))).toStrictEqual([]);
  });

  it("builds a template and a term through the ledger, seeding an unverified app", async () => {
    expect(await h.ledger.lookup(APP)).toBeNull();
    templateId = (await m("addTemplate", { input: { appId: APP, name: "Pro", mode: "DEDICATED" } })) as string;
    expect(await h.ledger.lookup(APP)).not.toBeNull();
    expect(await m("addTemplateService", { input: { appId: APP, templateId, type: "CONNECT" } })).toBe(true);
    expect(await m("setTemplateDetails", { input: { appId: APP, templateId, size: "VETRA_AGENT_S" } })).toBe(true);
    termId = (await m("addTerm", {
      input: { appId: APP, kind: "2026-pro", templateId, validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"] },
    })) as string;
    expect(await m("publishTerm", { appId: APP, termId })).toBe(true);

    const [t] = (await q("templates", { appId: APP })) as TemplateOut[];
    expect(t).toMatchObject({ id: templateId, name: "Pro", mode: "DEDICATED", size: "VETRA_AGENT_S", environmentCount: 0 });
    expect(t!.services).toMatchObject([{ type: "CONNECT", artifactName: null, artifactChannel: null }]);
    expect(t!.templateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await q("terms", { appId: APP })).toStrictEqual([
      { id: termId, kind: "2026-pro", label: null, templateId, validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"], status: "ACTIVE", activeLicenses: 0 },
    ]);
    // Every write was recorded: the app reads verified and untampered.
    expect(await h.apps.app(APP)).toMatchObject({ tampered: false, unverified: false });
  });

  it("adds and removes template services and packages", async () => {
    await m("addTemplatePackage", { input: { appId: APP, templateId, packageName: "@acme/kv", version: "1.2.3" } });
    await m("addTemplateService", { input: { appId: APP, templateId, type: "FUSION", artifactName: "kv-image", artifactChannel: "STAGING" } });
    let [t] = (await q("templates", { appId: APP })) as TemplateOut[];
    expect(t!.packages).toMatchObject([{ packageName: "@acme/kv", version: "1.2.3" }]);
    const fusion = t!.services.find((s) => s.type === "FUSION")!;
    expect(fusion).toMatchObject({ artifactName: "kv-image", artifactChannel: "STAGING" });
    expect(await m("removeTemplatePackage", { input: { appId: APP, templateId, id: t!.packages[0]!.id } })).toBe(true);
    expect(await m("removeTemplateService", { input: { appId: APP, templateId, id: fusion.id } })).toBe(true);
    [t] = (await q("templates", { appId: APP })) as TemplateOut[];
    expect(t!.packages).toStrictEqual([]);
    expect(t!.services.map((s) => s.type)).toStrictEqual(["CONNECT"]);
  });

  it("an omitted template field is left alone; an explicit null clears it", async () => {
    await m("setTemplateDetails", { input: { appId: APP, templateId, baseDomain: "vetra.io" } });
    let [t] = (await q("templates", { appId: APP })) as TemplateOut[];
    expect(t).toMatchObject({ size: "VETRA_AGENT_S", baseDomain: "vetra.io", name: "Pro", mode: "DEDICATED" });
    await m("setTemplateDetails", { input: { appId: APP, templateId, size: null } });
    [t] = (await q("templates", { appId: APP })) as TemplateOut[];
    expect(t).toMatchObject({ size: null, baseDomain: "vetra.io" });
  });

  it("a SHARED template may only point at one of the app's own environments", async () => {
    h.ownedEnvironments.set(APP, ["env-prod", "env-preview-7"]);
    h.ownedEnvironments.set(HELD, ["env-of-another-app"]);
    const shared = (await m("addTemplate", { input: { appId: APP, mode: "SHARED" } })) as string;
    const env = async () =>
      ((await q("templates", { appId: APP })) as { id: string; sharedEnvironment: string | null }[])
        .find((t) => t.id === shared)!.sharedEnvironment;
    expect(await m("setTemplateDetails", { input: { appId: APP, templateId: shared, sharedEnvironment: "env-preview-7" } })).toBe(true);
    expect(await env()).toBe("env-preview-7");
    expect(await codeOf(m("setTemplateDetails", { input: { appId: APP, templateId: shared, sharedEnvironment: "env-of-another-app" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("setTemplateDetails", { input: { appId: APP, templateId: shared, sharedEnvironment: "made-up" } }))).toBe("INVALID_INPUT");
    expect(await env()).toBe("env-preview-7");
    expect(await m("setTemplateDetails", { input: { appId: APP, templateId: shared, sharedEnvironment: null } })).toBe(true);
    expect(await env()).toBeNull();
    // Unrelated edits never re-check (or need) an environment.
    expect(await m("setTemplateDetails", { input: { appId: APP, templateId: shared, name: "Shared" } })).toBe(true);
    await m("deleteTemplate", { appId: APP, templateId: shared });
  });

  it("edits a term: omitted fields unchanged, an explicit null clears", async () => {
    await m("setTermDetails", { input: { appId: APP, termId, label: "Pro plan" } });
    await m("setTermDetails", { input: { appId: APP, termId, validityDays: null } });
    const [t] = (await q("terms", { appId: APP })) as Record<string, unknown>[];
    expect(t).toMatchObject({ label: "Pro plan", validityDays: null, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"], templateId });
    await m("setTermDetails", { input: { appId: APP, termId, validityDays: 30, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"] } });
  });

  it("surfaces reducer refusals and malformed values as INVALID_INPUT", async () => {
    expect(await codeOf(m("deleteTemplate", { appId: APP, templateId }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("setTermDetails", { input: { appId: APP, termId, kind: "renamed" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("addTemplate", { input: { appId: APP, mode: "SOMETIMES" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("setTemplateDetails", { input: { appId: APP, templateId, mode: "SOMETIMES" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("addTerm", { input: { appId: APP, kind: "x", issuers: ["SOMEONE"] } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("setTermDetails", { input: { appId: APP, termId, issuers: ["SOMEONE"] } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("addTemplateService", { input: { appId: APP, templateId, type: "MAINFRAME" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("addTemplateService", { input: { appId: APP, templateId, type: "FUSION", artifactName: "x", artifactChannel: "NIGHTLY" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("setTemplateDetails", { input: { appId: APP, templateId, packageRegistry: "not a url" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("addTerm", { input: { appId: APP, kind: " padded " } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("removeTemplateService", { input: { appId: APP, templateId, id: "no-such-service" } }))).toBe("INVALID_INPUT");
    // A refused write leaves the app verified.
    expect(await h.apps.app(APP)).toMatchObject({ tampered: false, unverified: false });
  });

  it("an unknown template, term or app is NOT_FOUND", async () => {
    expect(await codeOf(m("setTemplateDetails", { input: { appId: APP, templateId: "nope", name: "x" } }))).toBe("NOT_FOUND");
    expect(await codeOf(m("deleteTemplate", { appId: APP, templateId: "nope" }))).toBe("NOT_FOUND");
    expect(await codeOf(m("publishTerm", { appId: APP, termId: "nope" }))).toBe("NOT_FOUND");
    expect(await codeOf(m("setTermDetails", { input: { appId: APP, termId: "nope", label: "x" } }))).toBe("NOT_FOUND");
    expect(await codeOf(q("templates", { appId: "no-such-app" }))).toBe("NOT_FOUND");
  });

  it("deletes an unused template and retires a term", async () => {
    const spare = (await m("addTemplate", { input: { appId: APP, mode: "SHARED" } })) as string;
    expect(await m("deleteTemplate", { appId: APP, templateId: spare })).toBe(true);
    const old = (await m("addTerm", { input: { appId: APP, kind: "2025-legacy", templateId, issuers: ["PUBLISHER_GRANT"] } })) as string;
    await m("publishTerm", { appId: APP, termId: old });
    expect(await m("retireTerm", { appId: APP, termId: old })).toBe(true);
    const terms = (await q("terms", { appId: APP })) as { id: string; status: string }[];
    expect(terms.find((t) => t.id === old)?.status).toBe("RETIRED");
    expect(((await q("templates", { appId: APP })) as TemplateOut[]).map((t) => t.id)).toStrictEqual([templateId]);
  });

  it("grants only to the allow list, then lists licences", async () => {
    expect(await codeOf(m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER } }))).toBe("NOT_ON_ALLOW_LIST");
    expect(await m("addToAllowList", { appId: APP, user: `did:pkh:eip155:137:${HOLDER.toUpperCase().replace("0X", "0x")}` })).toBe(true);
    expect(await q("allowList", { appId: APP })).toStrictEqual([{ user: HOLDER_DID, addedAt: NOW }]);
    licenseId = (await m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER, label: "Vault" } })) as string;
    const [l] = (await q("licenses", { appId: APP })) as Record<string, unknown>[];
    expect(l).toStrictEqual({
      id: licenseId, user: HOLDER_DID, kind: "2026-pro", issuer: "PUBLISHER_GRANT", status: "ACTIVE",
      start: NOW, end: "2026-11-07T00:00:00.000Z", environmentId: null, replacedBy: null,
    });
    expect(((await q("terms", { appId: APP })) as { kind: string; activeLicenses: number }[])
      .find((t) => t.kind === "2026-pro")!.activeLicenses).toBe(1);
    expect(await q("licenses", { appId: APP, status: "REVOKED" })).toStrictEqual([]);
  });

  it("refuses a kind that is not issuable and a non-pkh user", async () => {
    expect(await codeOf(m("issueGrant", { input: { appId: APP, kind: "nope", user: HOLDER } }))).toBe("TERM_NOT_ISSUABLE");
    expect(await codeOf(m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: "did:key:z6Mk" } }))).toBe("UNSUPPORTED_DID");
    expect(await codeOf(m("addToAllowList", { appId: APP, user: "did:key:z6Mk" }))).toBe("UNSUPPORTED_DID");
    expect(await codeOf(m("removeFromAllowList", { appId: APP, user: "did:key:z6Mk" }))).toBe("UNSUPPORTED_DID");
  });

  it("lists a chain's environment, and counts it on its template", async () => {
    await h.db.insertInto("license_environments").values({
      environment_id: "env-1", root_license_id: licenseId, app_id: APP, user_did: HOLDER_DID,
      license_id: licenseId, template_id: templateId, label: "Vault", template_hash: "h1",
      ended_at: null, stopped_at: null, delete_after: null, created_at: NOW, updated_at: NOW,
    }).execute();
    expect(await q("environments", { appId: APP })).toStrictEqual([{
      environmentId: "env-1", user: HOLDER_DID, licenseId, rootLicenseId: licenseId,
      label: "Vault", templateHash: "h1", stoppedAt: null, deleteAfter: null,
    }]);
    expect(((await q("templates", { appId: APP })) as TemplateOut[])[0]!.environmentCount).toBe(1);
  });

  it("replaces a grant in place and revokes", async () => {
    const termB = (await m("addTerm", { input: { appId: APP, kind: "2026-max", templateId, issuers: ["PUBLISHER_GRANT"] } })) as string;
    await m("publishTerm", { appId: APP, termId: termB });
    expect(await codeOf(m("replaceGrant", { input: { licenseId, kind: "2026-pro" } }))).toBe("ALREADY_HOLDS");
    replacement = (await m("replaceGrant", { input: { licenseId, kind: "2026-max" } })) as string;
    const list = (await q("licenses", { appId: APP })) as { id: string; status: string; replacedBy: string | null }[];
    expect(list.find((x) => x.id === licenseId)).toMatchObject({ status: "REPLACED", replacedBy: replacement });
    expect(list.find((x) => x.id === replacement)).toMatchObject({ status: "ACTIVE", kind: "2026-max" });
    // Only the newest licence of a chain can be upgraded.
    expect(await codeOf(m("replaceGrant", { input: { licenseId, kind: "2026-pro" } }))).toBe("INVALID_INPUT");
    expect(await m("revokeLicense", { input: { licenseId: replacement, reason: "test" } })).toBe(true);
    expect(await codeOf(m("revokeLicense", { input: { licenseId: replacement } }))).toBe("INVALID_INPUT");
    // Revoked through the recording gateway: the lifecycle record says so.
    expect((await h.deps.lifecycle.forIds([replacement])).get(replacement)?.status).toBe("REVOKED");
    expect(await codeOf(m("revokeLicense", { input: { licenseId: "no-such-licence" } }))).toBe("NOT_FOUND");
    expect(await codeOf(m("replaceGrant", { input: { licenseId: "no-such-licence", kind: "2026-max" } }))).toBe("NOT_FOUND");
  });

  it("replace takes the holder from the grant row: a forged predecessor holder is refused", async () => {
    const ATTACKER = "did:pkh:eip155:1:0x9999999999999999999999999999999999999999";
    await m("addToAllowList", { appId: APP, user: HOLDER });
    const victim = (await m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER } })) as string;
    // The licence document reads as the attacker's (forged).
    const forging = h.build({
      issue: {
        ...h.deps.issue,
        licence: async (id) => {
          const real = await h.reads.licenceRecord(id);
          return real && id === victim ? { ...real, user: ATTACKER } : real;
        },
      },
    });
    const replace = forging.VetraPublisherMutations.replaceGrant!({}, { input: { licenseId: victim, kind: "2026-max" } }, asOwner);
    expect(await codeOf(replace)).toBe("NOT_FOUND");
    const holders = await h.db.selectFrom("app_license_grants").select("user_did").execute();
    expect(holders.map((g) => g.user_did)).not.toContain(ATTACKER);
    // Unforged, the same replace goes to the grant row's holder.
    const next = (await m("replaceGrant", { input: { licenseId: victim, kind: "2026-max" } })) as string;
    expect((await h.deps.grants.grantFor(next))?.userDid).toBe(HOLDER_DID);
    await m("revokeLicense", { input: { licenseId: next } });
  });

  it("replace trusts the recorded status: a document forged to EXPIRED is still closed", async () => {
    const victim = (await m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER } })) as string;
    // Forged on the document only; license_lifecycle still says ACTIVE.
    await h.client.execute(victim, "main", [licenseActions.expireLicense({})]);
    const next = (await m("replaceGrant", { input: { licenseId: victim, kind: "2026-max" } })) as string;
    const lifecycle = await h.deps.lifecycle.forIds([victim, next]);
    expect(lifecycle.get(victim)).toStrictEqual({ status: "REPLACED", replacedBy: next });
    expect(lifecycle.get(next)?.status).toBe("ACTIVE");
    const chain = await h.db.selectFrom("license_chain").select("license_id").where("root_license_id", "=", victim).execute();
    const active = [...(await h.deps.lifecycle.forIds(chain.map((c) => c.license_id))).values()].filter((r) => r.status === "ACTIVE");
    expect(active).toHaveLength(1);
    await m("revokeLicense", { input: { licenseId: next } });
  });

  it("a revoke overlapping a replace waits for it, then fails cleanly on the REPLACED licence", async () => {
    const lic = (await m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: HOLDER } })) as string;
    let entered!: () => void;
    const inside = new Promise<void>((res) => (entered = res));
    const slow = h.build({
      issue: {
        ...h.deps.issue,
        createLicenseDocument: async () => {
          entered();
          await new Promise((res) => setTimeout(res, 50));
          return h.deps.issue.createLicenseDocument();
        },
      },
    });
    const replace = slow.VetraPublisherMutations.replaceGrant!({}, { input: { licenseId: lic, kind: "2026-max" } }, asOwner);
    await inside;
    const revoke = m("revokeLicense", { input: { licenseId: lic, reason: "overlap" } });
    const next = (await replace) as string;
    expect(await codeOf(revoke)).toBe("INVALID_INPUT");
    const lifecycle = await h.deps.lifecycle.forIds([lic, next]);
    expect(lifecycle.get(lic)).toStrictEqual({ status: "REPLACED", replacedBy: next });
    expect(lifecycle.get(next)?.status).toBe("ACTIVE");
    await m("revokeLicense", { input: { licenseId: next } });
  });

  it("lists licences by their grant rows and lifecycle records, not by what documents claim", async () => {
    // A licence document claiming the app, with no grant row: not the app's.
    const forged = await h.licenseGateway.create();
    await h.client.execute(forged, "main", [
      licenseActions.issueLicense({
        app: APP, user: OTHER_DID, issuer: "PUBLISHER_GRANT", kind: "2026-pro", stage: null,
        details: null, issued: NOW, start: NOW, end: null,
      }),
      licenseActions.activateLicense({}),
    ]);
    await m("addToAllowList", { appId: APP, user: OTHER });
    const granted = (await m("issueGrant", { input: { appId: APP, kind: "2026-pro", user: OTHER } })) as string;
    // Revoked on the document outside the system: the recorded lifecycle stays ACTIVE.
    await h.client.execute(granted, "main", [licenseActions.revokeLicense({ reason: "forged" })]);
    const list = (await q("licenses", { appId: APP })) as { id: string; status: string }[];
    expect(list.map((l) => l.id)).not.toContain(forged);
    expect(list.find((l) => l.id === granted)?.status).toBe("ACTIVE");
    expect(await codeOf(m("revokeLicense", { input: { licenseId: forged } }))).toBe("NOT_FOUND");
  });

  it("creates invite codes for a term that allows them, never returning the key", async () => {
    const c = (await m("createInviteCode", { input: { appId: APP, kind: "2026-pro", maxUses: 5, anthropicKey: "sk-ant-x" } })) as Record<string, unknown>;
    expect(c).toMatchObject({ kind: "2026-pro", active: true, maxUses: 5, redemptions: 0, hasAnthropicKey: true, createdAt: NOW, label: null, expiresAt: null });
    expect(c.code).toMatch(/^vetra-[a-z]+-[a-z]+-[a-z0-9]{10}$/);
    expect(JSON.stringify(c)).not.toContain("sk-ant");
    expect((await h.db.selectFrom("invite_codes").select("anthropic_key_ciphertext").where("code", "=", c.code as string).executeTakeFirstOrThrow()).anthropic_key_ciphertext).toBe("enc:sk-ant-x");
    const custom = (await m("createInviteCode", { input: { appId: APP, kind: "2026-pro", code: "Launch-2026", label: "Launch", expiresAt: "2027-01-01T00:00:00Z" } })) as Record<string, unknown>;
    expect(custom).toMatchObject({ code: "Launch-2026", label: "Launch", expiresAt: "2027-01-01T00:00:00.000Z", hasAnthropicKey: false });
    expect(await codeOf(m("createInviteCode", { input: { appId: APP, kind: "2026-pro", code: "Launch-2026" } }))).toBe("INVALID_INPUT");
    expect(await codeOf(m("createInviteCode", { input: { appId: APP, kind: "2026-pro", code: "short" } }))).toBe("INVALID_INPUT");
    // 2026-max does not list INVITE_CODE; a missing kind is the same refusal.
    expect(await codeOf(m("createInviteCode", { input: { appId: APP, kind: "2026-max" } }))).toBe("TERM_NOT_ISSUABLE");
    expect(await codeOf(m("createInviteCode", { input: { appId: APP, kind: "nope" } }))).toBe("TERM_NOT_ISSUABLE");
    expect(await codeOf(m("createInviteCode", { input: { appId: APP, kind: "2025-legacy" } }))).toBe("TERM_NOT_ISSUABLE");

    expect(await m("setInviteCodeActive", { appId: APP, code: c.code, active: false })).toBe(true);
    expect(await codeOf(m("setInviteCodeActive", { appId: APP, code: "no-such-code", active: false }))).toBe("NOT_FOUND");
    const listed = (await q("inviteCodes", { appId: APP })) as { code: string; active: boolean }[];
    expect(listed.find((x) => x.code === c.code)?.active).toBe(false);
    expect(listed.find((x) => x.code === "Launch-2026")?.active).toBe(true);
  });

  it("an attached key without key storage is refused before anything is stored", async () => {
    const noVault = h.build({ keyVault: null });
    const call = noVault.VetraPublisherMutations.createInviteCode!({}, { input: { appId: APP, kind: "2026-pro", code: "NoVault-01", anthropicKey: "sk-ant-y" } }, asOwner);
    expect(await codeOf(call)).toBe("INVALID_INPUT");
    expect(await h.db.selectFrom("invite_codes").select("code").where("code", "=", "NoVault-01").executeTakeFirst()).toBeUndefined();
    expect(await codeOf(noVault.VetraPublisherMutations.createInviteCode!({}, { input: { appId: APP, kind: "2026-pro", code: "NoVault-02" } }, asOwner))).toBe("OK");
  });

  it("lists the app's artifacts", async () => {
    expect(await q("appArtifacts", { appId: APP })).toStrictEqual([]);
  });

  it("removes from the allow list", async () => {
    expect(await m("removeFromAllowList", { appId: APP, user: HOLDER })).toBe(true);
    expect(await m("removeFromAllowList", { appId: APP, user: HOLDER_DID })).toBe(false);
    expect(await q("allowList", { appId: APP })).toStrictEqual([{ user: OTHER_DID, addedAt: NOW }]);
  });

  it("serves every read when licensing is disabled, and refuses every write", async () => {
    h.cfg.enabled = false;
    try {
      for (const f of ["templates", "terms", "appArtifacts", "licenses", "environments", "inviteCodes", "allowList"]) {
        expect(await codeOf(q(f, { appId: APP })), f).toBe("OK");
      }
      expect(await codeOf(m("addTemplate", { input: { appId: APP, mode: "SHARED" } }))).toBe("LICENSING_DISABLED");
      expect(await codeOf(m("addToAllowList", { appId: APP, user: HOLDER }))).toBe("LICENSING_DISABLED");
      expect(await codeOf(m("revokeLicense", { input: { licenseId } }))).toBe("LICENSING_DISABLED");
    } finally {
      h.cfg.enabled = true;
    }
  });
});

describe("a tampered app", () => {
  it("refuses template, term and code writes with FORBIDDEN, and still serves reads", async () => {
    const templateId = (await m("addTemplate", { input: { appId: HELD, mode: "DEDICATED" } })) as string;
    await m("addTerm", { input: { appId: HELD, kind: "basic", templateId, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"] } });
    // A write that did not go through the ledger.
    await h.client.execute(HELD, "main", [appActions.setTemplateDetails({ id: templateId, name: "forged" })]);
    expect((await h.apps.app(HELD))?.tampered).toBe(true);
    const termId = ((await q("terms", { appId: HELD })) as { id: string }[])[0]!.id;
    const writes: [string, object][] = [
      ["addTemplate", { input: { appId: HELD, mode: "SHARED" } }],
      ["setTemplateDetails", { input: { appId: HELD, templateId, name: "x" } }],
      ["addTemplateService", { input: { appId: HELD, templateId, type: "CONNECT" } }],
      ["addTemplatePackage", { input: { appId: HELD, templateId, packageName: "p" } }],
      ["removeTemplateService", { input: { appId: HELD, templateId, id: "s" } }],
      ["removeTemplatePackage", { input: { appId: HELD, templateId, id: "p" } }],
      ["deleteTemplate", { appId: HELD, templateId }],
      ["addTerm", { input: { appId: HELD, kind: "more" } }],
      ["setTermDetails", { input: { appId: HELD, termId, label: "x" } }],
      ["publishTerm", { appId: HELD, termId }],
      ["retireTerm", { appId: HELD, termId }],
      ["createInviteCode", { input: { appId: HELD, kind: "basic" } }],
    ];
    const before = await h.revisionOf(HELD);
    for (const [field, args] of writes) {
      const err = await m(field, args).catch((e: unknown) => e as Error);
      expect((err as { extensions?: { code?: string } }).extensions?.code, field).toBe("FORBIDDEN");
      expect((err as Error).message, field).toContain("changed outside Vetra");
    }
    expect(await h.revisionOf(HELD)).toBe(before);
    expect(await h.db.selectFrom("invite_codes").select("code").where("app_id", "=", HELD).execute()).toStrictEqual([]);
    expect(((await q("templates", { appId: HELD })) as { name: string | null }[])[0]!.name).toBe("forged");
  });
});
