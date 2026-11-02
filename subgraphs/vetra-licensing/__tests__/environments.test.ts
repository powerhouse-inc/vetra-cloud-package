import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import type { Action } from "document-model";
import { up } from "../db/migrations.js";
import type { VetraLicensingDB } from "../db/schema.js";
import { loadLicensingConfig } from "../config.js";
import {
  AppEnvironmentCapReachedError, EnvironmentNotReadyError, EnvironmentOwnershipMismatchError,
  createChainEnvironmentRows, provisionChain, provisionChainExclusive, withChainLock,
  type ChainEnvDeps, type ProvisionChainInput,
} from "../environments.js";
import { UNAPPLIED_TEMPLATE_HASH } from "../environments.js";
import { createWarmPoolStore, type WarmPoolStore } from "../warm-pool-db.js";
import { renderCreateActions } from "../template.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const OTHER_DID = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const TEMPLATE = { services: [{ id: "s", type: "CONNECT", prefix: null }], packages: [], size: null, baseDomain: null, packageRegistry: null };
const input = (over: Partial<ProvisionChainInput> = {}): ProvisionChainInput => ({
  appId: "app-1", root: "l1", licenseId: "l1", userDid: DID, templateId: "t",
  template: TEMPLATE, templateHash: "h1", label: "My vault", now: "2026-10-08T00:00:00.000Z", ...over,
});

let db: Kysely<VetraLicensingDB>;
let deps: ChainEnvDeps;
let states: Map<string, { status: string } & Record<string, unknown>>;
let executed: { id: string; actions: Action[] }[];

beforeEach(async () => {
  db = new Kysely<VetraLicensingDB>({ dialect: new PGliteDialect(new PGlite()) });
  await up(db as Kysely<any>);
  states = new Map();
  executed = [];
  let n = 0;
  deps = {
    rows: createChainEnvironmentRows(db, { ...loadLicensingConfig({}), defaultMaxEnvironments: 2 }),
    envs: {
      create: vi.fn(async () => { const id = `env-${++n}`; states.set(id, { status: "DRAFT", packages: [], services: [] }); return id; }),
      execute: async (id, actions) => { executed.push({ id, actions }); states.get(id)!.status = "CHANGES_APPROVED"; return states.get(id); },
      getState: async (id) => (states.get(id) as never) ?? null,
      delete: vi.fn(async (id: string) => { states.delete(id); }),
    },
    generateSubdomain: (id) => `sub-${id}`,
  };
});
afterEach(async () => { await db.destroy(); });

describe("provisionChain", () => {
  it("creates one environment owned by the holder's address, labelled with the project", async () => {
    const row = await provisionChain(deps, input());
    expect(row).toMatchObject({ environment_id: "env-1", root_license_id: "l1", license_id: "l1", user_did: DID, template_id: "t", template_hash: "h1", label: "My vault" });
    const types = executed[0]!.actions.map((a) => a.type);
    expect(types).toContain("INITIALIZE");
    expect(executed[0]!.actions.find((a) => a.type === "SET_OWNER")!.input).toStrictEqual({ address: "0x1111111111111111111111111111111111111111" });
    expect(await deps.rows.byRoot("l1")).toMatchObject({ template_hash: "h1", license_id: "l1" });
  });

  it("is idempotent", async () => {
    await provisionChain(deps, input());
    await provisionChain(deps, input());
    expect(executed).toHaveLength(1);
  });

  it("repoints a renewed chain without dispatching anything", async () => {
    await provisionChain(deps, input());
    const row = await provisionChain(deps, input({ licenseId: "l2" }));
    expect(row.license_id).toBe("l2");
    expect(executed).toHaveLength(1);
    expect((await deps.rows.byRoot("l1"))!.license_id).toBe("l2");
  });

  it("re-templates the same environment on upgrade", async () => {
    await provisionChain(deps, input());
    const row = await provisionChain(deps, input({ licenseId: "l2", templateHash: "h2", templateId: "t2" }));
    expect(row).toMatchObject({ environment_id: "env-1", template_hash: "h2", template_id: "t2", license_id: "l2" });
    expect(executed.map((e) => e.id)).toStrictEqual(["env-1", "env-1"]);
    expect(executed[1]!.actions.map((a) => a.type)).not.toContain("INITIALIZE");
    expect(executed[1]!.actions.map((a) => a.type)).not.toContain("SET_OWNER");
  });

  it("re-templates as a floor: no label, nothing removed, and nothing dispatched when already met", async () => {
    await provisionChain(deps, input());
    const live = { status: "READY", label: "Renamed by holder", packages: [{ registry: "r", name: "@me/extra", version: "1.0.0" }], services: [{ type: "CONNECT", prefix: "connect", enabled: true, version: null }], fusion: null };
    states.set("env-1", live as never);
    // A template that only drops things: the floor is already met.
    const row = await provisionChain(deps, input({ templateHash: "h2", label: "Pro", template: { ...TEMPLATE, services: [] } }));
    expect(executed).toHaveLength(1);
    expect(row).toMatchObject({ template_hash: "h2", label: "My vault" });
    expect(await deps.rows.byRoot("l1")).toMatchObject({ template_hash: "h2", label: "My vault" });
    // A template that adds a service: only that, plus approval.
    await provisionChain(deps, input({ templateHash: "h3", label: "Pro", template: { ...TEMPLATE, services: [{ id: "s", type: "CONNECT", prefix: null }, { id: "w", type: "SWITCHBOARD", prefix: null }] } }));
    expect(executed[1]!.actions.map((a) => a.type)).toStrictEqual(["ENABLE_SERVICE", "APPROVE_CHANGES"]);
  });

  it("deletes its fresh document when the claim itself fails", async () => {
    deps.rows.claim = async () => { throw new Error("insert failed"); };
    await expect(provisionChain(deps, input())).rejects.toThrow("insert failed");
    expect(deps.envs.delete).toHaveBeenCalledWith("env-1");
    expect(states.size).toBe(0);
  });

  it("keeps the fresh document when the claim's INSERT committed but its read failed", async () => {
    const claim = deps.rows.claim;
    deps.rows.claim = async (row) => { await claim(row); throw new Error("connection reset"); };
    await expect(provisionChain(deps, input())).rejects.toThrow("connection reset");
    expect(deps.envs.delete).not.toHaveBeenCalled();
    expect((await deps.rows.byRoot("l1"))!.environment_id).toBe("env-1");
    deps.rows.claim = claim;
    // The next call finds the claim and initialises the same document.
    const row = await provisionChain(deps, input());
    expect(row.environment_id).toBe("env-1");
    expect(executed[0]!.actions.map((a) => a.type)).toContain("INITIALIZE");
  });

  it("keeps the fresh document when it cannot tell whether the claim references it", async () => {
    const error = vi.fn();
    deps.logger = { error };
    deps.rows.claim = async () => { throw new Error("insert failed"); };
    let reads = 0;
    deps.rows.byRoot = async () => { if (++reads === 1) return null; throw new Error("db down"); };
    await expect(provisionChain(deps, input())).rejects.toThrow("insert failed");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cannot be told; leaving the document"));
    expect(deps.envs.delete).not.toHaveBeenCalled();
  });

  it("logs when the fresh document of a failed claim cannot be deleted either", async () => {
    const error = vi.fn();
    deps.logger = { error };
    deps.rows.claim = async () => { throw new Error("insert failed"); };
    deps.envs.delete = async () => { throw new Error("reactor down"); };
    await expect(provisionChain(deps, input())).rejects.toThrow("insert failed");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("fresh environment env-1 could not be deleted"));
  });

  it("refuses to re-template a STOPPED environment until it is woken", async () => {
    await provisionChain(deps, input());
    states.get("env-1")!.status = "STOPPED";
    await expect(provisionChain(deps, input({ templateHash: "h2" }))).rejects.toBeInstanceOf(EnvironmentNotReadyError);
    expect(executed).toHaveLength(1);
  });

  it("refuses to act on a claimed environment whose document is gone", async () => {
    await provisionChain(deps, input());
    states.delete("env-1");
    await expect(provisionChain(deps, input({ templateHash: "h2" }))).rejects.toBeInstanceOf(EnvironmentNotReadyError);
    expect(executed).toHaveLength(1);
    expect(deps.envs.delete).not.toHaveBeenCalled();
  });

  it("enforces the per-app cap only on creation", async () => {
    await provisionChain(deps, input({ root: "a", licenseId: "a" }));
    await provisionChain(deps, input({ root: "b", licenseId: "b" }));
    await expect(provisionChain(deps, input({ root: "c", licenseId: "c" }))).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);
    await expect(provisionChain(deps, input({ root: "a", licenseId: "a2", templateHash: "h2" }))).resolves.toBeDefined();
  });

  it("a per-app limit row overrides the default ceiling", async () => {
    await db.insertInto("app_environment_limits").values({ app_id: "app-1", max_environments: 1 }).execute();
    await provisionChain(deps, input({ root: "a", licenseId: "a" }));
    await expect(provisionChain(deps, input({ root: "b", licenseId: "b" }))).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);
    expect(await deps.rows.countForApp("app-1")).toBe(1);
    expect(await deps.rows.maxForApp("app-2")).toBe(2);
  });

  it("a claim lost to a concurrent caller deletes its own document and adopts the winner", async () => {
    await deps.rows.claim({
      environment_id: "env-winner", root_license_id: "l1", app_id: "app-1", user_did: DID, license_id: "l1",
      template_id: "t", label: null, template_hash: "h1", ended_at: null, stopped_at: null, delete_after: null,
      created_at: "t", updated_at: "t",
    });
    const realByRoot = deps.rows.byRoot;
    deps.rows.byRoot = async () => null; // simulate the race: the read happened before the winner's insert
    const row = await provisionChain(deps, input());
    deps.rows.byRoot = realByRoot;
    expect(row.environment_id).toBe("env-winner");
    expect(deps.envs.delete).toHaveBeenCalledWith("env-1");
  });

  it("leaves an unapplied claim when the action list is rejected, and reuses it next time", async () => {
    const execute = deps.envs.execute;
    deps.envs.execute = async () => { throw new Error("SET_OWNER rejected: nope"); };
    await expect(provisionChain(deps, input())).rejects.toThrow("SET_OWNER rejected");
    expect((await deps.rows.byRoot("l1"))!.template_hash).toBe(UNAPPLIED_TEMPLATE_HASH);
    deps.envs.execute = execute;
    const row = await provisionChain(deps, input());
    expect(row.environment_id).toBe("env-1");
    expect(executed[0]!.actions.map((a) => a.type)).toContain("INITIALIZE");
    expect(states.size).toBe(1);
  });

  it("refuses a bad template before creating anything", async () => {
    await expect(provisionChain(deps, input({ template: { ...TEMPLATE, services: [{ id: "s", type: "CLINT", prefix: null }] } }))).rejects.toThrow();
    expect(states.size).toBe(0);
    expect(await deps.rows.byRoot("l1")).toBeNull();
  });

  it("never re-templates or repoints a chain's environment for a different holder or app", async () => {
    await provisionChain(deps, input());
    await expect(provisionChain(deps, input({ userDid: OTHER_DID, templateHash: "h2" }))).rejects.toBeInstanceOf(EnvironmentOwnershipMismatchError);
    await expect(provisionChain(deps, input({ userDid: OTHER_DID, licenseId: "l2" }))).rejects.toBeInstanceOf(EnvironmentOwnershipMismatchError);
    await expect(provisionChain(deps, input({ appId: "app-2", templateHash: "h2" }))).rejects.toBeInstanceOf(EnvironmentOwnershipMismatchError);
    expect(executed).toHaveLength(1);
    expect(await deps.rows.byRoot("l1")).toMatchObject({ license_id: "l1", template_hash: "h1" });
  });

  it("exposes the rows by environment and by app, and removes them", async () => {
    await provisionChain(deps, input({ root: "a", licenseId: "a" }));
    await provisionChain(deps, input({ appId: "app-2", root: "b", licenseId: "b" }));
    expect((await deps.rows.byEnvironment("env-1"))!.root_license_id).toBe("a");
    expect(await deps.rows.byEnvironment("nope")).toBeNull();
    expect((await deps.rows.forApp("app-2")).map((r) => r.environment_id)).toStrictEqual(["env-2"]);
    expect((await deps.rows.appIds()).sort()).toStrictEqual(["app-1", "app-2"]);
    await deps.rows.remove("env-1");
    expect(await deps.rows.byRoot("a")).toBeNull();
  });
});

describe("provisionChainExclusive (the handler's and the machine API's one path)", () => {
  it("two concurrent callers on one chain create exactly one environment", async () => {
    const create = vi.spyOn(deps.envs, "create");
    const [a, b] = await Promise.all([
      provisionChainExclusive(deps, input()),
      provisionChainExclusive(deps, input({ label: "from the machine API" })),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(a.environment_id).toBe("env-1");
    expect(b.environment_id).toBe("env-1");
    expect(deps.envs.delete).not.toHaveBeenCalled();
  });

  it("waits for anything else holding the chain's lock", async () => {
    let release = () => {};
    const held = withChainLock("l1", () => new Promise<void>((r) => (release = r)));
    const create = vi.spyOn(deps.envs, "create");
    const p = provisionChainExclusive(deps, input());
    await new Promise((r) => setTimeout(r, 20));
    expect(create).not.toHaveBeenCalled();
    release();
    await held;
    expect((await p).environment_id).toBe("env-1");
  });

  it("different chains do not wait for each other", async () => {
    let release = () => {};
    const held = withChainLock("other-root", () => new Promise<void>((r) => (release = r)));
    expect((await provisionChainExclusive(deps, input())).environment_id).toBe("env-1");
    release();
    await held;
  });
});

describe("provisionChain claims a warm environment first", () => {
  const HOLDER = "0x1111111111111111111111111111111111111111";
  const OTHER = "0x2222222222222222222222222222222222222222";
  const REPO = "cr.vetra.io/app-sektar/host";
  const HOST_TEMPLATE = {
    services: [{ id: "h", type: "FUSION", prefix: "sektar", artifactName: "host", resolvedRepository: REPO, resolvedVersion: "sha-abcdef012345" }],
    packages: [], size: null, baseDomain: null, packageRegistry: null,
  };
  const warmInput = (over: Partial<ProvisionChainInput> = {}) => input({ template: HOST_TEMPLATE, ...over });
  /** What createWarmEnvironment leaves once the environment is up: no owner, empty ADMINS. */
  const warmDoc = () => ({
    status: "READY", owner: null, label: "Sektar (warm)", genericSubdomain: "calm-owl", packages: [],
    services: [{ type: "FUSION", prefix: "sektar", enabled: true, version: "sha-abcdef012345", selectedRessource: null }],
    fusion: { image: REPO, env: [{ name: "PH_HOST", value: "cli", isSecret: false }, { name: "ADMINS", value: "", isSecret: false }], autoUpdate: false, autoUpdateTagPattern: null },
  });
  const fusionEnv = (actions: Action[]) =>
    (actions.find((a) => a.type === "SET_FUSION_CONFIG")?.input as { env: { name: string; value: string }[] } | undefined)?.env;
  const warmRow = async (id: string) =>
    db.selectFrom("app_warm_pool").selectAll().where("environment_id", "=", id).executeTakeFirst();

  let store: WarmPoolStore;
  let handOver: ReturnType<typeof vi.fn<(documentId: string, owner: string) => Promise<void>>>;

  async function seedWarm(id = "warm-1"): Promise<void> {
    states.set(id, warmDoc());
    await store.insertWarming({ environmentId: id, appId: "app-1", templateId: "t", templateHash: "h1", nowIso: "2026-10-01T00:00:00.000Z" });
    await store.markAvailable(id, "2026-10-01T00:05:00.000Z");
  }

  beforeEach(() => {
    store = createWarmPoolStore(db);
    handOver = vi.fn(async () => {});
    deps.warmPool = { store, handOver };
  });

  it("claims an AVAILABLE warm environment instead of building one", async () => {
    await seedWarm();
    const row = await provisionChain(deps, warmInput());
    expect(deps.envs.create).not.toHaveBeenCalled();
    expect(row).toMatchObject({ environment_id: "warm-1", root_license_id: "l1", template_hash: "h1", label: "My vault" });
    expect(await deps.rows.byRoot("l1")).toMatchObject({ environment_id: "warm-1", template_hash: "h1" });
    expect(executed).toHaveLength(1);
    const actions = executed[0]!.actions;
    expect(executed[0]!.id).toBe("warm-1");
    expect(actions.map((a) => a.type)).not.toContain("INITIALIZE");
    expect(actions.find((a) => a.type === "SET_OWNER")!.input).toStrictEqual({ address: HOLDER });
    expect(fusionEnv(actions)).toContainEqual({ name: "ADMINS", value: HOLDER, isSecret: false });
    expect(handOver).toHaveBeenCalledWith("warm-1", HOLDER);
    expect(await warmRow("warm-1")).toMatchObject({ state: "CLAIMED", root_license_id: "l1", deleted_at: null });
  });

  it("relabels a claimed environment for the holder and approves it even when the template's floor is already met", async () => {
    await seedWarm();
    const doc = states.get("warm-1")!;
    doc.fusion = { ...(doc.fusion as object), env: [{ name: "PH_HOST", value: "cli", isSecret: false }, { name: "ADMINS", value: HOLDER, isSecret: false }] };
    await provisionChain(deps, warmInput());
    expect(executed[0]!.actions.map((a) => a.type)).toStrictEqual(["SET_OWNER", "SET_LABEL", "APPROVE_CHANGES"]);
    expect(executed[0]!.actions[1]!.input).toStrictEqual({ label: "My vault" });
  });

  it("still re-renders (SET_LABEL + APPROVE_CHANGES) when the label is unchanged and the floor is met", async () => {
    await seedWarm();
    const doc = states.get("warm-1")!;
    doc.fusion = { ...(doc.fusion as object), env: [{ name: "PH_HOST", value: "cli", isSecret: false }, { name: "ADMINS", value: HOLDER, isSecret: false }] };
    await provisionChain(deps, warmInput({ label: "Sektar (warm)" }));
    // An unchanged SET_LABEL still moves a deployed environment to
    // CHANGES_PENDING, so the approve is valid and gitops opens the ingress.
    expect(executed[0]!.actions.map((a) => a.type)).toStrictEqual(["SET_OWNER", "SET_LABEL", "APPROVE_CHANGES"]);
    expect(executed[0]!.actions.at(-1)!.type).toBe("APPROVE_CHANGES");
  });

  it("builds cold, exactly as before, when no warm environment is available", async () => {
    const row = await provisionChain(deps, warmInput());
    expect(row).toMatchObject({ environment_id: "env-1", template_hash: "h1" });
    expect(deps.envs.create).toHaveBeenCalledTimes(1);
    expect(executed.map((e) => e.id)).toStrictEqual(["env-1"]);
    expect(executed[0]!.actions.map((a) => a.type)).toContain("INITIALIZE");
    expect(handOver).not.toHaveBeenCalled();
  });

  it("discards a warm environment someone already owns and builds cold", async () => {
    await seedWarm();
    states.get("warm-1")!.owner = OTHER;
    const row = await provisionChain(deps, warmInput());
    expect(row.environment_id).toBe("env-1");
    expect(deps.envs.delete).toHaveBeenCalledWith("warm-1");
    expect((await warmRow("warm-1"))!.deleted_at).not.toBeNull();
    expect(executed.map((e) => e.id)).toStrictEqual(["env-1"]);
    expect(handOver).not.toHaveBeenCalled();
    expect(await deps.rows.countForApp("app-1")).toBe(1);
  });

  it("a claim whose actions are rejected deletes the warm environment, never returns it to the pool, and builds cold", async () => {
    await seedWarm();
    const execute = deps.envs.execute;
    deps.envs.execute = async (id, actions) => {
      if (id === "warm-1") throw new Error("SET_OWNER rejected");
      return execute(id, actions);
    };
    const row = await provisionChain(deps, warmInput());
    expect(row.environment_id).toBe("env-1");
    expect(deps.envs.delete).toHaveBeenCalledWith("warm-1");
    expect(states.has("warm-1")).toBe(false);
    const warm = await warmRow("warm-1");
    expect(warm!.deleted_at).not.toBeNull();
    expect(warm!.state).toBe("CLAIMED");
    expect(await deps.rows.byEnvironment("warm-1")).toBeNull();
    expect((await deps.rows.byRoot("l1"))!.environment_id).toBe("env-1");
    expect(handOver).not.toHaveBeenCalled();
  });

  it("rolls a claim forward after a crash between the claim and the owner write", async () => {
    await seedWarm();
    // The claim transaction committed (warm row CLAIMED + chain row), then the process died.
    const claimed = await store.claimForChain(
      { appId: "app-1", templateId: "t", templateHash: "h1", rootLicenseId: "l1", nowIso: "2026-10-08T00:00:00.000Z" },
      {
        root_license_id: "l1", app_id: "app-1", user_did: DID, license_id: "l1", template_id: "t", label: "My vault",
        template_hash: UNAPPLIED_TEMPLATE_HASH, ended_at: null, stopped_at: null, delete_after: null,
        created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
      },
    );
    expect(claimed.warm?.environment_id).toBe("warm-1");
    expect(executed).toHaveLength(0);

    const row = await provisionChain(deps, warmInput());
    expect(deps.envs.create).not.toHaveBeenCalled();
    expect(deps.envs.delete).not.toHaveBeenCalled();
    expect(row).toMatchObject({ environment_id: "warm-1", template_hash: "h1" });
    expect(executed[0]!.actions.find((a) => a.type === "SET_OWNER")!.input).toStrictEqual({ address: HOLDER });
    expect(fusionEnv(executed[0]!.actions)).toContainEqual({ name: "ADMINS", value: HOLDER, isSecret: false });
    expect(handOver).toHaveBeenCalledWith("warm-1", HOLDER);
    expect(await deps.rows.byRoot("l1")).toMatchObject({ environment_id: "warm-1", template_hash: "h1" });
    // And it is settled: the next call does nothing.
    await provisionChain(deps, warmInput());
    expect(executed).toHaveLength(1);
  });

  it("a warm environment recycled between the claim and the re-read leaves the licence with exactly one (cold) environment", async () => {
    await seedWarm();
    const claimForChain = store.claimForChain.bind(store);
    deps.warmPool = {
      handOver,
      store: {
        ...store,
        claimForChain: async (q, chainRow) => {
          const r = await claimForChain(q, chainRow);
          // The keeper's recycle lands now: the document is gone.
          await store.markDeleted("warm-1", "2026-10-08T00:00:01.000Z");
          states.delete("warm-1");
          return r;
        },
      },
    };
    const row = await provisionChain(deps, warmInput());
    expect(row.environment_id).toBe("env-1");
    expect([...states.keys()]).toStrictEqual(["env-1"]);
    expect(await deps.rows.forApp("app-1")).toHaveLength(1);
    expect(await deps.rows.byEnvironment("warm-1")).toBeNull();
    expect(handOver).not.toHaveBeenCalled();
  });

  it("refuses a claim over the app cap as it refuses a build; the warm environment stays in the pool", async () => {
    await db.insertInto("app_environment_limits").values({ app_id: "app-1", max_environments: 0 }).execute();
    await seedWarm();
    await expect(provisionChain(deps, warmInput())).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);
    expect(await warmRow("warm-1")).toMatchObject({ state: "AVAILABLE", root_license_id: null, claimed_at: null });
    expect(executed).toHaveLength(0);
  });
});
describe("the included AI key (spec 3.11)", () => {
  const HOLDER = "0x1111111111111111111111111111111111111111";
  const REPO = "cr.vetra.io/app-sektar/host";
  const HOST_TEMPLATE = {
    services: [{ id: "h", type: "FUSION", prefix: "sektar", artifactName: "host", resolvedRepository: REPO, resolvedVersion: "sha-abcdef012345" }],
    packages: [], size: null, baseDomain: null, packageRegistry: null,
  };
  const keyInput = (over: Partial<ProvisionChainInput> = {}) => input({ template: HOST_TEMPLATE, ...over });
  const KEY_ENTRY = { name: "OPENROUTER_API_KEY", value: null, isSecret: true };
  const warmDoc = () => ({
    status: "READY", owner: null, label: "Sektar (warm)", genericSubdomain: "calm-owl", packages: [],
    services: [{ type: "FUSION", prefix: "sektar", enabled: true, version: "sha-abcdef012345", selectedRessource: null }],
    fusion: { image: REPO, env: [{ name: "PH_HOST", value: "cli", isSecret: false }, { name: "ADMINS", value: "", isSecret: false }], autoUpdate: false, autoUpdateTagPattern: null },
  });
  const fusionEnv = (actions: Action[]) =>
    (actions.find((a) => a.type === "SET_FUSION_CONFIG")?.input as { env: unknown[] } | undefined)?.env;

  let store: WarmPoolStore;
  let order: string[];
  let appKey: ReturnType<typeof vi.fn<NonNullable<ChainEnvDeps["appKey"]>>>;
  let releaseAppKey: ReturnType<typeof vi.fn<(environmentId: string) => Promise<void>>>;

  async function seedWarm(id = "warm-1"): Promise<void> {
    states.set(id, warmDoc());
    await store.insertWarming({ environmentId: id, appId: "app-1", templateId: "t", templateHash: "h1", nowIso: "2026-10-01T00:00:00.000Z" });
    await store.markAvailable(id, "2026-10-01T00:05:00.000Z");
  }

  beforeEach(() => {
    store = createWarmPoolStore(db);
    order = [];
    appKey = vi.fn(async (k: { environmentId: string }) => { order.push(`key:${k.environmentId}`); return true; });
    releaseAppKey = vi.fn(async () => {});
    const execute = deps.envs.execute;
    deps.envs.execute = async (id, actions) => { order.push(`execute:${id}`); return execute(id, actions); };
    deps.warmPool = { store, handOver: async () => {} };
    deps.appKey = appKey;
    deps.releaseAppKey = releaseAppKey;
  });

  it("a claim with a code budget writes the key first and declares it in the same batch as ADMINS", async () => {
    await seedWarm();
    await provisionChain(deps, keyInput());
    expect(appKey).toHaveBeenCalledWith({
      environmentId: "warm-1", tenantId: getTenantId("calm-owl", "warm-1"), rootLicenseId: "l1", ownerDid: DID,
    });
    expect(order).toStrictEqual(["key:warm-1", "execute:warm-1"]);
    expect(executed).toHaveLength(1);
    const env = fusionEnv(executed[0]!.actions);
    expect(env).toContainEqual({ name: "ADMINS", value: HOLDER, isSecret: false });
    expect(env).toContainEqual(KEY_ENTRY);
    expect(releaseAppKey).not.toHaveBeenCalled();
  });

  it("a claim without a budget gets no key and no OPENROUTER_API_KEY entry", async () => {
    await seedWarm();
    appKey.mockResolvedValue(false);
    await provisionChain(deps, keyInput());
    const env = fusionEnv(executed[0]!.actions)!;
    expect(env).toContainEqual({ name: "ADMINS", value: HOLDER, isSecret: false });
    expect(env.some((e) => (e as { name: string }).name === "OPENROUTER_API_KEY")).toBe(false);
  });

  it("a cold build with a budget gets the key as part of the create", async () => {
    const row = await provisionChain(deps, keyInput());
    expect(row.environment_id).toBe("env-1");
    expect(appKey).toHaveBeenCalledWith({
      environmentId: "env-1", tenantId: getTenantId("sub-env-1", "env-1"), rootLicenseId: "l1", ownerDid: DID,
    });
    expect(order).toStrictEqual(["key:env-1", "execute:env-1"]);
    expect(executed[0]!.actions.map((a) => a.type)).toContain("INITIALIZE");
    expect(fusionEnv(executed[0]!.actions)).toContainEqual(KEY_ENTRY);
  });

  it("a cold build without a budget declares no key", async () => {
    appKey.mockResolvedValue(false);
    await provisionChain(deps, keyInput());
    expect(JSON.stringify(executed[0]!.actions)).not.toContain("OPENROUTER_API_KEY");
  });

  it("a failing key write releases the key and the claim falls back to cold", async () => {
    await seedWarm();
    appKey.mockImplementation(async (k) => {
      if (k.environmentId === "warm-1") throw new Error("secrets down");
      return true;
    });
    const row = await provisionChain(deps, keyInput());
    expect(releaseAppKey).toHaveBeenCalledWith("warm-1");
    expect(row.environment_id).toBe("env-1");
    expect(states.has("warm-1")).toBe(false);
    expect(executed.map((e) => e.id)).toStrictEqual(["env-1"]);
  });

  it("a claim whose batch fails after the key was written releases the key, even when the delete fails", async () => {
    await seedWarm();
    const execute = deps.envs.execute;
    deps.envs.execute = async (id, actions) => {
      if (id === "warm-1") throw new Error("SET_OWNER rejected");
      return execute(id, actions);
    };
    deps.envs.delete = vi.fn(async () => { throw new Error("reactor down"); });
    await expect(provisionChain(deps, keyInput())).rejects.toThrow("reactor down");
    expect(releaseAppKey).toHaveBeenCalledWith("warm-1");
  });

  it("a failed release is logged, and the discard carries on", async () => {
    await seedWarm();
    const error = vi.fn();
    deps.logger = { error };
    appKey.mockRejectedValueOnce(new Error("secrets down"));
    releaseAppKey.mockRejectedValueOnce(new Error("openrouter down"));
    const row = await provisionChain(deps, keyInput());
    expect(row.environment_id).toBe("env-1");
    expect(error.mock.calls.some(([m]) => String(m).includes("openrouter down"))).toBe(true);
  });

  it("redacts secrets in the claim-failure and release-failure logs", async () => {
    await seedWarm();
    const error = vi.fn();
    deps.logger = { error };
    appKey.mockRejectedValueOnce(new Error("write failed for sk-or-v1-claimsecret"));
    releaseAppKey.mockRejectedValueOnce(new Error("release failed for sk-or-v1-releasesecret"));
    await provisionChain(deps, keyInput());
    const logged = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("write failed for [redacted]");
    expect(logged).toContain("release failed for [redacted]");
    expect(logged).not.toContain("sk-or-v1-");
  });

  it("a template without FUSION never mints a key", async () => {
    await provisionChain(deps, input());
    expect(appKey).not.toHaveBeenCalled();
  });

  it("a warm (unclaimed) environment never gets a key", async () => {
    await db.insertInto("app_environment_limits").values({ app_id: "app-1", max_environments: 0 }).execute();
    await seedWarm();
    await expect(provisionChain(deps, keyInput())).rejects.toBeInstanceOf(AppEnvironmentCapReachedError);
    expect(appKey).not.toHaveBeenCalled();
    const warm = renderCreateActions({ label: "Sektar (warm)", subdomain: "calm-owl", owner: null, template: HOST_TEMPLATE, includedKey: true });
    expect(JSON.stringify(warm)).not.toContain("OPENROUTER_API_KEY");
  });
});

