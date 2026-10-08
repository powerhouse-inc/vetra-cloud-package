import { beforeAll, describe, expect, it } from "vitest";
import type { GraphQLError } from "graphql";
import {
  asUser,
  codeOf,
  createPublisherHarness,
  type PublisherHarness,
  type Resolvers,
} from "./publisher-harness.js";

/**
 * Publisher isolation: owner A, calling with ANY of B's ids (app, template,
 * term, licence, invite code), gets NOT_FOUND and changes nothing of B's --
 * neither B's app document nor B's licence document nor any table row. Every
 * field of the contract is covered, and the field list is pinned to the
 * contract, so a field added later cannot skip this suite.
 */

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const APP_A = "a0000000-5d0e-4e3e-9a55-1c3b9b8f2a01";
const APP_B = "b0000000-5d0e-4e3e-9a55-1c3b9b8f2a02";
const HOLDER = "0x1111111111111111111111111111111111111111";

// Contract § vetraPublisher, in contract order.
const CONTRACT_QUERIES = [
  "myApps", "templates", "terms", "appArtifacts", "licenses", "environments", "inviteCodes", "allowList",
];
const CONTRACT_MUTATIONS = [
  "addTemplate", "setTemplateDetails", "addTemplateService", "removeTemplateService",
  "addTemplatePackage", "removeTemplatePackage", "deleteTemplate", "addTerm", "setTermDetails",
  "publishTerm", "retireTerm", "issueGrant", "replaceGrant", "revokeLicense", "createInviteCode",
  "setInviteCodeActive", "addToAllowList", "removeFromAllowList",
];

/** One app's ids, as its own owner created them through the publisher API. */
interface Ids {
  app: string;
  template: string;
  service: string;
  pkg: string;
  term: string;
  licence: string;
  code: string;
}

let h: PublisherHarness;
let r: Resolvers;
let a: Ids;
let b: Ids;

async function seed(owner: string, app: string): Promise<Ids> {
  const ctx = asUser(owner);
  const m = (f: string, args: object) => r.VetraPublisherMutations[f]!({}, args, ctx);
  const template = (await m("addTemplate", { input: { appId: app, name: "T", mode: "DEDICATED" } })) as string;
  await m("addTemplateService", { input: { appId: app, templateId: template, type: "CONNECT" } });
  await m("addTemplatePackage", { input: { appId: app, templateId: template, packageName: "@x/y" } });
  const term = (await m("addTerm", { input: { appId: app, kind: "pro", templateId: template, issuers: ["PUBLISHER_GRANT", "INVITE_CODE"] } })) as string;
  await m("publishTerm", { appId: app, termId: term });
  await m("addTerm", { input: { appId: app, kind: "max", templateId: template, issuers: ["PUBLISHER_GRANT"] } })
    .then((id) => m("publishTerm", { appId: app, termId: id }));
  await m("addToAllowList", { appId: app, user: HOLDER });
  const licence = (await m("issueGrant", { input: { appId: app, kind: "pro", user: HOLDER } })) as string;
  const code = ((await m("createInviteCode", { input: { appId: app, kind: "pro" } })) as { code: string }).code;
  const [t] = (await r.VetraPublisherQueries.templates!({}, { appId: app }, ctx)) as {
    services: { id: string }[];
    packages: { id: string }[];
  }[];
  return { app, template, service: t!.services[0]!.id, pkg: t!.packages[0]!.id, term, licence, code };
}

const TABLES = [
  "app_license_grants", "license_chain", "license_lifecycle", "license_environments",
  "app_allow_list", "invite_codes", "invite_redemptions", "app_licensing_state",
] as const;

/** Everything of B's that a call could change. */
async function snapshotB(): Promise<unknown> {
  const tables: Record<string, unknown> = {};
  for (const t of TABLES) {
    tables[t] = await h.db.selectFrom(t).selectAll().execute();
  }
  return {
    appRevision: await h.revisionOf(b.app),
    appState: await h.stateOf(b.app),
    licenceRevision: await h.revisionOf(b.licence),
    tables,
  };
}

/** The call A makes with B's ids, and the same call on A's own ids. */
type Case = [field: string, kind: "q" | "m", args: (ids: Ids, own: Ids) => object];
const CASES: Case[] = [
  ["templates", "q", (x) => ({ appId: x.app })],
  ["terms", "q", (x) => ({ appId: x.app })],
  ["appArtifacts", "q", (x) => ({ appId: x.app })],
  ["licenses", "q", (x) => ({ appId: x.app })],
  ["environments", "q", (x) => ({ appId: x.app })],
  ["inviteCodes", "q", (x) => ({ appId: x.app })],
  ["allowList", "q", (x) => ({ appId: x.app })],
  ["addTemplate", "m", (x) => ({ input: { appId: x.app, mode: "SHARED" } })],
  ["setTemplateDetails", "m", (x) => ({ input: { appId: x.app, templateId: x.template, name: "renamed" } })],
  ["addTemplateService", "m", (x) => ({ input: { appId: x.app, templateId: x.template, type: "SWITCHBOARD" } })],
  ["removeTemplateService", "m", (x) => ({ input: { appId: x.app, templateId: x.template, id: x.service } })],
  ["addTemplatePackage", "m", (x) => ({ input: { appId: x.app, templateId: x.template, packageName: "@x/z" } })],
  ["removeTemplatePackage", "m", (x) => ({ input: { appId: x.app, templateId: x.template, id: x.pkg } })],
  ["deleteTemplate", "m", (x) => ({ appId: x.app, templateId: x.template })],
  ["addTerm", "m", (x) => ({ input: { appId: x.app, kind: "extra" } })],
  ["setTermDetails", "m", (x) => ({ input: { appId: x.app, termId: x.term, label: "renamed" } })],
  ["publishTerm", "m", (x) => ({ appId: x.app, termId: x.term })],
  ["retireTerm", "m", (x) => ({ appId: x.app, termId: x.term })],
  ["issueGrant", "m", (x) => ({ input: { appId: x.app, kind: "pro", user: HOLDER } })],
  ["replaceGrant", "m", (x) => ({ input: { licenseId: x.licence, kind: "max" } })],
  ["revokeLicense", "m", (x) => ({ input: { licenseId: x.licence, reason: "nope" } })],
  ["createInviteCode", "m", (x) => ({ input: { appId: x.app, kind: "pro" } })],
  ["setInviteCodeActive", "m", (x) => ({ appId: x.app, code: x.code, active: false })],
  ["addToAllowList", "m", (x) => ({ appId: x.app, user: "0x3333333333333333333333333333333333333333" })],
  ["removeFromAllowList", "m", (x) => ({ appId: x.app, user: HOLDER })],
];

/** A's appId with one of B's inner ids: still B's, still NOT_FOUND. */
const CROSS: Case[] = [
  ["setTemplateDetails", "m", (x, own) => ({ input: { appId: own.app, templateId: x.template, name: "renamed" } })],
  ["addTemplateService", "m", (x, own) => ({ input: { appId: own.app, templateId: x.template, type: "SWITCHBOARD" } })],
  ["removeTemplateService", "m", (x, own) => ({ input: { appId: own.app, templateId: x.template, id: x.service } })],
  ["addTemplatePackage", "m", (x, own) => ({ input: { appId: own.app, templateId: x.template, packageName: "@x/z" } })],
  ["removeTemplatePackage", "m", (x, own) => ({ input: { appId: own.app, templateId: x.template, id: x.pkg } })],
  ["deleteTemplate", "m", (x, own) => ({ appId: own.app, templateId: x.template })],
  ["setTermDetails", "m", (x, own) => ({ input: { appId: own.app, termId: x.term, label: "renamed" } })],
  ["publishTerm", "m", (x, own) => ({ appId: own.app, termId: x.term })],
  ["retireTerm", "m", (x, own) => ({ appId: own.app, termId: x.term })],
  ["setInviteCodeActive", "m", (x, own) => ({ appId: own.app, code: x.code, active: false })],
];

const call = (owner: string, [field, kind, args]: Case, ids: Ids, own: Ids) =>
  (kind === "q" ? r.VetraPublisherQueries : r.VetraPublisherMutations)[field]!({}, args(ids, own), asUser(owner));

beforeAll(async () => {
  h = await createPublisherHarness();
  await h.addApp(APP_A, A);
  await h.addApp(APP_B, B);
  r = h.build();
  a = await seed(A, APP_A);
  b = await seed(B, APP_B);
  await h.db.insertInto("license_environments").values({
    environment_id: "env-b", root_license_id: b.licence, app_id: APP_B, user_did: `did:pkh:eip155:1:${HOLDER}`,
    license_id: b.licence, template_id: b.template, label: null, template_hash: "h",
    ended_at: null, stopped_at: null, delete_after: null, created_at: "t", updated_at: "t",
  }).execute();
}, 180_000);

describe("publisher isolation", () => {
  it("the resolver fields are exactly the contract's, so none escapes this suite", () => {
    expect(Object.keys(r.VetraPublisherQueries).sort()).toStrictEqual([...CONTRACT_QUERIES].sort());
    expect(Object.keys(r.VetraPublisherMutations).sort()).toStrictEqual([...CONTRACT_MUTATIONS].sort());
    const covered = new Set(["myApps", ...CASES.map(([f]) => f)]);
    expect([...CONTRACT_QUERIES, ...CONTRACT_MUTATIONS].filter((f) => !covered.has(f))).toStrictEqual([]);
  });

  it("myApps lists only the caller's apps", async () => {
    expect(await r.VetraPublisherQueries.myApps!({}, {}, asUser(A))).toStrictEqual([
      { id: APP_A, name: `App ${APP_A.slice(0, 4)}`, status: "ACTIVE" },
    ]);
  });

  it.each(CASES)("%s with B's ids: NOT_FOUND, nothing of B's changes", async (...c) => {
    const before = await snapshotB();
    expect(await codeOf(call(A, c, b, a))).toBe("NOT_FOUND");
    expect(await snapshotB()).toStrictEqual(before);
  });

  it.each(CROSS)("%s with A's app and B's inner id: NOT_FOUND, nothing of B's changes", async (...c) => {
    const before = await snapshotB();
    expect(await codeOf(call(A, c, b, a))).toBe("NOT_FOUND");
    expect(await snapshotB()).toStrictEqual(before);
  });

  it("B's ids fail with the same message as missing ones", async () => {
    const missing: Ids = { app: "missing-app", template: "missing-t", service: "s", pkg: "p", term: "missing-k", licence: "missing-l", code: "missing-code" };
    for (const c of [...CASES, ...CROSS]) {
      const foreign = (await call(A, c, b, a).catch((e: unknown) => e)) as GraphQLError;
      const absent = (await call(A, c, missing, a).catch((e: unknown) => e)) as GraphQLError;
      expect(absent.extensions?.code, c[0]).toBe("NOT_FOUND");
      expect(foreign.message, c[0]).toBe(absent.message);
    }
  });

  it.each([...CASES, ...CROSS])("positive control: %s on A's own ids is not NOT_FOUND", async (...c) => {
    expect(await codeOf(call(A, c, a, a))).not.toBe("NOT_FOUND");
  });
});
