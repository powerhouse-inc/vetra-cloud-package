import { describe, expect, it, vi } from "vitest";
import { leaveToInstances } from "../plan-kinds.js";
import type { PlanLicence } from "../chain-plan.js";
import { AppLicenseHandler, type HandlerDeps } from "../handler.js";
import { loadLicensingConfig } from "../config.js";
import type { AppDocView } from "../app-reads.js";
import type { GrantProvenance } from "../grants.js";
import type { LicenceRecord } from "../reads.js";
import type { LicenseEnvironments } from "../db/schema.js";
import type { LifecycleRecord } from "../lifecycle.js";

const lic = (id: string, kind: string | null, root = id): PlanLicence => ({
  id,
  user: "did:pkh:eip155:1:0x1",
  kind,
  status: "ACTIVE",
  issued: "2026-11-01T00:00:00.000Z",
  stage: null,
  root,
  authorised: true,
  replacedBy: null,
});

describe("leaveToInstances", () => {
  it("drops whole chains of plan kinds without a licensed environment, and nothing else", () => {
    const licences = [
      lic("a1", "basic"),
      lic("a2", "pro", "a1"), // upgraded into a plan kind: the chain goes to instances
      lic("b1", "pro"), // has a licensed environment: stays with licensing
      lic("c1", "dedicated"),
      lic("d1", null),
    ];
    expect(
      leaveToInstances(licences, new Set(["pro"]), new Set(["b1"])).map(
        (l) => l.id,
      ),
    ).toEqual(["b1", "c1", "d1"]);
    expect(leaveToInstances(licences, new Set(), new Set())).toBe(licences);
  });
});

// --- The handler: licensed environments (Sektar today) are untouched. ---

const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
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
  templates: [tpl("ded", "DEDICATED"), tpl("sh", "SHARED")],
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
    {
      id: "b",
      kind: "free",
      label: null,
      templateId: "sh",
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

/** A Sektar-like App: every chain has a licensed environment, one has ended, one is renewed. */
const LICENCES = [
  record("l1", { stage: "e1" }),
  record("l2", { status: "EXPIRED", stage: "e2" }),
  record("l3", { status: "REPLACED", replacedBy: "l3b", stage: "e3" }),
  record("l3b", { stage: "e3" }),
  record("l4", { kind: "free", stage: "sh-env" }),
  record("l5", { stage: null }), // a licensed environment not yet bound
];
const ROOTS = new Map([["l3b", "l3"]]);
const ENVS = [
  envRow({ environment_id: "e1", root_license_id: "l1", license_id: "l1" }),
  envRow({ environment_id: "e2", root_license_id: "l2", license_id: "l2" }),
  envRow({ environment_id: "e3", root_license_id: "l3", license_id: "l3" }),
  envRow({
    environment_id: "e5",
    root_license_id: "l5",
    license_id: "l5",
    template_hash: "h-old",
  }),
];

function run(licences: LicenceRecord[], over: Partial<HandlerDeps> = {}) {
  const calls: unknown[] = [];
  const note =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const logger = {
    info: vi.fn((m: string) => calls.push(["info", m])),
    warn: vi.fn((m: string) => calls.push(["warn", m])),
    error: vi.fn((m: string) => calls.push(["error", m])),
  };
  const deps: HandlerDeps = {
    licences: async () => licences,
    chainRoots: async () => ROOTS,
    grants: async () =>
      new Map<string, GrantProvenance>(
        licences.map((l) => [
          l.id,
          { appId: "app-1", userAddress: ADDR, kind: l.kind },
        ]),
      ),
    lifecycle: async () =>
      new Map<string, LifecycleRecord>(
        licences.map((l) => [
          l.id,
          { status: l.status, replacedBy: l.replacedBy },
        ]),
      ),
    chainLabel: async () => "Project A",
    app: async (id) => (id === "app-1" ? APP : null),
    environments: async () => ENVS,
    environmentAppIds: async () => ["app-1"],
    provision: async (input) => {
      calls.push(["provision", { ...input, now: undefined }]);
      return { environment_id: `env-${input.root}` } as LicenseEnvironments;
    },
    setStage: note("setStage"),
    onEnded: note("onEnded"),
    onResumed: note("onResumed"),
    afterApp: async (appId, environments, ended) => {
      calls.push(["afterApp", appId, environments, [...ended].sort()]);
    },
    migrationComplete: async () => true,
    cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false },
    logger,
    now: () => "2026-10-08T00:00:00.000Z",
    ...over,
  };
  return { calls, handler: new AppLicenseHandler(deps) };
}

const outputOf = async (
  licences: LicenceRecord[],
  over: Partial<HandlerDeps> = {},
) => {
  const r = run(licences, over);
  await r.handler.reconcileOnce();
  await r.handler.reconcileOnce();
  return r.calls;
};

describe("AppLicenseHandler with plan kinds", () => {
  it("leaves a Sektar-like App (licensed environments, no plans) exactly as before", async () => {
    const before = await outputOf(LICENCES);
    expect(before.length).toBeGreaterThan(0);
    expect(before).toContainEqual(["onEnded", "app-1", "e2"]);
    expect(
      await outputOf(LICENCES, { planKinds: async () => new Set() }),
    ).toEqual(before);
    // Plans of kinds nobody holds (createPlan refuses an issued kind), and even
    // a plan of "pro": every "pro" chain has a licensed environment.
    expect(
      await outputOf(LICENCES, {
        planKinds: async () => new Set(["pro", "enterprise"]),
      }),
    ).toEqual(before);
  });

  it("leaves a plan kind's chain without a licensed environment to instances, and still provisions the others", async () => {
    const licences = [
      ...LICENCES,
      record("p1", { kind: "pro" }),
      record("f1", { kind: "free" }),
    ];
    const without = await outputOf(licences);
    const provisioned = (calls: unknown[]) =>
      calls
        .filter((c) => (c as unknown[])[0] === "provision")
        .map((c) => ((c as unknown[])[1] as { root: string }).root);
    expect(provisioned(without)).toContain("p1");
    const withPlans = await outputOf(licences, {
      planKinds: async () => new Set(["pro"]),
    });
    expect(provisioned(withPlans)).not.toContain("p1");
    // A shared kind no plan adopted is still staged by licensing.
    expect(withPlans).toContainEqual(["setStage", "f1", "env-app"]);
    expect(withPlans.filter((c) => JSON.stringify(c).includes('"p1"'))).toEqual(
      [],
    );
  });
});
