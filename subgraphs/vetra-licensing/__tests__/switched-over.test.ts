import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { up } from "../db/migrations.js";
import type { LicenseEnvironments, VetraLicensingDB } from "../db/schema.js";
import { AppLicenseHandler, type HandlerDeps } from "../handler.js";
import { loadLicensingConfig } from "../config.js";
import type { AppDocView } from "../app-reads.js";
import type { GrantProvenance } from "../grants.js";
import type { LicenceRecord } from "../reads.js";
import type { LifecycleRecord } from "../lifecycle.js";
import { createChainEnvironmentRows, isSwitchedOver } from "../environments.js";
import { createRolloutStore } from "../rollout-db.js";
import {
  setCanaryEnvironment,
  setReleasePolicy,
  type ReleaseServiceDeps,
} from "../release-service.js";
import { subscriptionFor } from "../subscriptions-resolvers.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const NOW = "2026-10-08T00:00:00.000Z";

const tpl = (id: string, mode: "SHARED" | "DEDICATED") => ({
  id,
  name: null,
  mode,
  sharedEnvironment: null,
  warmPoolSize: 0,
  templateHash: `h-${id}`,
  resolutionError: null,
  template: {
    services: [],
    packages: [],
    size: null,
    baseDomain: null,
    packageRegistry: null,
  },
});
const APP: AppDocView = {
  id: "app-1",
  name: "Sektar",
  slug: "sektar",
  owner: "0xo",
  status: "ACTIVE",
  identityDid: null,
  productionEnvironmentId: "env-app",
  artifacts: [],
  templates: [tpl("ded", "DEDICATED")],
  terms: [
    {
      id: "a",
      kind: "pro",
      label: "Pro",
      templateId: "ded",
      validityDays: null,
      issuers: ["PUBLISHER_GRANT"],
      status: "ACTIVE",
    },
  ],
  tampered: false,
  tamperReason: null,
  licensingStateHash: "x",
  unverified: false,
};
const record = (
  id: string,
  over: Partial<LicenceRecord> = {},
): LicenceRecord => ({
  id,
  app: "app-1",
  user: DID,
  kind: "pro",
  issuer: "PUBLISHER_GRANT",
  status: "ACTIVE",
  issued: "2026-10-01T00:00:00.000Z",
  start: null,
  end: null,
  stage: null,
  details: null,
  replacedBy: null,
  legacyLicenseTypeId: null,
  ...over,
});
const envRow = (over: Partial<LicenseEnvironments>): LicenseEnvironments => ({
  environment_id: "e1",
  root_license_id: "l1",
  app_id: "app-1",
  user_did: DID,
  license_id: "l1",
  template_id: "ded",
  label: null,
  template_hash: "h-ded",
  ended_at: null,
  stopped_at: null,
  delete_after: null,
  created_at: "t",
  updated_at: "t",
  ...over,
});

/**
 * l1: switched over, licence EXPIRED (would be ended by licensing).
 * l2: switched over, licence live, template changed since (would be re-templated).
 * l3: an ordinary live licensed environment, template changed (re-templated).
 */
const LICENCES = [
  record("l1", { status: "EXPIRED", stage: "e1" }),
  record("l2", { stage: "e2" }),
  record("l3", { stage: "e3" }),
];
const SWITCHED = "2026-10-05T00:00:00.000Z";
const ENVS = [
  envRow({
    environment_id: "e1",
    root_license_id: "l1",
    license_id: "l1",
    switched_over_at: SWITCHED,
    switched_over_instance_id: "i1",
  }),
  envRow({
    environment_id: "e2",
    root_license_id: "l2",
    license_id: "l2",
    template_hash: "h-old",
    switched_over_at: SWITCHED,
    switched_over_instance_id: "i2",
  }),
  envRow({
    environment_id: "e3",
    root_license_id: "l3",
    license_id: "l3",
    template_hash: "h-old",
  }),
];

function run(over: Partial<HandlerDeps> = {}) {
  const calls: unknown[] = [];
  const note =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const deps: HandlerDeps = {
    licences: async () => LICENCES,
    chainRoots: async () => new Map(),
    grants: async () =>
      new Map<string, GrantProvenance>(
        LICENCES.map((l) => [
          l.id,
          { appId: "app-1", userAddress: ADDR, kind: l.kind },
        ]),
      ),
    lifecycle: async () =>
      new Map<string, LifecycleRecord>(
        LICENCES.map((l) => [
          l.id,
          { status: l.status, replacedBy: l.replacedBy },
        ]),
      ),
    chainLabel: async () => "Project A",
    app: async (id) => (id === "app-1" ? APP : null),
    environments: async () => ENVS,
    environmentAppIds: async () => ["app-1"],
    provision: async (input) => {
      calls.push(["provision", input.root]);
      return { environment_id: `env-${input.root}` } as LicenseEnvironments;
    },
    setStage: note("setStage"),
    onEnded: note("onEnded"),
    onResumed: note("onResumed"),
    afterChains: async (_app, rows) => {
      calls.push(["afterChains", rows.map((r) => r.environment_id)]);
    },
    afterApp: async (appId, rows, ended) => {
      calls.push([
        "afterApp",
        appId,
        rows.map((r) => r.environment_id),
        [...ended].sort(),
      ]);
    },
    migrationComplete: async () => true,
    cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => NOW,
    ...over,
  };
  return { calls, handler: new AppLicenseHandler(deps) };
}

describe("the handler and switched-over rows", () => {
  it("neither provisions, stages nor ends a switched-over chain, and hides its row from the after-steps", async () => {
    const { calls, handler } = run();
    await handler.reconcileOnce();
    await handler.reconcileOnce();
    const flat = JSON.stringify(calls);
    // l1 (expired) is not ended; l2 (template changed) is not re-templated.
    expect(calls).not.toContainEqual(["onEnded", "app-1", "e1"]);
    expect(calls.filter((c) => (c as unknown[])[0] === "onEnded")).toEqual([]);
    expect(calls.filter((c) => (c as unknown[])[0] === "provision")).toEqual([
      ["provision", "l3"],
      ["provision", "l3"],
    ]);
    expect(flat).not.toContain('"l1"');
    expect(flat).not.toContain('"l2"');
    // Offboarding, release tracking, managedBy and token issue see only l3's row.
    expect(calls).toContainEqual(["afterChains", ["e3"]]);
    for (const c of calls.filter((x) => (x as unknown[])[0] === "afterApp"))
      expect((c as unknown[])[2]).toEqual(["e3"]);
  });

  it("does the same whether or not the kind was adopted by a plan", async () => {
    const { calls, handler } = run({ planKinds: async () => new Set(["pro"]) });
    await handler.reconcileOnce();
    expect(calls.filter((c) => (c as unknown[])[0] === "onEnded")).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain('"l1"');
  });

  it("without any switched-over row behaves as before (a live ended chain is ended)", async () => {
    const plain = ENVS.map((e) => ({
      ...e,
      switched_over_at: null,
      switched_over_instance_id: null,
    }));
    const { calls, handler } = run({ environments: async () => plain });
    await handler.reconcileOnce();
    await handler.reconcileOnce();
    expect(calls).toContainEqual(["onEnded", "app-1", "e1"]);
    expect(
      calls.filter((c) => (c as unknown[])[0] === "provision").length,
    ).toBeGreaterThan(0);
  });
});

describe("isSwitchedOver", () => {
  it("reads the column, absent or null being not switched over", () => {
    expect(isSwitchedOver({})).toBe(false);
    expect(isSwitchedOver({ switched_over_at: null })).toBe(false);
    expect(isSwitchedOver({ switched_over_at: SWITCHED })).toBe(true);
  });
});

describe("the row stays visible", () => {
  let db: Kysely<VetraLicensingDB>;
  beforeEach(async () => {
    db = new Kysely<VetraLicensingDB>({
      dialect: new PGliteDialect(new PGlite()),
    });
    await up(db as Kysely<any>);
    await db.insertInto("license_environments").values(ENVS).execute();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it("byEnvironment, byRoot and forApp still return it (the processor vouches through the table)", async () => {
    const rows = createChainEnvironmentRows(db, loadLicensingConfig({}));
    expect((await rows.byEnvironment("e1"))?.switched_over_at).toBe(SWITCHED);
    expect((await rows.byRoot("l1"))?.switched_over_instance_id).toBe("i1");
    expect((await rows.forApp("app-1")).map((r) => r.environment_id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
  });

  it("a switched-over canary is not a live canary", async () => {
    await db
      .updateTable("license_environments")
      .set({ channel_override: "STAGING" })
      .where("environment_id", "in", ["e1", "e3"])
      .execute();
    const deps = {
      store: createRolloutStore(db),
      envRows: createChainEnvironmentRows(db, loadLicensingConfig({})),
      apps: { app: async () => APP },
      appWriter: { appendLicensingOps: async () => {} },
      envState: async () => null,
      newId: () => "r1",
      now: () => NOW,
    } as unknown as ReleaseServiceDeps;
    // Only e3 counts: unmarking it leaves no canary, so a GATED app refuses.
    await setReleasePolicy(deps, { appId: "app-1", policy: "GATED" });
    await expect(
      setCanaryEnvironment(deps, {
        appId: "app-1",
        environmentId: "e3",
        canary: false,
        callerDid: DID,
      }),
    ).rejects.toThrow();
  });
});

describe("the holder's subscription", () => {
  const deps = (rows: LicenseEnvironments[], deleted = false) =>
    ({
      apps: { app: async () => APP },
      envRows: {
        byRoot: async (r: string) =>
          rows.find((x) => x.root_license_id === r) ?? null,
      },
      envState: async () => (deleted ? null : ({ services: [] } as never)),
      grants: { chainLabel: async () => "Project A" },
      now: () => NOW,
    }) as never;
  const licence = (id: string) =>
    ({ ...record(id), appId: "app-1", userDid: DID, endedAt: null }) as never;

  it("offers nothing to stop or delete on a switched-over environment, and no 'you deleted it' warning", async () => {
    const view = await subscriptionFor(deps(ENVS), licence("l2"), "l2");
    expect(view.environmentId).toBeNull();
    expect(view.warnings.map((w) => w.kind)).not.toContain(
      "ENVIRONMENT_DELETED",
    );
  });

  it("an ordinary environment is offered as before", async () => {
    const view = await subscriptionFor(deps(ENVS), licence("l3"), "l3");
    expect(view.environmentId).toBe("e3");
  });
});
