import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphQLError } from "graphql";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import { createGrantStore } from "../grants.js";
import { createLifecycleStore } from "../lifecycle.js";
import {
  createChainEnvironmentRows,
  provisionChainExclusive,
  type ChainEnvDeps,
} from "../environments.js";
import type { OffboardingDeps } from "../offboarding.js";
import type { AppDocView, AppTemplateView } from "../app-reads.js";
import type { LicenceRecord } from "../reads.js";
import { createResolvers, type ResolverDeps } from "../resolvers.js";
import { REPORTING_HEADER } from "../reporting.js";

type Field = (p: unknown, a: unknown, c: unknown) => Promise<unknown>;
type Resolvers = {
  VetraLicensingQueries: Record<string, Field>;
  VetraLicensingMutations: Record<string, Field>;
};

const NOW = "2026-10-08T00:00:00.000Z";
const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const OTHER_DID = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const FORGED_DID = "did:pkh:eip155:1:0x3333333333333333333333333333333333333333";
const LAPSED_DID = "did:pkh:eip155:1:0x4444444444444444444444444444444444444444";
const NEW_DID = "did:pkh:eip155:1:0x5555555555555555555555555555555555555555";

const caller = (appKey?: string) => ({
  user: { address: "0x9999999999999999999999999999999999999999", networkId: "eip155", chainId: 1, ...(appKey ? { appKey } : {}) },
});
const asApp = caller("did:key:app1");
const asApp2 = caller("did:key:app2");

const TEMPLATE = {
  services: [{ id: "s", type: "CONNECT", prefix: null }],
  packages: [],
  size: null,
  baseDomain: null,
  packageRegistry: null,
};
const template = (id: string, mode: "SHARED" | "DEDICATED", hash: string, resolutionError: string | null = null): AppTemplateView => ({
  id, name: id, mode, sharedEnvironment: mode === "SHARED" ? "env-shared" : null,
  template: TEMPLATE, templateHash: hash, resolutionError,
});
const term = (id: string, kind: string, templateId: string | null, status: "DRAFT" | "ACTIVE" | "RETIRED" = "ACTIVE") => ({
  id, kind, label: null, templateId, validityDays: null, issuers: ["PUBLISHER_GRANT"], status,
});

/** The calling app's document, as app-reads returns it (integrity flags filled in). */
let app1: AppDocView;
const freshApp1 = (): AppDocView => ({
  id: "app-1", name: "Vault", slug: "vault", owner: null, status: "ACTIVE", identityDid: "did:key:app1",
  productionEnvironmentId: null,
  templates: [
    template("tpl-ded", "DEDICATED", "h-ded"),
    template("tpl-sh", "SHARED", "h-sh"),
    template("tpl-broken", "DEDICATED", "h-broken", "artifact missing has no channel STAGING"),
  ],
  terms: [
    term("k1", "pro", "tpl-ded"),
    term("k2", "draft", null, "DRAFT"),
    term("k3", "free", "tpl-sh"),
    term("k4", "broken", "tpl-broken"),
  ],
  artifacts: [], tampered: false, tamperReason: null, licensingStateHash: "x", unverified: false,
});

const licence = (id: string, app: string, user: string, kind: string, status: LicenceRecord["status"], stage: string | null = null): LicenceRecord => ({
  id, app, user, kind, issuer: "PUBLISHER_GRANT", status, issued: NOW, start: null, end: null,
  stage, details: null, replacedBy: null, legacyLicenseTypeId: null,
});
/** Licence DOCUMENTS: forgeable, so their app, holder, kind and status never decide anything. */
const DOCS: LicenceRecord[] = [
  licence("l1", "app-1", DID, "pro", "ACTIVE", "env-1"),
  licence("l-shared", "app-1", DID, "free", "ACTIVE"),
  licence("l-app2", "app-2", DID, "pro", "ACTIVE"),
  licence("l-forged", "app-1", FORGED_DID, "pro", "ACTIVE"),
  licence("l-other", "app-2", OTHER_DID, "pro", "ACTIVE"),
  // Its document says ACTIVE; the system recorded it EXPIRED.
  licence("l-lapsed", "app-1", LAPSED_DID, "pro", "ACTIVE"),
  licence("l-draft", "app-1", DID, "draft", "ACTIVE"),
  licence("l-broken", "app-1", DID, "broken", "ACTIVE"),
  // A licence with a grant but no lifecycle record: the system cannot vouch for it.
  licence("l-unrecorded", "app-1", DID, "pro", "ACTIVE"),
  // r0 was replaced by r1 in the same chain; r0's environment carries on for r1.
  licence("r0", "app-1", DID, "pro", "REPLACED", "env-r"),
  licence("r1", "app-1", DID, "pro", "ACTIVE"),
  // A chain that ended: its only licence was revoked.
  licence("l-old", "app-1", DID, "pro", "REVOKED", "env-old"),
  licence("l-new", "app-1", NEW_DID, "pro", "ACTIVE"),
];

let db: Kysely<VetraLicensingDB>;
let migrated: boolean;
let s: ReturnType<typeof spies>;

const spies = () => ({
  create: vi.fn(async () => `env-created-${Math.random().toString(36).slice(2, 8)}`),
  execute: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
  wake: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  relay: vi.fn(async () => false),
  createLicenseDocument: vi.fn(async () => "lic-new"),
  executeLicence: vi.fn(async () => undefined),
});

function deps(over: Partial<ResolverDeps> = {}, enabled = true): ResolverDeps {
  const cfg = { ...loadLicensingConfig({}), enabled };
  const lifecycle = createLifecycleStore(db, () => NOW);
  const grants = createGrantStore(db);
  const envRows = createChainEnvironmentRows(db, cfg);
  const envStates = new Map<string, string>();
  const chainEnv: ChainEnvDeps = {
    rows: envRows,
    envs: {
      create: async () => {
        const id = await s.create();
        envStates.set(id, "DRAFT");
        return id;
      },
      execute: async (id, actions) => {
        await s.execute();
        envStates.set(id, "CHANGES_APPROVED");
        return actions;
      },
      getState: async (id) =>
        ({ status: envStates.get(id) ?? "READY", packages: [], services: [] }) as never,
      delete: async (id) => {
        envStates.delete(id);
      },
    },
    generateSubdomain: (id) => `sub-${id}`,
  };
  const offboarding: OffboardingDeps = {
    rows: envRows,
    envStatus: async () => "READY",
    sleep: s.sleep,
    wake: s.wake,
    destroy: s.destroy,
    cfg,
    logger: { info: () => {}, warn: () => {} },
    now: () => NOW,
  };
  const apps = { app: async (id: string) => (id === "app-1" ? app1 : null) };
  const licences = {
    licenceRecords: async (ids: string[]) => ids.flatMap((id) => DOCS.filter((d) => d.id === id)),
  };
  return {
    auth: {
      findAppByIdentityDid: async (did) =>
        did === "did:key:app1"
          ? { id: "app-1", status: "ACTIVE" }
          : did === "did:key:app2"
            ? { id: "app-2", status: "ACTIVE" }
            : null,
    },
    apps,
    licences,
    lifecycle,
    grants,
    envRows,
    provision: (input) => provisionChainExclusive(chainEnv, input),
    offboarding,
    issue: {
      owners: { findAppById: async (id) => (id === "app-1" ? { id, name: "Vault", status: "ACTIVE", owner_address: "0xowner" } : null) },
      apps,
      licence: async (id) => DOCS.find((d) => d.id === id) ?? null,
      createLicenseDocument: s.createLicenseDocument,
      executeLicence: s.executeLicence,
      grants,
      lifecycle,
      logger: { warn: () => {} },
    },
    migrationComplete: async () => migrated,
    cfg,
    now: () => NOW,
    relay: s.relay,
    ...over,
  };
}

const build = (over: Partial<ResolverDeps> = {}, enabled = true) =>
  createResolvers(deps(over, enabled)) as unknown as Resolvers;
const q = (field: string, args: object, ctx: object, r = build()) => r.VetraLicensingQueries[field]!({}, args, ctx);
const m = (field: string, args: object, ctx: object, r = build()) => r.VetraLicensingMutations[field]!({}, args, ctx);
const disabledM = (field: string, args: object, ctx: object) => m(field, args, ctx, build({}, false));

/** The GraphQL error code a call ends with, or "OK". */
async function code(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as GraphQLError).extensions?.code ?? `UNMAPPED: ${String(e)}`;
  }
}

const envRow = (environmentId: string, root: string, appId: string, user: string, licenseId: string, label: string | null): LicenseEnvironments => ({
  environment_id: environmentId, root_license_id: root, app_id: appId, user_did: user, license_id: licenseId,
  template_id: "tpl-ded", label, template_hash: "h-ded", ended_at: null, stopped_at: null, delete_after: null,
  created_at: NOW, updated_at: NOW,
});

/** The DB authority: grant rows (app, holder, kind), lifecycle records and chain environments. */
async function seed() {
  await db.deleteFrom("app_license_grants").execute();
  await db.deleteFrom("license_lifecycle").execute();
  await db.deleteFrom("license_chain").execute();
  await db.deleteFrom("license_environments").execute();
  await db.deleteFrom("app_allow_list").execute();
  const grants = createGrantStore(db);
  const grant = (licenseId: string, appId: string, userDid: string, kind: string) =>
    grants.recordGrant({ licenseId, appId, kind, userDid, issuedBy: "0xowner", now: NOW });
  const life = (licenseId: string, status: string, replacedBy: string | null = null) =>
    db.insertInto("license_lifecycle").values({ license_id: licenseId, status, end_at: null, replaced_by: replacedBy, updated_at: NOW }).execute();
  for (const [id, appId, user, kind, status] of [
    ["l1", "app-1", DID, "pro", "ACTIVE"],
    ["l-shared", "app-1", DID, "free", "ACTIVE"],
    ["l-app2", "app-2", DID, "pro", "ACTIVE"],
    ["l-other", "app-2", OTHER_DID, "pro", "ACTIVE"],
    ["l-lapsed", "app-1", LAPSED_DID, "pro", "EXPIRED"],
    ["l-draft", "app-1", DID, "draft", "ACTIVE"],
    ["l-broken", "app-1", DID, "broken", "ACTIVE"],
    ["r1", "app-1", DID, "pro", "ACTIVE"],
    ["l-old", "app-1", DID, "pro", "REVOKED"],
    ["l-new", "app-1", NEW_DID, "pro", "ACTIVE"],
  ] as const) {
    await grant(id, appId, user, kind);
    await life(id, status);
  }
  await grant("r0", "app-1", DID, "pro");
  await life("r0", "REPLACED", "r1");
  await grants.linkChain({ licenseId: "r1", rootLicenseId: "r0", appId: "app-1", label: null, now: NOW });
  await grant("l-unrecorded", "app-1", DID, "pro");
  // l-forged has NO grant row: an ACTIVE document naming app-1 proves nothing.
  const rows = createChainEnvironmentRows(db, loadLicensingConfig({}));
  await rows.claim(envRow("env-1", "l1", "app-1", DID, "l1", "Vault"));
  await rows.claim(envRow("env-r", "r0", "app-1", DID, "r0", "Renewed"));
  await rows.claim(envRow("env-old", "l-old", "app-1", DID, "l-old", null));
  await rows.claim(envRow("env-unrecorded", "l-unrecorded", "app-1", DID, "l-unrecorded", null));
  await rows.claim(envRow("env-app2", "l-app2", "app-2", DID, "l-app2", null));
  await grants.addToAllowList("app-1", DID, NOW);
}

beforeAll(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  s = spies();
  app1 = freshApp1();
  migrated = true;
  await seed();
});

describe("vetraLicensing (machine)", () => {
  it("derives the app from the caller, never from arguments", async () => {
    expect(await code(q("appLicenses", {}, { user: { address: "0x1", networkId: "eip155", chainId: 1 } }))).toBe("UNAUTHENTICATED");
    expect(await code(q("appLicenses", { appId: "app-2" }, caller("did:key:nobody")))).toBe("FORBIDDEN");
    const ids = ((await q("appLicenses", { appId: "app-2" }, asApp)) as { id: string }[]).map((l) => l.id);
    expect(ids).not.toContain("l-app2");
  });

  it("lists the app's licences from grant rows, with recorded status and the chain's environment", async () => {
    // Grant-row order: oldest first, then by id.
    const row = (id: string, user: string, kind: string, environmentId: string | null) =>
      ({ id, user, kind, status: "ACTIVE", start: null, end: null, environmentId });
    expect(await q("appLicenses", { status: "ACTIVE" }, asApp)).toStrictEqual([
      row("l-broken", DID, "broken", null),
      row("l-draft", DID, "draft", null),
      row("l-new", NEW_DID, "pro", null),
      row("l-shared", DID, "free", null),
      // Unrecorded: the document's status is all there is (display only).
      row("l-unrecorded", DID, "pro", "env-unrecorded"),
      row("l1", DID, "pro", "env-1"),
      // A renewal: the chain's environment, from license_environments.
      row("r1", DID, "pro", "env-r"),
    ]);
    const all = (await q("appLicenses", {}, asApp)) as { id: string; status: string }[];
    // The forged document (no grant row) is never listed; the lapsed one shows its recorded status.
    expect(all.map((l) => l.id)).not.toContain("l-forged");
    expect(all.find((l) => l.id === "l-lapsed")!.status).toBe("EXPIRED");
  });

  it("summarises terms with their template hash (null for a term without a template or on a SHARED one)", async () => {
    expect(await q("appTerms", {}, asApp)).toStrictEqual([
      { id: "k1", kind: "pro", status: "ACTIVE", templateHash: "h-ded" },
      { id: "k2", kind: "draft", status: "DRAFT", templateHash: null },
      { id: "k3", kind: "free", status: "ACTIVE", templateHash: null },
      { id: "k4", kind: "broken", status: "ACTIVE", templateHash: "h-broken" },
    ]);
    expect(await q("appTerms", {}, asApp2)).toStrictEqual([]);
  });

  it("answers hasLicense only for authorised ACTIVE licences of the calling app", async () => {
    expect(await q("hasLicense", { user: ADDR }, asApp)).toBe(true);
    expect(await q("hasLicense", { user: `did:pkh:eip155:137:${ADDR}` }, asApp)).toBe(true);
    expect(await q("hasLicense", { user: OTHER_DID }, asApp)).toBe(false); // holds app-2's licence only
    expect(await q("hasLicense", { user: OTHER_DID }, asApp2)).toBe(true);
    expect(await q("hasLicense", { user: FORGED_DID }, asApp)).toBe(false); // ACTIVE doc, no grant row
    expect(await q("hasLicense", { user: LAPSED_DID }, asApp)).toBe(false); // ACTIVE doc, recorded EXPIRED
    expect(await code(q("hasLicense", { user: "did:key:z" }, asApp))).toBe("UNSUPPORTED_DID");
  });

  it("lists environments from license_environments with chain fields", async () => {
    const envs = (await q("appUserEnvironments", {}, asApp)) as { environmentId: string }[];
    expect(envs.find((e) => e.environmentId === "env-1")).toStrictEqual({
      appId: "app-1", user: DID, environmentId: "env-1", licenseId: "l1", rootLicenseId: "l1",
      label: "Vault", templateHash: "h-ded", stoppedAt: null, deleteAfter: null,
    });
    expect(envs.map((e) => e.environmentId).sort()).toStrictEqual(["env-1", "env-old", "env-r", "env-unrecorded"]);
    expect(((await q("appUserEnvironments", {}, asApp2)) as unknown[]).length).toBe(1);
  });

  it("applyEnvironmentTemplate provisions the licence's chain; refuses a SHARED or foreign licence", async () => {
    expect(await m("applyEnvironmentTemplate", { input: { licenseId: "l1", label: "x" } }, asApp)).toMatchObject({ environmentId: "env-1" });
    expect(s.create).not.toHaveBeenCalled();
    expect(await code(m("applyEnvironmentTemplate", { input: { licenseId: "l-shared", label: "x" } }, asApp))).toBe("INVALID_INPUT");
    expect(await code(m("applyEnvironmentTemplate", { input: { licenseId: "l-app2", label: "x" } }, asApp))).toBe("NOT_FOUND");
  });

  it("a foreign, forged or missing licence fails exactly alike", async () => {
    const errors = await Promise.all(
      ["l-app2", "l-forged", "nope"].map(async (licenseId) => {
        try {
          await m("applyEnvironmentTemplate", { input: { licenseId, label: "x" } }, asApp);
          return null;
        } catch (e) {
          return { code: (e as GraphQLError).extensions?.code, message: (e as Error).message };
        }
      }),
    );
    expect(errors[0]).toStrictEqual({ code: "NOT_FOUND", message: "no such licence" });
    expect(errors[1]).toStrictEqual(errors[0]);
    expect(errors[2]).toStrictEqual(errors[0]);
  });

  it("creates a missing environment on the chain's row, owned by the grant's holder", async () => {
    const env = (await m("applyEnvironmentTemplate", { input: { licenseId: "l-new", label: "Mine" } }, asApp)) as Record<string, unknown>;
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(env).toMatchObject({ appId: "app-1", user: NEW_DID, licenseId: "l-new", rootLicenseId: "l-new", label: "Mine", templateHash: "h-ded" });
    expect(await db.selectFrom("license_environments").selectAll().where("root_license_id", "=", "l-new").execute()).toHaveLength(1);
  });

  it("lands a renewal on its chain's existing environment, never a second one", async () => {
    const env = await m("applyEnvironmentTemplate", { input: { licenseId: "r1", label: "x" } }, asApp);
    expect(env).toMatchObject({ environmentId: "env-r", licenseId: "r1", rootLicenseId: "r0" });
    expect(s.create).not.toHaveBeenCalled();
    expect(await db.selectFrom("license_environments").selectAll().where("app_id", "=", "app-1").execute()).toHaveLength(4);
  });

  it("never races the handler: a concurrent handler provision of the same chain creates one environment", async () => {
    // The handler's create is slow: without the chain lock the machine call
    // would find no row meanwhile and create a second environment.
    let openGate = () => {};
    const gate = new Promise<void>((r) => (openGate = r));
    let n = 0;
    s.create.mockImplementation(async () => {
      const id = `env-created-${++n}`;
      if (n === 1) await gate;
      return id;
    });
    const d = deps();
    const r = createResolvers(d) as unknown as Resolvers;
    const handlerTick = d.provision({
      appId: "app-1", root: "l-new", licenseId: "l-new", userDid: NEW_DID, templateId: "tpl-ded",
      template: TEMPLATE, templateHash: "h-ded", label: "pro", now: NOW,
    });
    const machineCall = r.VetraLicensingMutations.applyEnvironmentTemplate!({}, { input: { licenseId: "l-new", label: "Mine" } }, asApp);
    await new Promise((res) => setTimeout(res, 50));
    openGate();
    const [machine, handler] = await Promise.all([machineCall, handlerTick]);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect((machine as { environmentId: string }).environmentId).toBe(handler.environment_id);
  });

  it("refuses a licence that is not live, unrecorded, or whose kind does not resolve, with INVALID_INPUT", async () => {
    for (const licenseId of ["l-lapsed", "l-old", "r0", "l-unrecorded", "l-draft", "l-broken"]) {
      expect([licenseId, await code(m("applyEnvironmentTemplate", { input: { licenseId, label: "x" } }, asApp))]).toStrictEqual([licenseId, "INVALID_INPUT"]);
    }
    expect(s.create).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("refuses to provision from a tampered or unverified app", async () => {
    app1 = { ...freshApp1(), tampered: true, tamperReason: "licensing state changed outside Vetra" };
    expect(await code(m("applyEnvironmentTemplate", { input: { licenseId: "l-new", label: "x" } }, asApp))).toBe("INVALID_INPUT");
    app1 = { ...freshApp1(), unverified: true };
    expect(await code(m("applyEnvironmentTemplate", { input: { licenseId: "l-new", label: "x" } }, asApp))).toBe("INVALID_INPUT");
    expect(s.create).not.toHaveBeenCalled();
  });

  it("provisions nothing before the licensing migration has completed", async () => {
    migrated = false;
    const r = build();
    try {
      await m("applyEnvironmentTemplate", { input: { licenseId: "l-new", label: "x" } }, asApp, r);
      expect.unreachable();
    } catch (e) {
      expect((e as GraphQLError).extensions?.code).toBe("INVALID_INPUT");
      expect((e as Error).message).toMatch(/migration/);
    }
    expect(s.create).not.toHaveBeenCalled();
  });

  it("releaseEnvironment starts the offboarding clock for an ended chain instead of stopping it", async () => {
    expect(await m("releaseEnvironment", { input: { environmentId: "env-old" } }, asApp)).toBe(true);
    const row = await db.selectFrom("license_environments").selectAll().where("environment_id", "=", "env-old").executeTakeFirstOrThrow();
    expect(row.ended_at).toBe(NOW);
    expect(row.delete_after).toBe("2027-01-06T00:00:00.000Z");
    expect(row.stopped_at).toBeNull();
    expect(s.sleep).not.toHaveBeenCalled();
    expect(s.destroy).not.toHaveBeenCalled();
    // Idempotent: a repeat never moves the deletion date.
    expect(await m("releaseEnvironment", { input: { environmentId: "env-old" } }, asApp)).toBe(true);
  });

  it("releaseEnvironment returns false for a live, unrecorded, foreign or unknown chain and changes nothing", async () => {
    for (const [environmentId, ctx] of [
      ["env-1", asApp], // l1 is ACTIVE
      ["env-r", asApp], // r0 REPLACED, but r1 is live
      ["env-unrecorded", asApp], // no lifecycle record: unknown, never ended
      ["env-app2", asApp], // another app's
      ["env-old", asApp2], // another app's (ended)
      ["nope", asApp],
    ] as const) {
      expect([environmentId, await m("releaseEnvironment", { input: { environmentId } }, ctx)]).toStrictEqual([environmentId, false]);
    }
    const ended = await db.selectFrom("license_environments").select("environment_id").where("ended_at", "is not", null).execute();
    expect(ended).toStrictEqual([]);
  });

  it("issuePublisherGrant issues a kind for the calling app", async () => {
    expect(await m("issuePublisherGrant", { input: { kind: "pro", user: ADDR } }, asApp)).toBe("lic-new");
    expect(await createGrantStore(db).grantFor("lic-new")).toMatchObject({ appId: "app-1", userDid: DID, kind: "pro" });
    expect(await code(m("issuePublisherGrant", { input: { kind: "pro", user: OTHER_DID } }, asApp))).toBe("NOT_ON_ALLOW_LIST");
  });

  it("reportUserStat forwards the reporting token header to the relay (a stub until the relay exists)", async () => {
    const args = { user: DID, metric: "documents", value: 3 };
    expect(await m("reportUserStat", args, { headers: { [REPORTING_HEADER]: "tok" } })).toBe(false);
    expect(s.relay).toHaveBeenLastCalledWith("tok", args);
    expect(await m("reportUserStat", args, { headers: { [REPORTING_HEADER]: ["a", "b"] } })).toBe(false);
    expect(s.relay).toHaveBeenLastCalledWith(null, args);
    expect(await m("reportUserStat", args, {})).toBe(false);
    expect(s.relay).toHaveBeenLastCalledWith(null, args);
  });

  it("mutations refuse when licensing is disabled; reads keep working", async () => {
    expect(await code(disabledM("issuePublisherGrant", { input: { kind: "pro", user: ADDR } }, asApp))).toBe("LICENSING_DISABLED");
    expect(await code(disabledM("applyEnvironmentTemplate", { input: { licenseId: "l-new", label: "x" } }, asApp))).toBe("LICENSING_DISABLED");
    expect(await code(disabledM("releaseEnvironment", { input: { environmentId: "env-old" } }, asApp))).toBe("LICENSING_DISABLED");
    expect(s.createLicenseDocument).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
    const r = build({}, false);
    expect(await code(q("appTerms", {}, asApp, r))).toBe("OK");
    // Authentication comes first: a stranger learns nothing about the switch.
    expect(await code(disabledM("issuePublisherGrant", { input: { kind: "pro", user: ADDR } }, {}))).toBe("UNAUTHENTICATED");
  });
});
