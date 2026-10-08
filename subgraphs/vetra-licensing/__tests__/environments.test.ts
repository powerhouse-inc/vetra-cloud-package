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

const DID = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const OTHER_DID = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const TEMPLATE = { services: [{ id: "s", type: "CONNECT", prefix: null }], packages: [], size: null, baseDomain: null, packageRegistry: null };
const input = (over: Partial<ProvisionChainInput> = {}): ProvisionChainInput => ({
  appId: "app-1", root: "l1", licenseId: "l1", userDid: DID, templateId: "t",
  template: TEMPLATE, templateHash: "h1", label: "My vault", now: "2026-10-08T00:00:00.000Z", ...over,
});

let db: Kysely<VetraLicensingDB>;
let deps: ChainEnvDeps;
let states: Map<string, { status: string; packages: never[]; services: never[] }>;
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
      create: async () => { const id = `env-${++n}`; states.set(id, { status: "DRAFT", packages: [], services: [] }); return id; },
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
