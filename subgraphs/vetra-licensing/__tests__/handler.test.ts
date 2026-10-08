import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLicenseHandler, type HandlerDeps } from "../handler.js";
import { loadLicensingConfig } from "../config.js";
import type { AppDocView } from "../app-reads.js";
import type { GrantProvenance } from "../grants.js";
import type { LicenceRecord } from "../reads.js";
import type { LicenseEnvironments } from "../db/schema.js";

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

function harness(over: Partial<HandlerDeps> = {}, licences: LicenceRecord[] = [lic("l1")]) {
  const provisioned: string[] = [];
  const staged: [string, string][] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: HandlerDeps = {
    licences: vi.fn(async () => licences),
    chainRoots: async () => new Map(),
    grants: async () => grantsFor(licences),
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
    expect(h.deps.afterApp).toHaveBeenCalledWith("app-1", []);
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
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("dry run: app app-1 would provision 1"));
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
    warned(h, "provision for app app-1 failed: Error: cap");
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
});
