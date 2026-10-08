import { describe, expect, it } from "vitest";
import { planChains, type PlanEnvironment, type PlanLicence, type PlanResolution } from "../chain-plan.js";

const U1 = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const U2 = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const L = (id: string, over: Partial<PlanLicence> = {}): PlanLicence => ({
  id, user: U1, kind: "pro", status: "ACTIVE", issued: "2026-10-01T00:00:00.000Z",
  stage: null, root: id, authorised: true, ...over,
});
const E = (environmentId: string, rootLicenseId: string, over: Partial<PlanEnvironment> = {}): PlanEnvironment => ({
  environmentId, rootLicenseId, licenseId: rootLicenseId, templateHash: "h-pro", endedAt: null, ...over,
});
const RES: Record<string, PlanResolution> = {
  pro: { ok: true, mode: "DEDICATED", templateId: "t-pro", templateHash: "h-pro", sharedStage: null, label: "Pro" },
  max: { ok: true, mode: "DEDICATED", templateId: "t-max", templateHash: "h-max", sharedStage: null, label: "Max" },
  free: { ok: true, mode: "SHARED", templateId: "t-free", templateHash: "h-free", sharedStage: "env-app", label: "Free" },
  freeNoEnv: { ok: true, mode: "SHARED", templateId: "t-free", templateHash: "h-free", sharedStage: null, label: "Free" },
};
const resolve = (k: string | null): PlanResolution => (k && RES[k]) || { ok: false, reason: `no term ${k}` };
const plan = (licences: PlanLicence[], environments: PlanEnvironment[] = []) => planChains({ licences, environments, resolve });

describe("planChains: the matrix", () => {
  it("single owner, SHARED: provisions nothing, binds the licence to the App Environment", () => {
    expect(plan([L("l1", { kind: "free" })])).toStrictEqual([{ kind: "set-stage", licenseId: "l1", stage: "env-app" }]);
  });
  it("multi owner, SHARED: many licences, one environment, no provisioning", () => {
    expect(plan([L("l1", { kind: "free" }), L("l2", { kind: "free", user: U2, stage: "env-app" })])).toStrictEqual([
      { kind: "set-stage", licenseId: "l1", stage: "env-app" },
    ]);
  });
  it("single owner, DEDICATED: one environment for the licence", () => {
    expect(plan([L("l1")])).toStrictEqual([
      { kind: "provision", root: "l1", licence: L("l1"), templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: null },
    ]);
  });
  it("multi environment: a second purchase by the same owner is a second environment", () => {
    const steps = plan([L("l1"), L("l2")]);
    expect(steps.filter((s) => s.kind === "provision").map((s) => s.kind === "provision" && s.root)).toStrictEqual(["l1", "l2"]);
  });
  it("multi owner, DEDICATED: one environment per licence", () => {
    expect(plan([L("l1"), L("l2", { user: U2 })], [E("e1", "l1", { licenseId: "l1" })]).map((s) => s.kind)).toStrictEqual(["set-stage", "provision"]);
  });
});

describe("planChains: chains", () => {
  it("is quiet when the environment matches and the stage is set", () => {
    expect(plan([L("l1", { stage: "e1" })], [E("e1", "l1")])).toStrictEqual([]);
  });
  it("upgrade re-templates the same environment", () => {
    const head = L("l2", { kind: "max", root: "l1", issued: "2026-10-05T00:00:00.000Z", stage: "e1" });
    expect(plan([L("l1", { status: "REPLACED", stage: "e1" }), head], [E("e1", "l1")])).toStrictEqual([
      { kind: "provision", root: "l1", licence: head, templateId: "t-max", templateHash: "h-max", label: "Max", environmentId: "e1" },
    ]);
  });
  it("a renewal on the same template only repoints the row", () => {
    const head = L("l2", { root: "l1", issued: "2026-10-05T00:00:00.000Z", stage: "e1" });
    const steps = plan([L("l1", { status: "EXPIRED" }), head], [E("e1", "l1")]);
    expect(steps).toStrictEqual([{ kind: "provision", root: "l1", licence: head, templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: "e1" }]);
  });
  it("two ACTIVE licences in one chain: the newest is the head, deterministically", () => {
    const a = L("la", { root: "r", issued: "2026-10-01T00:00:00.000Z", stage: "e1" });
    const b = L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z", stage: "e1" });
    const one = plan([a, b], [E("e1", "r", { licenseId: "la" })]);
    const two = plan([b, a], [E("e1", "r", { licenseId: "la" })]);
    expect(one).toStrictEqual(two);
    expect(one[0]).toMatchObject({ kind: "provision", licence: { id: "lb" } });
  });
  it("sets the stage of a head that points elsewhere", () => {
    expect(plan([L("l1", { stage: "wrong" })], [E("e1", "l1")])).toStrictEqual([{ kind: "set-stage", licenseId: "l1", stage: "e1" }]);
  });
  it("a SHARED term whose App Environment is unset binds nothing", () => {
    expect(plan([L("l1", { kind: "freeNoEnv" })])).toStrictEqual([]);
  });
});

describe("planChains: never release on doubt", () => {
  it("holds an environment whose head kind does not resolve", () => {
    expect(plan([L("l1", { kind: "gone" })], [E("e1", "l1")])).toStrictEqual([{ kind: "hold", root: "l1", reason: "no term gone" }]);
  });
  it("holds a chain whose head resolves to SHARED but which owns an environment", () => {
    expect(plan([L("l1", { kind: "free" })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "chain owns a DEDICATED environment but its head now resolves to SHARED" },
    ]);
  });
  it("holds an environment whose only ACTIVE licence has no provenance", () => {
    expect(plan([L("l1", { authorised: false })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "ACTIVE licence without provenance" },
    ]);
  });
  it("holds an environment whose licences could not be read", () => {
    expect(plan([], [E("e1", "l1")])).toStrictEqual([{ kind: "hold", root: "l1", reason: "no licence of this chain could be read" }]);
  });
  it("holds while the next licence is ISSUED but not yet ACTIVE", () => {
    expect(plan([L("l1", { status: "EXPIRED" }), L("l2", { status: "ISSUED", root: "l1" })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "licence issued but not yet active" },
    ]);
  });
  it("an unauthorised ACTIVE licence without an environment provisions nothing", () => {
    expect(plan([L("l1", { authorised: false })])).toStrictEqual([]);
  });
});

describe("planChains: ending and resuming", () => {
  it("reports a chain with no live licence as ended, once", () => {
    expect(plan([L("l1", { status: "EXPIRED" })], [E("e1", "l1")])).toStrictEqual([{ kind: "ended", root: "l1", environmentId: "e1" }]);
    expect(plan([L("l1", { status: "REVOKED" })], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([]);
  });
  it("an ended licence without an environment needs nothing (SHARED never ends anything)", () => {
    expect(plan([L("l1", { kind: "free", status: "EXPIRED" })])).toStrictEqual([]);
  });
  it("re-licensing an ended chain resumes its environment", () => {
    const head = L("l2", { root: "l1", stage: "e1", issued: "2026-10-09T00:00:00.000Z" });
    expect(plan([L("l1", { status: "EXPIRED" }), head], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([
      { kind: "resumed", root: "l1", environmentId: "e1" },
      { kind: "provision", root: "l1", licence: head, templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: "e1" },
    ]);
  });
});

describe("planChains: the head of a chain", () => {
  it("prefers the later issued, then the larger id, and treats a missing issued as oldest", () => {
    const env = [E("e1", "r", { licenseId: "lx" })];
    const cases: [PlanLicence[], string][] = [
      [[L("la", { root: "r", issued: "2026-10-01T00:00:00.000Z" }), L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z" })], "lb"],
      [[L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z" }), L("la", { root: "r", issued: "2026-10-03T00:00:00.000Z" })], "la"],
      [[L("la", { root: "r" }), L("lb", { root: "r" })], "lb"],
      [[L("lb", { root: "r" }), L("la", { root: "r" })], "lb"],
      [[L("la", { root: "r", issued: null }), L("lb", { root: "r", issued: null })], "lb"],
      [[L("lb", { root: "r", issued: "2026-10-01T00:00:00.000Z" }), L("la", { root: "r", issued: null })], "lb"],
      [[L("la", { root: "r", issued: null }), L("lb", { root: "r", issued: "2026-10-01T00:00:00.000Z" })], "lb"],
    ];
    for (const [chain, want] of cases) {
      const steps = plan(chain, env);
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ kind: "provision", root: "r", environmentId: "e1", licence: { id: want } });
    }
  });
  it("two ACTIVE licences of one chain without an environment provision ONE environment", () => {
    const steps = plan([L("la", { root: "r" }), L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z" })]);
    expect(steps).toStrictEqual([
      { kind: "provision", root: "r", licence: L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z" }), templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: null },
    ]);
  });
  it("is quiet when the environment already serves the newest of two ACTIVE licences", () => {
    const a = L("la", { root: "r", stage: "e1" });
    const b = L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z", stage: "e1" });
    expect(plan([a, b], [E("e1", "r", { licenseId: "lb" })])).toStrictEqual([]);
  });
  it("an unauthorised newer ACTIVE licence does not displace the authorised head", () => {
    const a = L("la", { root: "r", stage: "e1" });
    const b = L("lb", { root: "r", issued: "2026-10-02T00:00:00.000Z", authorised: false });
    expect(plan([a, b], [E("e1", "r", { licenseId: "la" })])).toStrictEqual([]);
  });
  it("serves the ACTIVE head while a successor is still ISSUED", () => {
    const head = L("l1", { stage: "e1" });
    expect(plan([head, L("l2", { status: "ISSUED", root: "l1", issued: "2026-10-09T00:00:00.000Z" })], [E("e1", "l1")])).toStrictEqual([]);
  });
  it("re-templates when only the template hash moved (a channel publish)", () => {
    const head = L("l1", { stage: "e1" });
    expect(plan([head], [E("e1", "l1", { templateHash: "h-old" })])).toStrictEqual([
      { kind: "provision", root: "l1", licence: head, templateId: "t-pro", templateHash: "h-pro", label: "Pro", environmentId: "e1" },
    ]);
  });
  it("plans chains in root order regardless of input order", () => {
    const one = plan([L("b"), L("a"), L("c", { kind: "free" })]);
    const two = plan([L("c", { kind: "free" }), L("a"), L("b")]);
    expect(one).toStrictEqual(two);
    expect(one.map((s) => (s.kind === "provision" ? s.root : s.kind === "set-stage" ? s.licenseId : ""))).toStrictEqual(["a", "b", "c"]);
  });
});

describe("planChains: more doubt is held", () => {
  it("holds a chain whose head kind does not resolve even without an environment", () => {
    expect(plan([L("l1", { kind: null })])).toStrictEqual([{ kind: "hold", root: "l1", reason: "no term null" }]);
  });
  it("holds rather than ends a chain that still has an unauthorised ACTIVE licence beside terminal ones", () => {
    expect(plan([L("l1", { status: "EXPIRED" }), L("l2", { root: "l1", authorised: false })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "ACTIVE licence without provenance" },
    ]);
  });
  it("holds an ended environment whose chain has only an unauthorised ACTIVE licence (no resume)", () => {
    expect(plan([L("l1", { authorised: false })], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "ACTIVE licence without provenance" },
    ]);
  });
  it("holds an ended environment whose head no longer resolves (no resume)", () => {
    expect(plan([L("l1", { kind: "gone" })], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "no term gone" },
    ]);
  });
  it("holds an ended environment whose head now resolves to SHARED (no resume)", () => {
    expect(plan([L("l1", { kind: "free" })], [E("e1", "l1", { endedAt: "t" })])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "chain owns a DEDICATED environment but its head now resolves to SHARED" },
    ]);
  });
  it("treats every terminal status as ended, and only those", () => {
    for (const status of ["EXPIRED", "REVOKED", "REPLACED"] as const) {
      expect(plan([L("l1", { status })], [E("e1", "l1")])).toStrictEqual([{ kind: "ended", root: "l1", environmentId: "e1" }]);
    }
    expect(plan([L("l1", { status: "ISSUED" })], [E("e1", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "licence issued but not yet active" },
    ]);
  });
  it("holds a chain that owns more than one environment", () => {
    expect(plan([L("l1", { stage: "e1" })], [E("e1", "l1"), E("e2", "l1")])).toStrictEqual([
      { kind: "hold", root: "l1", reason: "chain owns more than one environment (e1, e2)" },
    ]);
  });
});

describe("planChains: app integrity", () => {
  const withApp = (
    app: { tampered: boolean; tamperReason: string | null; unverified: boolean },
    licences: PlanLicence[],
    environments: PlanEnvironment[] = [],
    holdUnverified = false,
  ) => planChains({ licences, environments, resolve, app, holdUnverified });

  it("a tampered app holds every live chain: no provision, no stage, no end, no resume", () => {
    const app = { tampered: true, tamperReason: "licensing state changed outside Vetra", unverified: false };
    const reason = "app is tampered (licensing state changed outside Vetra): holding";
    expect(
      withApp(app, [
        L("a"),
        L("b", { kind: "free" }),
        L("c", { status: "EXPIRED" }),
        L("d", { status: "EXPIRED" }),
        L("e", { status: "ISSUED" }),
        L("f", { status: "EXPIRED" }),
      ], [E("ec", "c"), E("ef", "f", { endedAt: "t" }), E("eg", "g")]),
    ).toStrictEqual([
      { kind: "hold", root: "a", reason },
      { kind: "hold", root: "b", reason },
      { kind: "hold", root: "c", reason },
      { kind: "hold", root: "e", reason },
      { kind: "hold", root: "f", reason },
      { kind: "hold", root: "g", reason },
    ]);
  });
  it("a tampered app with no reason still holds", () => {
    expect(withApp({ tampered: true, tamperReason: null, unverified: true }, [L("a")])).toStrictEqual([
      { kind: "hold", root: "a", reason: "app is tampered (unknown): holding" },
    ]);
  });
  it("an unverified app plans normally by default (before the migration seeds the ledger)", () => {
    const app = { tampered: false, tamperReason: null, unverified: true };
    expect(withApp(app, [L("l1"), L("l2", { status: "EXPIRED" })], [E("e2", "l2")])).toStrictEqual(
      plan([L("l1"), L("l2", { status: "EXPIRED" })], [E("e2", "l2")]),
    );
  });
  it("an unverified app is held when the caller asks (after the migration completes)", () => {
    const app = { tampered: false, tamperReason: null, unverified: true };
    const reason = "app licensing state is unverified (no ledger row): holding";
    expect(withApp(app, [L("l1"), L("l2", { status: "EXPIRED" })], [E("e2", "l2")], true)).toStrictEqual([
      { kind: "hold", root: "l1", reason },
      { kind: "hold", root: "l2", reason },
    ]);
  });
  it("a verified, untampered app plans normally even with holdUnverified", () => {
    const app = { tampered: false, tamperReason: null, unverified: false };
    expect(withApp(app, [L("l1")], [], true)).toStrictEqual(plan([L("l1")]));
  });
});
