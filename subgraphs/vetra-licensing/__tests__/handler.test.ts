import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLicenseHandler, type HandlerDeps } from "../handler.js";
import { loadLicensingConfig } from "../config.js";
import type { AppDocView } from "../app-reads.js";
import type { GrantProvenance } from "../grants.js";
import type { LicenceRecord } from "../reads.js";
import type { LicenseEnvironments } from "../db/schema.js";
import { EnvironmentNotReadyError } from "../environments.js";
import type { LifecycleRecord } from "../lifecycle.js";
import { addDays, confirmedEndedRows, tickOffboarding, type OffboardingDeps } from "../offboarding.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDR}`;
const tpl = (id: string, mode: "SHARED" | "DEDICATED") => ({
  id, name: null, mode, sharedEnvironment: null, templateHash: `h-${id}`, resolutionError: null,
  template: { services: [], packages: [], size: null, baseDomain: null, packageRegistry: null },
});
const APP: AppDocView = {
  id: "app-1", name: "KV", slug: "kv", owner: "0xo", status: "ACTIVE", identityDid: null,
  productionEnvironmentId: "env-app", artifacts: [],
  templates: [tpl("ded", "DEDICATED"), tpl("sh", "SHARED")],
  terms: [
    { id: "a", kind: "pro", label: "Pro", templateId: "ded", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
    { id: "b", kind: "free", label: null, templateId: "sh", validityDays: null, issuers: ["PUBLISHER_GRANT"], status: "ACTIVE" },
  ],
  tampered: false, tamperReason: null, licensingStateHash: "x", unverified: false,
};
const lic = (id: string, over: Partial<LicenceRecord> = {}): LicenceRecord => ({
  id, app: "app-1", user: DID, kind: "pro", issuer: "PUBLISHER_GRANT", status: "ACTIVE",
  issued: "2026-10-01T00:00:00.000Z", start: null, end: null, stage: null, details: null,
  replacedBy: null, legacyLicenseTypeId: null, ...over,
});
const envRow = (over: Partial<LicenseEnvironments>): LicenseEnvironments => ({
  environment_id: "e1", root_license_id: "l1", app_id: "app-1", user_did: DID, license_id: "l1",
  template_id: "ded", label: null, template_hash: "h-ded", ended_at: null, stopped_at: null,
  delete_after: null, created_at: "t", updated_at: "t", ...over,
});
/** Every licence granted as its document says: app-1, the holder, its kind. */
const grantsFor = (licences: LicenceRecord[]) =>
  new Map<string, GrantProvenance>(licences.map((l) => [l.id, { appId: "app-1", userAddress: ADDR, kind: l.kind }]));

/** The lifecycle the system recorded, agreeing with every licence document. */
const lifecycleFor = (licences: LicenceRecord[]) =>
  new Map<string, LifecycleRecord>(licences.map((l) => [l.id, { status: l.status, replacedBy: l.replacedBy }]));

function harness(over: Partial<HandlerDeps> = {}, licences: LicenceRecord[] = [lic("l1")]) {
  const provisioned: string[] = [];
  const staged: [string, string][] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: HandlerDeps = {
    licences: vi.fn(async () => licences),
    chainRoots: async () => new Map(),
    grants: async () => grantsFor(licences),
    lifecycle: async () => lifecycleFor(licences),
    chainLabel: async () => "Project A",
    app: async (id) => (id === "app-1" ? APP : null),
    environments: async () => [],
    environmentAppIds: async () => [],
    provision: vi.fn(async (input) => {
      provisioned.push(input.root);
      return { environment_id: `env-${input.root}` } as LicenseEnvironments;
    }),
    setStage: vi.fn(async (licenseId, stage) => { staged.push([licenseId, stage]); }),
    onEnded: vi.fn(async () => {}),
    onResumed: vi.fn(async () => {}),
    afterApp: vi.fn(async () => {}),
    migrationComplete: async () => true,
    cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false },
    logger,
    now: () => "2026-10-08T00:00:00.000Z",
    ...over,
  };
  return { deps, provisioned, staged, logger, handler: new AppLicenseHandler(deps) };
}
const warned = (h: ReturnType<typeof harness>, text: string) =>
  expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining(text));

describe("AppLicenseHandler", () => {
  it("does nothing until the migration reports complete", async () => {
    const h = harness({ migrationComplete: async () => false });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([]);
    expect(h.deps.licences).not.toHaveBeenCalled();
    expect(h.deps.onEnded).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("waiting for the licensing migration"));
  });

  it("does nothing when disabled", async () => {
    const h = harness({ cfg: { ...loadLicensingConfig({}), enabled: false } });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.deps.licences).not.toHaveBeenCalled();
  });

  it("provisions a DEDICATED chain with the chain's project label, then binds the stage", async () => {
    const h = harness();
    await h.handler.reconcileOnce();
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-1", root: "l1", licenseId: "l1", userDid: DID, templateId: "ded", templateHash: "h-ded", label: "Project A", now: "2026-10-08T00:00:00.000Z" }));
    expect(h.staged).toStrictEqual([["l1", "env-l1"]]);
    expect(h.deps.afterApp).toHaveBeenCalledWith("app-1", [], new Set());
  });

  it("does not rebind a stage that already points at the environment", async () => {
    const h = harness({}, [lic("l1", { stage: "env-l1" })]);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual(["l1"]);
    expect(h.staged).toStrictEqual([]);
  });

  it("falls back to the term label when the chain has none", async () => {
    const h = harness({ chainLabel: async () => null });
    await h.handler.reconcileOnce();
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ label: "Pro" }));
  });

  it("SHARED never provisions: it binds the stage to the App Environment", async () => {
    const h = harness({}, [lic("l1", { kind: "free" })]);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([["l1", "env-app"]]);
  });

  it("only logs in dry run", async () => {
    const h = harness({ cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: true } });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([]);
    expect(h.deps.afterApp).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("dry run: app app-1 would create 1, retemplate 0, repoint 0, set-stage 0"));
  });

  it("holds everything of an app whose document cannot be read", async () => {
    const h = harness({ app: async () => null });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    warned(h, "app app-1 has no readable document; holding");
  });

  it("holds everything of a tampered app, and logs it as an error", async () => {
    const env = envRow({ root_license_id: "gone", license_id: "gone" });
    const licences = [lic("l1"), lic("gone", { status: "EXPIRED" })];
    const h = harness({
      app: async () => ({ ...APP, tampered: true, tamperReason: "licensing state changed outside Vetra" }),
      environments: async () => [env],
    }, licences);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([]);
    expect(h.deps.onEnded).not.toHaveBeenCalled();
    expect(h.deps.afterApp).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("app app-1 is TAMPERED (licensing state changed outside Vetra)"));
    warned(h, "holding chain gone of app app-1: app is tampered");
  });

  it("holds an unverified app (no ledger row) once the migration is complete", async () => {
    const h = harness({ app: async () => ({ ...APP, unverified: true }) });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.deps.afterApp).not.toHaveBeenCalled();
    warned(h, "unverified");
  });

  it("an app that cannot be read does not stop the others", async () => {
    const licences = [lic("l1"), lic("x1", { app: "app-x" })];
    const grants = grantsFor(licences);
    grants.set("x1", { appId: "app-x", userAddress: ADDR, kind: "pro" });
    const h = harness({
      grants: async () => grants,
      app: async (id) => { if (id === "app-x") throw new Error("relationships unavailable"); return APP; },
    }, licences);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual(["l1"]);
    warned(h, "reconcile of app app-x failed: Error: relationships unavailable");
  });

  it("maps a legacy 0x holder to its DID and holds an unparseable one", async () => {
    const licences = [lic("l1", { user: ADDR }), lic("l2", { user: "garbage" })];
    const h = harness({}, licences);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual(["l1"]);
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ userDid: DID }));
    warned(h, "licence l2 has an unusable holder garbage");
  });

  it("an unparseable holder in a chain with an environment holds it instead of ending it", async () => {
    const env = envRow({ environment_id: "e1", root_license_id: "l1", license_id: "l1" });
    const licences = [lic("l1", { status: "EXPIRED" }), lic("l2", { user: "garbage" })];
    const h = harness({
      chainRoots: async () => new Map([["l2", "l1"]]),
      environments: async () => [env],
    }, licences);
    await h.handler.reconcileOnce();
    expect(h.deps.onEnded).not.toHaveBeenCalled();
    warned(h, "holding chain l1 of app app-1: ACTIVE licence without provenance");
  });

  describe("provenance comes from the grant row, never the licence document", () => {
    it("never provisions a licence without a grant row", async () => {
      const h = harness({ grants: async () => new Map() });
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
    });

    it("refuses a licence whose holder differs from the grant", async () => {
      const grants = new Map([["l1", { appId: "app-1", userAddress: "0x2222222222222222222222222222222222222222", kind: "pro" }]]);
      const h = harness({ grants: async () => grants });
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
      warned(h, "licence l1 names holder did:pkh:eip155:1:0x1111111111111111111111111111111111111111 but was granted to did:pkh:eip155:1:0x2222");
    });

    it("refuses a licence whose kind differs from the grant", async () => {
      const grants = new Map([["l1", { appId: "app-1", userAddress: ADDR, kind: "free" }]]);
      const h = harness({ grants: async () => grants });
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
      warned(h, "licence l1 carries kind pro but was granted kind free");
    });

    it("accepts any kind on a legacy grant that recorded none", async () => {
      const grants = new Map([["l1", { appId: "app-1", userAddress: ADDR, kind: null }]]);
      const h = harness({ grants: async () => grants });
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual(["l1"]);
    });

    it("plans a licence under its grant's app and holds the chain when the document claims another", async () => {
      const env = envRow({});
      const grants = new Map([["l1", { appId: "app-1", userAddress: ADDR, kind: "pro" }]]);
      const h = harness({
        grants: async () => grants,
        environments: async (appId) => (appId === "app-1" ? [env] : []),
      }, [lic("l1", { app: "app-2" })]);
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
      expect(h.deps.onEnded).not.toHaveBeenCalled();
      warned(h, "licence l1 claims app app-2 but was granted for app app-1");
      warned(h, "holding chain l1 of app app-1: ACTIVE licence without provenance");
    });

    it("holds a chain whose authorised member could not be read, rather than ending it", async () => {
      const env = envRow({});
      const licences = [lic("l1", { status: "EXPIRED" })];
      const grants = grantsFor(licences);
      grants.set("l2", { appId: "app-1", userAddress: ADDR, kind: "pro" });
      const h = harness({
        grants: async () => grants,
        chainRoots: async () => new Map([["l2", "l1"]]),
        environments: async () => [env],
      }, licences);
      await h.handler.reconcileOnce();
      expect(h.deps.onEnded).not.toHaveBeenCalled();
      warned(h, "holding chain l1 of app app-1: licence l2 has provenance but its document could not be read");
    });

    it("holds a set-stage of such a chain too, and leaves other chains alone", async () => {
      const env = envRow({});
      const licences = [lic("l1"), lic("m1")];
      const grants = grantsFor(licences);
      grants.set("l0", { appId: "app-1", userAddress: ADDR, kind: "pro" });
      const h = harness({
        grants: async () => grants,
        chainRoots: async () => new Map([["l0", "l1"]]),
        environments: async () => [env],
      }, licences);
      await h.handler.reconcileOnce();
      expect(h.staged).toStrictEqual([["m1", "env-m1"]]);
      expect(h.provisioned).toStrictEqual(["m1"]);
    });
  });

  it("passes issued in canonical ISO form, falling back to start, so the newest ACTIVE serves", async () => {
    const licences = [
      lic("l1", { issued: "2026-10-02T00:00:00Z" }),
      lic("l2", { issued: null, start: "2026-10-03T00:00:00+02:00" }),
      lic("l3", { issued: "not a date" }),
    ];
    const h = harness({ chainRoots: async () => new Map([["l2", "l1"], ["l3", "l1"]]) }, licences);
    await h.handler.reconcileOnce();
    expect(h.deps.provision).toHaveBeenCalledTimes(1);
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ root: "l1", licenseId: "l2" }));
  });

  it("logs anomalies and never acts on them", async () => {
    const env = envRow({ license_id: "l1", template_hash: "h-ded" });
    const licences = [lic("l1", { stage: "e1" }), lic("l2", { issued: "2026-10-05T00:00:00.000Z" })];
    const grants = grantsFor([licences[0]!]);
    const h = harness({
      grants: async () => grants,
      chainRoots: async () => new Map([["l2", "l1"]]),
      environments: async () => [env],
    }, licences);
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([]);
    warned(h, "chain l1 of app app-1: ACTIVE licence l2 has no provenance; serving l1");
  });

  it("one failing apply does not stop the others", async () => {
    const h = harness({ provision: vi.fn(async (i) => { if (i.root === "l1") throw new Error("cap"); return { environment_id: "env-l2" } as LicenseEnvironments; }) }, [lic("l1"), lic("l2")]);
    await h.handler.reconcileOnce();
    expect(h.staged).toStrictEqual([["l2", "env-l2"]]);
    warned(h, "provision of l1 for app app-1 failed: Error: cap");
    expect(h.deps.afterApp).toHaveBeenCalled();
  });

  it("visits apps that only have environments left, and reports ended chains", async () => {
    const env = envRow({ environment_id: "e1", root_license_id: "gone", license_id: "gone", template_hash: "h" });
    const h = harness({ environmentAppIds: async () => ["app-1"], environments: async () => [env] }, [lic("gone", { status: "EXPIRED" })]);
    await h.handler.reconcileOnce();
    expect(h.deps.onEnded).toHaveBeenCalledWith("app-1", "e1");
  });

  it("reports a resumed chain and re-provisions it", async () => {
    const env = envRow({ ended_at: "2026-10-01T00:00:00.000Z", license_id: "l0" });
    const h = harness({
      chainRoots: async () => new Map([["l2", "l1"]]),
      environments: async () => [env],
    }, [lic("l1", { status: "EXPIRED" }), lic("l2")]);
    await h.handler.reconcileOnce();
    expect(h.deps.onResumed).toHaveBeenCalledWith("app-1", "e1");
    expect(h.deps.provision).toHaveBeenCalledWith(expect.objectContaining({ root: "l1", licenseId: "l2" }));
  });

  it("binds the stage of a chain whose environment is already right", async () => {
    const env = envRow({});
    const h = harness({ environments: async () => [env] });
    await h.handler.reconcileOnce();
    expect(h.provisioned).toStrictEqual([]);
    expect(h.staged).toStrictEqual([["l1", "e1"]]);
  });

  describe("timer", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("ticks at once and on the interval, never overlapping, and stops", async () => {
      vi.useFakeTimers();
      let release: () => void = () => {};
      const migrationComplete = vi.fn(() => new Promise<boolean>((r) => { release = () => r(false); }));
      const h = harness({ migrationComplete, cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, scanIntervalMs: 1_000 } });
      h.handler.start();
      h.handler.start();
      expect(migrationComplete).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(migrationComplete).toHaveBeenCalledTimes(1); // the first tick is still running
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(migrationComplete).toHaveBeenCalledTimes(2);
      h.handler.stop();
      release();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(migrationComplete).toHaveBeenCalledTimes(2);
    });

    it("logs a failed tick", async () => {
      vi.useFakeTimers();
      const h = harness({ migrationComplete: async () => { throw new Error("db down"); } });
      h.handler.start();
      await vi.advanceTimersByTimeAsync(0);
      h.handler.stop();
      warned(h, "handler tick failed: Error: db down");
    });
  });

  describe("the lifecycle the system recorded is authoritative", () => {
    const ended = () => {
      const env = envRow({ environment_id: "e1", root_license_id: "l1", license_id: "l1" });
      return { environments: async () => [env], environmentAppIds: async () => ["app-1"] };
    };

    it("holds, with an error, a chain whose document says terminal while the system recorded it live", async () => {
      const lifecycle = new Map<string, LifecycleRecord>([["l1", { status: "ACTIVE", replacedBy: null }]]);
      const h = harness({ ...ended(), lifecycle: async () => lifecycle }, [lic("l1", { status: "REVOKED" })]);
      await h.handler.reconcileOnce();
      await h.handler.reconcileOnce();
      expect(h.deps.onEnded).not.toHaveBeenCalled();
      expect(h.logger.error).toHaveBeenCalledTimes(1);
      expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("licence l1: its document says REVOKED but the system recorded ACTIVE; holding chain l1"));
      warned(h, "holding chain l1 of app app-1: licence l1: its document says REVOKED");
    });

    it("ends a chain when the recorded lifecycle agrees", async () => {
      const lifecycle = new Map<string, LifecycleRecord>([["l1", { status: "REVOKED", replacedBy: null }]]);
      const h = harness({ ...ended(), lifecycle: async () => lifecycle }, [lic("l1", { status: "REVOKED" })]);
      await h.handler.reconcileOnce();
      expect(h.deps.onEnded).toHaveBeenCalledWith("app-1", "e1");
      expect(h.logger.error).not.toHaveBeenCalled();
    });

    it("holds, with an error, an authorised licence the system has no record of", async () => {
      const h = harness({ ...ended(), lifecycle: async () => new Map() }, [lic("l1", { status: "EXPIRED" })]);
      await h.handler.reconcileOnce();
      expect(h.deps.onEnded).not.toHaveBeenCalled();
      expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("licence l1: has no recorded lifecycle"));
    });

    it("does not need a record for a licence without provenance (it is held for that already)", async () => {
      const h = harness({ ...ended(), lifecycle: async () => new Map(), grants: async () => new Map() }, [lic("l1")]);
      await h.handler.reconcileOnce();
      expect(h.logger.error).not.toHaveBeenCalled();
      warned(h, "holding chain l1 of app app-1: ACTIVE licence without provenance");
    });

    it("holds a chain whose recorded successor differs from the document's", async () => {
      const lifecycle = new Map<string, LifecycleRecord>([
        ["l1", { status: "REPLACED", replacedBy: "l2" }],
        ["l3", { status: "ACTIVE", replacedBy: null }],
      ]);
      const licences = [lic("l1", { status: "REPLACED", replacedBy: "l3" }), lic("l3")];
      const h = harness({ ...ended(), lifecycle: async () => lifecycle, chainRoots: async () => new Map([["l3", "l1"]]) }, licences);
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
      expect(h.staged).toStrictEqual([]);
      expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("its document says replaced by l3 but the system recorded l2"));
    });

    it("holds a chain whose document is live while the system recorded it ended", async () => {
      const lifecycle = new Map<string, LifecycleRecord>([["l1", { status: "EXPIRED", replacedBy: null }]]);
      const h = harness({ lifecycle: async () => lifecycle });
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
    });
  });

  describe("re-templating is rate-limited; creation is not", () => {
    const stale = (n: number) => {
      const licences = Array.from({ length: n }, (_, i) => lic(`l${i}`, { stage: `e${i}` }));
      const envs = licences.map((l, i) => envRow({ environment_id: `e${i}`, root_license_id: l.id, license_id: l.id, template_hash: "old" }));
      return { licences, envs };
    };

    it("re-templates at most retemplatePerTick live environments per tick, across apps", async () => {
      const { licences, envs } = stale(3);
      const h = harness({
        environments: async () => envs,
        cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, retemplatePerTick: 2 },
      }, licences);
      await h.handler.reconcileOnce();
      expect(h.provisioned).toHaveLength(2);
      expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("1 environment re-template(s) deferred to later ticks (at most 2 per tick)"));
      // The budget is per tick, and the starting chain rotates: whoever was
      // deferred goes first next time.
      const deferred = ["l0", "l1", "l2"].find((r) => !h.provisioned.includes(r))!;
      await h.handler.reconcileOnce();
      expect(h.provisioned).toHaveLength(4);
      expect(h.provisioned.slice(2)).toContain(deferred);
    });

    it("does not spend the budget on creation, a repoint or a refusal that dispatched nothing", async () => {
      const { licences, envs } = stale(2);
      envs[0]!.template_hash = "h-ded"; // l0's environment is right: a repoint once the licence moves
      envs[0]!.license_id = "old-licence";
      const fresh = [lic("n0"), lic("n1"), lic("n2")];
      const provision = vi.fn(async (input: { root: string }) => {
        if (input.root === "l1") throw new EnvironmentNotReadyError("e1 is STOPPED");
        return { environment_id: `env-${input.root}` } as LicenseEnvironments;
      });
      const stuck = [...licences, lic("l2", { stage: "e2" })];
      const stuckEnvs = [...envs, envRow({ environment_id: "e2", root_license_id: "l2", license_id: "l2", template_hash: "old" })];
      const h = harness({
        environments: async () => stuckEnvs,
        provision,
        cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, retemplatePerTick: 1 },
      }, [...stuck, ...fresh]);
      await h.handler.reconcileOnce();
      expect(provision.mock.calls.map((c) => c[0].root).sort()).toStrictEqual(["l0", "l1", "l2", "n0", "n1", "n2"]);
    });

    it("pauses re-templating entirely at 0", async () => {
      const { licences, envs } = stale(1);
      const h = harness({ environments: async () => envs, cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, retemplatePerTick: 0 } }, licences);
      await h.handler.reconcileOnce();
      expect(h.provisioned).toStrictEqual([]);
    });

    it("dry run counts creations, re-templates and repoints separately", async () => {
      const { licences, envs } = stale(2);
      envs[1]!.template_hash = "h-ded";
      envs[1]!.license_id = "older";
      const unapplied = envRow({ environment_id: "e9", root_license_id: "l9", license_id: "l9", template_hash: "unapplied" });
      const h = harness({
        environments: async () => [...envs, unapplied],
        cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: true },
      }, [...licences, lic("l9"), lic("n0")]);
      await h.handler.reconcileOnce();
      expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("would create 2, retemplate 1, repoint 1"));
    });
  });

  describe("logs once per change", () => {
    it("logs a hold, a tampered app and a failing step once, and again only after they change or come back", async () => {
      const licences = [lic("l1", { kind: "nope" })];
      let app: AppDocView = APP;
      const env = envRow({});
      const h = harness({ app: async () => app, environments: async () => [env] }, licences);
      await h.handler.reconcileOnce();
      await h.handler.reconcileOnce();
      const holds = () => h.logger.warn.mock.calls.filter((c) => String(c[0]).includes("holding chain l1")).length;
      expect(holds()).toBe(1);

      app = { ...APP, tampered: true, tamperReason: "x" };
      await h.handler.reconcileOnce();
      await h.handler.reconcileOnce();
      expect(h.logger.error).toHaveBeenCalledTimes(1);
      expect(holds()).toBe(2); // the reason changed to "app is tampered"

      app = APP;
      await h.handler.reconcileOnce(); // back to the kind hold
      app = { ...APP, tampered: true, tamperReason: "x" };
      await h.handler.reconcileOnce(); // resolved in between, so logged again
      expect(h.logger.error).toHaveBeenCalledTimes(2);
    });

    it("logs the dry-run summary only when it changes", async () => {
      const h = harness({ cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: true } });
      await h.handler.reconcileOnce();
      await h.handler.reconcileOnce();
      expect(h.logger.info.mock.calls.filter((c) => String(c[0]).includes("dry run"))).toHaveLength(1);
    });

    it("forgets nothing after an aborted tick", async () => {
      let fail = false;
      const h = harness({
        app: async () => ({ ...APP, tampered: true, tamperReason: "x" }),
        environmentAppIds: async () => { if (fail) throw new Error("db"); return []; },
      });
      await h.handler.reconcileOnce();
      fail = true;
      await expect(h.handler.reconcileOnce()).rejects.toThrow("db");
      fail = false;
      await h.handler.reconcileOnce();
      expect(h.logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe("a failing chain backs off", () => {
    it("skips a chain for 1, 2, 4, 8 and at most 16 ticks after consecutive failures, and resets on success", async () => {
      const attempts: number[] = [];
      let tick = 0;
      let failing = true;
      const provision = vi.fn(async (input: { root: string }) => {
        if (input.root === "l1") {
          attempts.push(tick);
          if (failing) throw new Error("ENABLE_SERVICE rejected: PrefixInUseError");
        }
        return { environment_id: `env-${input.root}` } as LicenseEnvironments;
      });
      const h = harness({ provision }, [lic("l1"), lic("l2")]);
      for (tick = 1; tick <= 54; tick++) await h.handler.reconcileOnce();
      expect(attempts).toStrictEqual([1, 3, 6, 11, 20, 37, 54]);
      // The other chain is never held back.
      expect(provision.mock.calls.filter((c) => c[0].root === "l2")).toHaveLength(54);

      failing = false;
      for (tick = 55; tick <= 72; tick++) await h.handler.reconcileOnce();
      expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("chain l1 of app app-1 failed 7 time(s) in a row; retrying on tick 71"));
      // Retried on tick 71, succeeded, so the backoff reset: tried again on 72.
      expect(attempts.slice(7)).toStrictEqual([71, 72]);
    });

    it("a backed-off re-template does not take the budget from other chains", async () => {
      const licences = [lic("l0", { stage: "e0" }), lic("l1", { stage: "e1" })];
      const envs = licences.map((l, i) => envRow({ environment_id: `e${i}`, root_license_id: l.id, license_id: l.id, template_hash: "old" }));
      const provision = vi.fn(async (input: { root: string }) => {
        if (input.root === "l1") throw new Error("rejected");
        return { environment_id: `env-${input.root}` } as LicenseEnvironments;
      });
      const h = harness({
        environments: async () => envs,
        provision,
        cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, retemplatePerTick: 1 },
      }, licences);
      await h.handler.reconcileOnce(); // rotation: l1 first, fails and takes the budget
      await h.handler.reconcileOnce(); // l1 backed off: l0 gets it
      expect(provision.mock.calls.map((c) => c[0].root)).toStrictEqual(["l1", "l0"]);
    });
  });

  describe("a hung call cannot stall the handler", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("fails a step that does not settle within stepTimeoutMs and carries on", async () => {
      vi.useFakeTimers();
      // Chains rotate by tick: on the first tick l2 goes first.
      const provision = vi.fn((input: { root: string }) =>
        input.root === "l2"
          ? new Promise<LicenseEnvironments>(() => {})
          : Promise.resolve({ environment_id: `env-${input.root}` } as LicenseEnvironments));
      const h = harness({ provision, cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, stepTimeoutMs: 120_000 } }, [lic("l1"), lic("l2")]);
      const done = h.handler.reconcileOnce();
      await vi.advanceTimersByTimeAsync(119_999);
      expect(provision).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(h.staged).toStrictEqual([["l1", "env-l1"]]);
      warned(h, "provision of l2 for app app-1 failed: StepTimeoutError: provision of l2 (app app-1) timed out after 120000ms");
    });

    it("skips a chain whose timed-out step is still running until it settles", async () => {
      vi.useFakeTimers();
      let finish: () => void = () => {};
      let calls = 0;
      const provision = vi.fn(() => {
        calls++;
        return calls === 1
          ? new Promise<LicenseEnvironments>((r) => { finish = () => r({ environment_id: "env-l1" } as LicenseEnvironments); })
          : Promise.resolve({ environment_id: "env-l1" } as LicenseEnvironments);
      });
      const h = harness({ provision, cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, stepTimeoutMs: 1_000 } });
      const tick = async () => { const p = h.handler.reconcileOnce(); await vi.advanceTimersByTimeAsync(1_000); await p; };
      await tick(); // times out; backs off for tick 2
      await tick(); // backed off (and still running)
      await tick(); // backoff over, but still running: skipped
      expect(provision).toHaveBeenCalledTimes(1);
      expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("chain l1 of app app-1: a step from an earlier tick is still running; skipping"));
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await tick();
      expect(provision).toHaveBeenCalledTimes(2);
    });

    it("fails a tick whose reads hang, so the next tick runs", async () => {
      vi.useFakeTimers();
      let hang = true;
      const licences = vi.fn(() => (hang ? new Promise<LicenceRecord[]>(() => {}) : Promise.resolve([lic("l1")])));
      const h = harness({ licences, cfg: { ...loadLicensingConfig({}), enabled: true, dryRun: false, scanIntervalMs: 200_000, stepTimeoutMs: 1_000 } });
      h.handler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      warned(h, "handler tick failed: StepTimeoutError: licence reads timed out after 1000ms");
      hang = false;
      await vi.advanceTimersByTimeAsync(200_000);
      h.handler.stop();
      expect(h.provisioned).toStrictEqual(["l1"]);
    });
  });

  describe("offboarding clock only runs for chains confirmed ended this tick", () => {
    const END = "2026-10-01T00:00:00.000Z";
    const DEL = addDays(END, 90);
    function clock(initial: LicenseEnvironments, over: Partial<HandlerDeps> = {}, licences: LicenceRecord[] = [lic("l1", { status: "EXPIRED" })]) {
      const rowsState = new Map<string, LicenseEnvironments>([[initial.environment_id, initial]]);
      const nowRef = { v: END };
      const sleep = vi.fn(async () => {});
      const destroy = vi.fn(async () => {});
      const off = {
        rows: {
          byEnvironment: async (id: string) => rowsState.get(id) ?? null,
          update: async (id: string, patch: Partial<LicenseEnvironments>) => { rowsState.set(id, { ...rowsState.get(id)!, ...patch }); },
          remove: async (id: string) => { rowsState.delete(id); },
        },
        envStatus: async () => "READY", sleep, wake: vi.fn(async () => {}), destroy,
        cfg: { destroyEnabled: true }, logger: { info: vi.fn(), warn: vi.fn() }, now: () => nowRef.v,
      } as unknown as OffboardingDeps;
      const h = harness({
        environmentAppIds: async () => ["app-1"],
        environments: async () => [...rowsState.values()],
        afterApp: async (_a, rows, confirmed) => tickOffboarding(off, confirmedEndedRows(rows, confirmed)),
        ...over,
      }, licences);
      return { h, sleep, destroy, nowRef, rowsState };
    }
    const ended = (over: Partial<LicenseEnvironments> = {}) =>
      envRow({ ended_at: END, delete_after: DEL, ...over });

    it("stops a confirmed-ended chain at day 14", async () => {
      const c = clock(ended());
      c.nowRef.v = addDays(END, 14);
      await c.h.handler.reconcileOnce();
      expect(c.sleep).toHaveBeenCalledWith("e1");
      expect(c.rowsState.get("e1")!.stopped_at).toBe(addDays(END, 14));
    });

    it("freezes a renewed chain that is held (lifecycle disagrees): no stop at day 14, no destroy at day 90", async () => {
      const licences = [lic("l1", { status: "EXPIRED" }), lic("l2")];
      const c = clock(ended(), {
        chainRoots: async () => new Map([["l2", "l1"]]),
        // the DB says l2 is already terminal while its document claims ACTIVE
        lifecycle: async () => new Map<string, LifecycleRecord>([["l1", { status: "EXPIRED", replacedBy: null }], ["l2", { status: "EXPIRED", replacedBy: null }]]),
      }, licences);
      c.nowRef.v = addDays(END, 14);
      await c.h.handler.reconcileOnce();
      c.nowRef.v = DEL;
      await c.h.handler.reconcileOnce();
      expect(c.sleep).not.toHaveBeenCalled();
      expect(c.destroy).not.toHaveBeenCalled();
      expect(c.rowsState.has("e1")).toBe(true);
      warned(c.h, "offboarding of environment e1 (chain l1) is frozen");
    });

    it("freezes a row whose chain root no longer matches any licence", async () => {
      const c = clock(ended({ root_license_id: "old" }));
      c.nowRef.v = DEL;
      await c.h.handler.reconcileOnce();
      expect(c.sleep).not.toHaveBeenCalled();
      expect(c.destroy).not.toHaveBeenCalled();
      warned(c.h, "frozen");
    });

    it("freezes a backed-off chain", async () => {
      const c = clock(envRow({ ended_at: null }), { onEnded: vi.fn(async () => { throw new Error("db down"); }) });
      await c.h.handler.reconcileOnce(); // onEnded fails: chain backs off
      c.rowsState.set("e1", ended()); // the row is ended by some other path
      c.nowRef.v = addDays(END, 14);
      await c.h.handler.reconcileOnce();
      expect(c.sleep).not.toHaveBeenCalled();
      warned(c.h, "frozen");
    });
  });
});
