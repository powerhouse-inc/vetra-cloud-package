import { beforeAll, describe, expect, it, vi } from "vitest";
import { actions as appActions } from "document-models/vetra-app";
import { actions as licenseActions } from "document-models/app-owner-license";
import type { VetraCloudEnvironmentState } from "document-models/vetra-cloud-environment";
import { NOW, asUser, codeOf, createPublisherHarness, type PublisherHarness, type Resolvers } from "./publisher-harness.js";
import { createGrantStore } from "../grants.js";
import { createChainEnvironmentRows } from "../environments.js";
import { createInviteCode, keyCiphertextForCode, redeemedCodeOf, setInviteCodeActive } from "../invite-codes.js";
import { authorisedLicences, createHolderLicences } from "../licence-view.js";
import { createLifecycleStore } from "../lifecycle.js";
import { createReactorLicenseGateway } from "../license-gateway.js";
import { createSubscriptionResolvers, type SubscriptionDeps } from "../subscriptions-resolvers.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HOLDER = "0x1111111111111111111111111111111111111111";
const HOLDER_DID = `did:pkh:eip155:1:${HOLDER}`;
const OTHER = "0x2222222222222222222222222222222222222222";
const APP_DED = "0b8a3c0e-5d0e-4e3e-9a55-1c3b9b8f2a01";
const APP_SH = "0b8a3c0e-5d0e-4e3e-9a55-1c3b9b8f2a02";
const APP_STUDIO = "0b8a3c0e-5d0e-4e3e-9a55-1c3b9b8f2a03";
const DAY = 24 * 60 * 60 * 1000;
const plus = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();

const env = (subdomain: string): VetraCloudEnvironmentState =>
  ({
    genericSubdomain: subdomain,
    genericBaseDomain: "vetra.io",
    customDomain: null,
    apexService: null,
    services: [{ type: "FUSION", enabled: true, prefix: "app" }],
  }) as unknown as VetraCloudEnvironmentState;
const ENV_STATES: Record<string, VetraCloudEnvironmentState> = { "env-app": env("pfnuer"), "env-ded": env("thesis") };

// The callers, as the gateway builds them from a Renown bearer (any chain).
const asHolder = { user: { address: HOLDER, networkId: "eip155", chainId: 137 } };
const asOther = { user: { address: OTHER, networkId: "eip155", chainId: 1 } };
const anon = {};

type Sub = Record<string, unknown> & { licenseId: string; kind: string; status: string; start: string | null; end: string | null };
type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;

let h: PublisherHarness;
let pub: Resolvers;
let sub: { VetraSubscriptionsQueries: Record<string, Field>; VetraSubscriptionsMutations: Record<string, Field> };
/**
 * The test clock only ever moves forward, as real time does: chain heads are
 * ordered by issue time. Every redeem moves it on by a second.
 */
let clock = NOW;
const travel = (to: string) => {
  if (to < clock) throw new Error(`the test clock cannot go back from ${clock} to ${to}`);
  clock = to;
};
const tick = () => travel(new Date(Date.parse(clock) + 1000).toISOString());
const setSecret = vi.fn(async (_t: string, key: string, _v: string) => ({ key }));
/** Everything the code under test logs, to prove the key never is. */
const logger = {
  info: vi.spyOn(console, "info"),
  warn: vi.spyOn(console, "warn"),
  error: vi.spyOn(console, "error"),
  log: vi.spyOn(console, "log"),
};
/** tenantId -> owners of the environments deployed under it (the processor's projection). */
const tenants = new Map<string, (string | null)[]>();
let deps: SubscriptionDeps;
let grants: ReturnType<typeof createGrantStore>;
let lifecycle: ReturnType<typeof createLifecycleStore>;
let gateway: ReturnType<typeof createReactorLicenseGateway>;

const q = (field: string, args: object, ctx: object) => sub.VetraSubscriptionsQueries[field]!({}, args, ctx);
const m = (field: string, args: object, ctx: object) => sub.VetraSubscriptionsMutations[field]!({}, args, ctx);
const redeem = async (input: object, ctx: object = asHolder) => {
  try {
    return (await m("redeemInviteCode", { input }, ctx)) as Sub;
  } finally {
    tick();
  }
};
const mine = (ctx: object = asHolder) => q("mySubscriptions", {}, ctx) as Promise<Sub[]>;
const asOwner = asUser(OWNER);
const pm = (field: string, args: object) => pub.VetraPublisherMutations[field]!({}, args, asOwner);

/** A template + published terms through the publisher surface (ledger-recorded). */
async function seedApp(
  id: string,
  name: string,
  mode: "DEDICATED" | "SHARED",
  terms: { kind: string; label: string; validityDays: number | null }[],
) {
  await h.addApp(id, OWNER);
  await h.client.execute(id, "main", [appActions.setAppDetails({ name })]);
  const templateId = (await pm("addTemplate", { input: { appId: id, name, mode } })) as string;
  if (mode === "DEDICATED") await pm("addTemplateService", { input: { appId: id, templateId, type: "CONNECT" } });
  for (const t of terms) {
    const termId = (await pm("addTerm", {
      input: { appId: id, kind: t.kind, label: t.label, templateId, validityDays: t.validityDays, issuers: ["INVITE_CODE", "PUBLISHER_GRANT"] },
    })) as string;
    await pm("publishTerm", { appId: id, termId });
  }
}

const code = (appId: string, kind: string, c: string, over: { maxUses?: number | null; expiresAt?: string | null; key?: string | null } = {}) =>
  createInviteCode(h.db, {
    appId, kind, code: c, label: null, expiresAt: over.expiresAt ?? null, maxUses: over.maxUses ?? null,
    anthropicKeyCiphertext: over.key ?? null, now: NOW,
  });

beforeAll(async () => {
  h = await createPublisherHarness();
  pub = h.build();
  await seedApp(APP_DED, "KV", "DEDICATED", [
    { kind: "pro", label: "Pro", validityDays: 30 },
    { kind: "max", label: "Max", validityDays: null },
  ]);
  await seedApp(APP_SH, "Pfnür", "SHARED", [{ kind: "free", label: "Free", validityDays: null }]);
  await h.client.execute(APP_SH, "main", [appActions.setProductionEnvironment({ environmentId: "env-app" })]);
  await seedApp(APP_STUDIO, "Vetra Studio", "SHARED", [{ kind: "studio-early-access-30d", label: "Early access", validityDays: 30 }]);
  // A term still in DRAFT: its codes are printed but not redeemable.
  const tpl = ((await pub.VetraPublisherQueries.templates!({}, { appId: APP_DED }, asOwner)) as { id: string }[])[0]!.id;
  await pm("addTerm", { input: { appId: APP_DED, kind: "beta", templateId: tpl, validityDays: 7, issuers: ["INVITE_CODE"] } });

  for (const c of ["kv-pro-01", "kv-pro-02", "kv-pro-03", "kv-pro-04", "kv-pro-05", "kv-pro-06"]) await code(APP_DED, "pro", c, { maxUses: 5 });
  // A DEDICATED template pointing at an artifact the app never published: it
  // cannot be resolved, so its published term issues nothing.
  const broken = (await pm("addTemplate", { input: { appId: APP_DED, name: "Broken", mode: "DEDICATED" } })) as string;
  await pm("addTemplateService", { input: { appId: APP_DED, templateId: broken, type: "FUSION", artifactName: "missing", artifactChannel: "STAGING" } });
  const brokenTerm = (await pm("addTerm", { input: { appId: APP_DED, kind: "broken", templateId: broken, validityDays: 30, issuers: ["INVITE_CODE"] } })) as string;
  await pm("publishTerm", { appId: APP_DED, termId: brokenTerm });
  await code(APP_DED, "broken", "kv-broken-01");
  await code(APP_DED, "max", "kv-max-01");
  await code(APP_DED, "max", "kv-max-02");
  await code(APP_DED, "beta", "kv-beta-01");
  await code(APP_DED, "pro", "kv-paused");
  await setInviteCodeActive(h.db, APP_DED, "kv-paused", false);
  await code(APP_DED, "pro", "kv-expired", { expiresAt: NOW });
  await code(APP_DED, "pro", "kv-used-up", { maxUses: 1 });
  await code(APP_SH, "free", "sh-free-01");
  await code(APP_SH, "free", "sh-free-02");
  await code(APP_STUDIO, "studio-early-access-30d", "studio-key-1", { key: "enc:sk-ant-1" });
  await code(APP_STUDIO, "studio-early-access-30d", "studio-nokey-1");

  grants = createGrantStore(h.db);
  // Lifecycle writes recorded at the test clock.
  lifecycle = createLifecycleStore(h.db, () => clock);
  gateway = createReactorLicenseGateway(h.client as never, { lifecycle });
  const licenceDeps = { licences: h.reads, lifecycle };
  const holderLicences = createHolderLicences({ ...licenceDeps, grants });
  deps = {
    issuer: {
      ...h.deps.issue,
      createLicenseDocument: gateway.create,
      executeLicence: gateway.execute,
      lifecycle,
      db: h.db,
      activeLicencesOf: async (appId, did) => (await holderLicences(appId, did)).filter((l) => l.status === "ACTIVE"),
    },
    apps: h.apps,
    licences: h.reads,
    lifecycle,
    grants,
    envRows: createChainEnvironmentRows(h.db, h.cfg),
    envState: async (id) => ENV_STATES[id] ?? null,
    licenseGateway: gateway,
    studio: {
      studioAppId: async () => APP_STUDIO,
      licencesOf: holderLicences,
      redeemedCode: (id, did) => redeemedCodeOf(h.db, id, did),
      keyCiphertextForCode: (c) => keyCiphertextForCode(h.db, c),
      keyVault: { encrypt: async (p) => `enc:${p}`, decrypt: async (c) => c.slice(4) },
      now: () => clock,
    },
    secrets: { setSecret },
    tenantOwners: async (t) => tenants.get(t) ?? [],
    // Short here; the polling itself is covered with fake timers in apply-studio-key.test.ts.
    tenantWait: { timeoutMs: 20, intervalMs: 5 },
    now: () => clock,
  };
  sub = createSubscriptionResolvers(deps) as unknown as typeof sub;
}, 120_000);

const INVALID = { valid: false, appId: null, appName: null, kind: null, termLabel: null, mode: null };

describe("vetraSubscriptions: invite codes", () => {
  it("checks a code publicly, without consuming it", async () => {
    expect(await q("inviteCode", { code: "kv-pro-01" }, anon)).toStrictEqual({
      valid: true, appId: APP_DED, appName: "KV", kind: "pro", termLabel: "Pro", mode: "DEDICATED",
    });
    expect(await q("inviteCode", { code: " sh-free-01 " }, anon)).toStrictEqual({
      valid: true, appId: APP_SH, appName: "Pfnür", kind: "free", termLabel: "Free", mode: "SHARED",
    });
    const uses = await h.db.selectFrom("invite_redemptions").selectAll().execute();
    expect(uses).toStrictEqual([]);
  });

  it("answers unknown, paused, expired, used-up and unredeemable codes identically: no oracle", async () => {
    await redeem({ code: "kv-used-up", label: "Burner" }, asOther);
    for (const c of ["nope-nope", "KV-PRO-01", "kv-paused", "kv-expired", "kv-used-up", "kv-beta-01", "kv-broken-01"]) {
      expect(await q("inviteCode", { code: c }, anon)).toStrictEqual(INVALID);
    }
  });

  it("requires a login for everything else", async () => {
    expect(await codeOf(q("mySubscriptions", {}, anon))).toBe("UNAUTHENTICATED");
    expect(await codeOf(q("studioAccess", {}, anon))).toBe("UNAUTHENTICATED");
    expect(await codeOf(redeem({ code: "kv-pro-01" }, anon))).toBe("UNAUTHENTICATED");
    expect(await codeOf(m("cancelSubscription", { licenseId: "x" }, anon))).toBe("UNAUTHENTICATED");
    expect(await codeOf(m("applyStudioKey", { tenantId: "t", secretNames: ["X"] }, anon))).toBe("UNAUTHENTICATED");
  });

  it("INVALID_CODE for unknown, paused, expired and used-up codes alike", async () => {
    for (const c of ["nope-nope", "kv-paused", "kv-expired", "kv-used-up"]) {
      expect(await codeOf(redeem({ code: c }))).toBe("INVALID_CODE");
    }
    // A code whose term cannot issue (DRAFT, or a DEDICATED template whose
    // artifacts do not resolve) is INVALID_CODE too, and nothing is consumed.
    for (const c of ["kv-beta-01", "kv-broken-01"]) {
      expect(await codeOf(redeem({ code: c }))).toBe("INVALID_CODE");
      expect(await h.db.selectFrom("invite_redemptions").selectAll().where("code", "=", c).execute()).toStrictEqual([]);
    }
  });
});

describe("vetraSubscriptions: redeeming, renewing, upgrading", () => {
  let thesis: Sub;

  it("redeems a DEDICATED code into a subscription named after the project, idempotently", async () => {
    const at = clock;
    thesis = await redeem({ code: "kv-pro-01", label: "Thesis" });
    expect(thesis).toStrictEqual({
      licenseId: thesis.licenseId, appId: APP_DED, appName: "KV", kind: "pro", termLabel: "Pro",
      issuer: "INVITE_CODE", status: "ACTIVE", start: at, end: plus(at, 30), mode: "DEDICATED",
      environmentId: null, environmentLabel: "Thesis", openUrl: null, stoppedAt: null, deleteAfter: null, warnings: [],
    });
    expect((await redeem({ code: "kv-pro-01" })).licenseId).toBe(thesis.licenseId);
    // The grant row names the caller, normalised to chain 1.
    expect((await grants.grantFor(thesis.licenseId))?.userDid).toBe(HOLDER_DID);
  });

  it("Open goes to the environment once the chain has one", async () => {
    await h.db.insertInto("license_environments").values({
      environment_id: "env-ded", root_license_id: thesis.licenseId, app_id: APP_DED, user_did: HOLDER_DID,
      license_id: thesis.licenseId, template_id: null, label: "Thesis env", template_hash: "h",
      ended_at: null, stopped_at: null, delete_after: null, created_at: NOW, updated_at: NOW,
    }).execute();
    expect((await mine()).find((s) => s.licenseId === thesis.licenseId)).toMatchObject({
      environmentId: "env-ded", environmentLabel: "Thesis env", openUrl: "https://thesis.vetra.io",
    });
  });

  it("renews the same time-limited kind: 10 days left on 30 ends at the old end + 30, same environment", async () => {
    const oldEnd = thesis.end!;
    travel(plus(oldEnd, -10));
    const at = clock;
    const renewed = await redeem({ code: "kv-pro-02", upgrades: thesis.licenseId });
    expect(renewed).toMatchObject({ kind: "pro", status: "ACTIVE", start: at, end: plus(oldEnd, 30), environmentId: "env-ded", openUrl: "https://thesis.vetra.io" });
    expect(await h.reads.licenceRecord(thesis.licenseId)).toMatchObject({ status: "REPLACED", replacedBy: renewed.licenseId });
    expect(await grants.chainRootOf(renewed.licenseId)).toBe(thesis.licenseId);
    // EXPIRING once within 7 days of the new end.
    travel(plus(oldEnd, 25));
    expect((await mine()).find((s) => s.licenseId === renewed.licenseId)?.warnings).toMatchObject([{ kind: "EXPIRING", at: plus(oldEnd, 30) }]);
    thesis = renewed;
  });

  it("an unlimited kind held ACTIVE is ALREADY_HOLDS, with or without upgrades", async () => {
    const max = await redeem({ code: "kv-max-01", upgrades: thesis.licenseId });
    expect(max).toMatchObject({ kind: "max", end: null, environmentId: "env-ded" });
    expect(await codeOf(redeem({ code: "kv-max-02", upgrades: max.licenseId }))).toBe("ALREADY_HOLDS");
    // Refused without consuming the code.
    expect(await h.db.selectFrom("invite_redemptions").selectAll().where("code", "=", "kv-max-02").execute()).toStrictEqual([]);
    thesis = max;
  });

  it("only the newest licence of a chain can be built on; another holder's is NOT_FOUND", async () => {
    const chain = await h.db.selectFrom("license_chain").select("license_id").where("root_license_id", "=", (await grants.chainRootOf(thesis.licenseId))).orderBy("created_at").execute();
    expect(await codeOf(redeem({ code: "kv-pro-03", upgrades: chain[0]!.license_id }))).toBe("INVALID_INPUT");
    expect(await codeOf(redeem({ code: "kv-pro-03", upgrades: thesis.licenseId }, asOther))).toBe("NOT_FOUND");
    expect(await codeOf(redeem({ code: "kv-pro-03", upgrades: "no-such-licence" }))).toBe("NOT_FOUND");
  });

  it("an ISSUED predecessor is refused (INVALID_INPUT)", async () => {
    const id = await gateway.create();
    await gateway.execute(id, [licenseActions.issueLicense({
      app: APP_DED, user: HOLDER_DID, issuer: "PUBLISHER_GRANT", kind: "pro", stage: null,
      details: null, issued: clock, start: clock, end: plus(clock, 30),
    })]);
    await grants.linkChain({ licenseId: id, rootLicenseId: id, appId: APP_DED, label: null, now: clock });
    await grants.recordGrant({ licenseId: id, appId: APP_DED, kind: "pro", userDid: HOLDER_DID, issuedBy: OWNER, now: clock });
    expect(await codeOf(redeem({ code: "kv-pro-03", upgrades: id }))).toBe("INVALID_INPUT");
    await gateway.execute(id, [licenseActions.revokeLicense({ reason: "test" })]);
  });

  it.each(["EXPIRED", "REVOKED"] as const)("a %s newest licence comes back on the same chain and environment", async (status) => {
    const before = await redeem({ code: status === "EXPIRED" ? "kv-pro-04" : "kv-pro-05", label: `Lapsed ${status}` });
    const env = `env-${status}`;
    await h.db.insertInto("license_environments").values({
      environment_id: env, root_license_id: before.licenseId, app_id: APP_DED, user_did: HOLDER_DID,
      license_id: before.licenseId, template_id: null, label: null, template_hash: "h",
      ended_at: null, stopped_at: null, delete_after: null, created_at: NOW, updated_at: NOW,
    }).execute();
    if (status === "EXPIRED") await gateway.expire(before.licenseId);
    else expect(await m("cancelSubscription", { licenseId: before.licenseId }, asHolder)).toBe(true);
    const back = await redeem({ code: "kv-max-02", upgrades: before.licenseId });
    expect(back).toMatchObject({ kind: "max", status: "ACTIVE", environmentId: env, environmentLabel: `Lapsed ${status}` });
    expect(await grants.chainRootOf(back.licenseId)).toBe(before.licenseId);
    // Terminal predecessors are left as they were, not REPLACED.
    expect(await h.reads.licenceRecord(before.licenseId)).toMatchObject({ status });
    await h.db.deleteFrom("invite_redemptions").where("code", "=", "kv-max-02").execute();
  });

  it("redeems a SHARED code: Open goes to the app, a second code for the kind is ALREADY_HOLDS", async () => {
    const shared = await redeem({ code: "sh-free-01", label: "ignored" });
    expect(shared).toMatchObject({ mode: "SHARED", openUrl: "https://pfnuer.vetra.io", environmentId: null, environmentLabel: null, end: null });
    expect(await codeOf(redeem({ code: "sh-free-02" }))).toBe("ALREADY_HOLDS");
    expect(await codeOf(redeem({ code: "sh-free-02", upgrades: shared.licenseId }))).toBe("ALREADY_HOLDS");
  });
});

describe("vetraSubscriptions: what I hold", () => {
  it("lists the newest licence of each of the caller's chains, and nobody else's", async () => {
    const subs = await mine();
    const ids = subs.map((s) => s.licenseId);
    // Every listed licence is a chain head held by the caller: no REPLACED predecessor.
    expect(subs.every((s) => s.status !== "REPLACED")).toBe(true);
    for (const s of subs) expect((await grants.grantFor(s.licenseId))?.userDid).toBe(HOLDER_DID);
    expect(new Set(ids).size).toBe(ids.length);
    // The thesis chain (renewed, then upgraded to max), the two restored
    // chains, the SHARED licence, and the ISSUED one revoked above (ended
    // within the last 90 days).
    expect(subs.map((s) => `${s.kind}:${s.status}`).sort()).toStrictEqual(["free:ACTIVE", "max:ACTIVE", "max:ACTIVE", "max:ACTIVE", "pro:REVOKED"]);
    expect((await mine(asOther)).map((s) => s.kind)).toStrictEqual(["pro"]);
  });

  it("ignores a licence document naming the caller without a grant row", async () => {
    const forged = await gateway.create();
    await h.client.execute(forged, "main", [
      licenseActions.issueLicense({ app: APP_DED, user: HOLDER_DID, issuer: "INVITE_CODE", kind: "pro", stage: null, details: null, issued: NOW, start: NOW, end: null }),
      licenseActions.activateLicense({}),
    ]);
    expect((await mine()).map((s) => s.licenseId)).not.toContain(forged);
    expect(await codeOf(m("cancelSubscription", { licenseId: forged }, asHolder))).toBe("NOT_FOUND");
  });

  it("keeps an ended licence listed while its environment offboards, with its warnings", async () => {
    const lapsed = await redeem({ code: "kv-pro-06", label: "Offboarding" });
    await h.db.insertInto("license_environments").values({
      environment_id: "env-off", root_license_id: lapsed.licenseId, app_id: APP_DED, user_did: HOLDER_DID,
      license_id: lapsed.licenseId, template_id: null, label: "Offboarding", template_hash: "h",
      ended_at: clock, stopped_at: null, delete_after: plus(clock, 90), created_at: clock, updated_at: clock,
    }).execute();
    const ended = clock;
    await gateway.expire(lapsed.licenseId);
    travel(plus(ended, 85));
    expect((await mine()).find((s) => s.licenseId === lapsed.licenseId)).toMatchObject({
      status: "EXPIRED", deleteAfter: plus(ended, 90), warnings: [{ kind: "DELETE_IMMINENT", at: plus(ended, 90) }],
    });
    // Destroyed (row gone) and 90 days after it ended: no longer listed.
    travel(plus(ended, 91));
    await h.db.deleteFrom("license_environments").where("environment_id", "=", "env-off").execute();
    expect((await mine()).map((s) => s.licenseId)).not.toContain(lapsed.licenseId);
  });

  it("an ended licence without an environment stays listed for 90 days after it ended", async () => {
    const [mineOther] = await mine(asOther);
    const cancelled = clock;
    expect(await m("cancelSubscription", { licenseId: mineOther!.licenseId }, asOther)).toBe(true);
    travel(plus(cancelled, 89));
    expect((await mine(asOther))[0]).toMatchObject({ licenseId: mineOther!.licenseId, status: "REVOKED" });
    travel(plus(cancelled, 91));
    expect(await mine(asOther)).toStrictEqual([]);
  });
});

describe("vetraSubscriptions: cancelling", () => {
  it("cancels only the caller's live licence, through the recording gateway", async () => {
    const [shared] = (await mine()).filter((s) => s.mode === "SHARED");
    expect(await codeOf(m("cancelSubscription", { licenseId: shared!.licenseId }, asOther))).toBe("NOT_FOUND");
    expect(await codeOf(m("cancelSubscription", { licenseId: "no-such-licence" }, asHolder))).toBe("NOT_FOUND");
    expect(await m("cancelSubscription", { licenseId: shared!.licenseId }, asHolder)).toBe(true);
    expect((await lifecycle.get(shared!.licenseId))?.status).toBe("REVOKED");
    expect(await codeOf(m("cancelSubscription", { licenseId: shared!.licenseId }, asHolder))).toBe("INVALID_INPUT");
  });

  it("trusts the record over the document: a revoked licence forged back to ACTIVE cannot be cancelled again, a replaced one never", async () => {
    const [ded] = (await mine()).filter((s) => s.status === "ACTIVE" && s.mode === "DEDICATED");
    const root = await grants.chainRootOf(ded!.licenseId);
    const chain = await h.db.selectFrom("license_chain").select("license_id").where("root_license_id", "=", root).orderBy("created_at").execute();
    expect(await codeOf(m("cancelSubscription", { licenseId: chain[0]!.license_id }, asHolder))).toBe("INVALID_INPUT");
    // The record says REVOKED; the document is made to say otherwise only by
    // forging it (the reducer refuses a revoked -> active move), so the
    // record alone is checked here.
    await lifecycle.record(ded!.licenseId, [licenseActions.revokeLicense({ reason: "recorded" })]);
    expect(await codeOf(m("cancelSubscription", { licenseId: ded!.licenseId }, asHolder))).toBe("INVALID_INPUT");
    expect((await h.reads.licenceRecord(ded!.licenseId))?.status).toBe("ACTIVE");
    const [view] = await authorisedLicences({ licences: h.reads, lifecycle }, [(await grants.grantFor(ded!.licenseId))!]);
    expect(view?.status).toBe("REVOKED");
  });
});

describe("vetraSubscriptions: studio", () => {
  let studio: Sub;

  it("reports no access, all null, to someone who never held a studio licence", async () => {
    expect(await q("studioAccess", {}, asHolder)).toStrictEqual({ allowed: false, licenseId: null, expires: null, hasAttachedKey: false });
    expect(await m("applyStudioKey", { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY"] }, asHolder)).toBe(false);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("grants access through a studio code carrying a key", async () => {
    studio = await redeem({ code: "studio-key-1" });
    expect(await q("studioAccess", {}, asHolder)).toStrictEqual({
      allowed: true, licenseId: studio.licenseId, expires: plus(studio.start!, 30), hasAttachedKey: true,
    });
  });

  it("writes the key into the caller's own tenant only; an unprojected one is NOT_FOUND", async () => {
    tenants.set("t-1", [HOLDER]);
    expect(await m("applyStudioKey", { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY", "VETRA_CLI_ANTHROPIC_API_KEY"] }, asHolder)).toBe(true);
    expect(setSecret).toHaveBeenCalledWith("t-1", "ANTHROPIC_API_KEY", "sk-ant-1");
    expect(setSecret).toHaveBeenCalledWith("t-1", "VETRA_CLI_ANTHROPIC_API_KEY", "sk-ant-1");
    expect(setSecret).toHaveBeenCalledWith("t-1", "VETRA_SESSION_EXPORT_SECRET", expect.stringMatching(/^[0-9a-f]{64}$/));
    setSecret.mockClear();
    expect(await codeOf(m("applyStudioKey", { tenantId: "t-new", secretNames: ["ANTHROPIC_API_KEY"] }, asHolder))).toBe("NOT_FOUND");
    expect(await codeOf(m("applyStudioKey", { tenantId: "t-1", secretNames: ["CLAUDE_KEY"] }, asHolder))).toBe("INVALID_INPUT");
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("refuses another owner's tenant (FORBIDDEN) and a caller without a key (false), writing nothing", async () => {
    setSecret.mockClear();
    tenants.set("t-theirs", [OTHER]);
    tenants.set("t-unowned", [null]);
    tenants.set("t-mixed", [HOLDER, OTHER]);
    for (const t of ["t-theirs", "t-unowned", "t-mixed"]) {
      expect(await codeOf(m("applyStudioKey", { tenantId: t, secretNames: ["ANTHROPIC_API_KEY"] }, asHolder))).toBe("FORBIDDEN");
    }
    expect(await m("applyStudioKey", { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY"] }, asOther)).toBe(false);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("never logs the key", () => {
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.log.mock.calls]);
    expect(logged).not.toContain("sk-ant-1");
  });

  it("after cancelling: no access, but the licence is still named for its warnings", async () => {
    expect(await m("cancelSubscription", { licenseId: studio.licenseId }, asHolder)).toBe(true);
    expect(await q("studioAccess", {}, asHolder)).toStrictEqual({
      allowed: false, licenseId: studio.licenseId, expires: plus(studio.start!, 30), hasAttachedKey: false,
    });
    expect(await m("applyStudioKey", { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY"] }, asHolder)).toBe(false);
  });

  it("without a secrets service the key is never written", async () => {
    const again = await redeem({ code: "studio-nokey-1", upgrades: studio.licenseId });
    expect(await q("studioAccess", {}, asHolder)).toMatchObject({ allowed: true, licenseId: again.licenseId, hasAttachedKey: false });
    const noSecrets = createSubscriptionResolvers({ ...deps, secrets: null }) as unknown as typeof sub;
    expect(await noSecrets.VetraSubscriptionsMutations.applyStudioKey!({}, { tenantId: "t-1", secretNames: ["ANTHROPIC_API_KEY"] }, asHolder)).toBe(false);
  });
});
