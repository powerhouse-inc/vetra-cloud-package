import type { Kysely } from "kysely";
import type { VetraLicensingDB } from "../../vetra-licensing/db/schema.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  owner,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { getTenantId } from "../../../processors/vetra-cloud-environment/gitops.js";
import { listInstances } from "../instances/repo.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { appInstancesFor } from "../instances/service.js";
import { insertPlan, updatePlan } from "../plans/repo.js";
import { setAppSetting } from "../settings/service.js";
import { vi } from "vitest";
import {
  deleteMyInstanceSetting,
  setMyInstanceSetting,
} from "../settings/holder-service.js";
import { ownInstanceChain, planBudgetOf } from "../instances/vetra-secrets.js";
import { deliverSettings } from "../settings/deliver.js";
import { fileKey } from "../settings/names.js";
import { settingsForInstance } from "../settings/resolve.js";
import type { Caller } from "../auth.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const SERVICE = "0x9999999999999999999999999999999999999999";
const holder: Caller = {
  address: HOLDER,
  chainId: 1,
  appKey: null,
  isAdmin: false,
};

let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
  h.deps.serviceOwner = SERVICE;
  h.deps.holderVault = {
    encrypt: async (p) => `holder:${Buffer.from(p).toString("base64")}`,
    decrypt: async (c) =>
      Buffer.from(c.slice("holder:".length), "base64").toString(),
  };
  appId = (await seedActiveApp(h)).id;
  await h.db
    .updateTable("apps")
    .set({ instances_enabled: true, registry_namespace: "acme" })
    .where("id", "=", appId)
    .execute();
  await seedRelease(h, appId, {
    version: "1.4.0",
    run: 100,
    kind: "release",
    digest: digest("b"),
  });
  await insertPlan(h.db, {
    id: "plan-own",
    app_id: appId,
    slug: "pro",
    name: "Pro",
    kind: "pro",
    access: "own",
    size: "VETRA_AGENT_M",
    target_version: "1.4.0",
    policy: "manual",
    notice_hours: 72,
    status: "active",
    created_by: OWNER,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  await seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });
  await reconcileInstancesOnce(h.deps);
  h.envs.setStatus((await own()).environment_id!, "READY");
  await reconcileInstancesOnce(h.deps);
  expect((await own()).status).toBe("ready");
});
afterEach(async () => {
  await h.close();
});

const own = async () =>
  (await listInstances(h.db, appId)).find((r) => r.kind === "own")!;
const env = async () => (await h.envs.getState((await own()).environment_id!))!;
const envEntry = async (name: string) =>
  (await env()).fusion!.env.find((e) => e.name === name);
const tenant = async () => {
  const r = await own();
  return getTenantId(r.host!, r.environment_id!);
};
const hset = async (name: string, value: string, kind: "PLAIN" | "SECRET") =>
  setMyInstanceSetting(h.deps, holder, {
    instanceId: (await own()).id,
    name,
    value,
    kind,
  });


const llmCalls = () => (h.deps.llm!.provisionVetraKey as ReturnType<typeof vi.fn>).mock.calls;

describe("AI key per plan budget (plan 7 Task 10)", () => {
  it("provisions once with the holder's DID, the plan's budget and the tenant; declares the secret; never deletes it", async () => {
    await updatePlan(h.db, "plan-own", { ai_budget_usd: 25 }, "2026-10-02T00:00:00.000Z");
    h.deps.llm = {
      provisionVetraKey: vi.fn(async () => ({ connected: true, llmBudgetUsd: 25 })),
      releaseVetraKey: vi.fn(async () => undefined),
    };
    await reconcileInstancesOnce(h.deps);
    expect(llmCalls()).toHaveLength(1);
    expect(llmCalls()[0][0]).toMatchObject({
      environmentId: (await own()).environment_id,
      tenantId: await tenant(),
      ownerDid: `did:pkh:eip155:1:${HOLDER}`,
      instanceId: (await own()).id,
      fixedBudgetUsd: 25,
    });
    expect(await envEntry("OPENROUTER_API_KEY")).toMatchObject({ value: null, isSecret: true });
    // A second pass does not provision again, and a delivery never deletes it.
    await reconcileInstancesOnce(h.deps);
    expect(llmCalls()).toHaveLength(1);
    await setMyInstanceSetting(h.deps, holder, { instanceId: (await own()).id, name: "X", value: "1", kind: "PLAIN" });
    await reconcileInstancesOnce(h.deps);
    expect(await envEntry("OPENROUTER_API_KEY")).toBeDefined();
    expect(h.deps.llm!.releaseVetraKey).not.toHaveBeenCalled();
  });

  it("a plan without a budget: nothing provisioned, nothing declared", async () => {
    h.deps.llm = {
      provisionVetraKey: vi.fn(async () => ({ connected: true, llmBudgetUsd: 1 })),
      releaseVetraKey: vi.fn(async () => undefined),
    };
    await setMyInstanceSetting(h.deps, holder, { instanceId: (await own()).id, name: "X", value: "1", kind: "PLAIN" });
    await reconcileInstancesOnce(h.deps);
    expect(llmCalls()).toHaveLength(0);
    expect(await envEntry("OPENROUTER_API_KEY")).toBeUndefined();
  });

  it("without a key broker the key is still declared, the instance fails its pass, and heals once the broker is there", async () => {
    await updatePlan(h.db, "plan-own", { ai_budget_usd: 25 }, "2026-10-02T00:00:00.000Z");
    await setMyInstanceSetting(h.deps, holder, { instanceId: (await own()).id, name: "X", value: "1", kind: "PLAIN" });
    await reconcileInstancesOnce(h.deps);
    expect(await own()).toMatchObject({ status: "failed" });
    expect((await own()).reason).toContain("AI key broker");
    h.deps.llm = {
      provisionVetraKey: vi.fn(async () => ({ connected: true, llmBudgetUsd: 25 })),
      releaseVetraKey: vi.fn(async () => undefined),
    };
    await reconcileInstancesOnce(h.deps);
    expect(llmCalls()).toHaveLength(1);
    expect((await own()).status).not.toBe("failed");
    expect(await envEntry("OPENROUTER_API_KEY")).toMatchObject({ isSecret: true });
  });

  it("refuses OPENROUTER_API_KEY for holders, and in PLAN scope while a plan has a budget", async () => {
    await expect(
      setMyInstanceSetting(h.deps, holder, { instanceId: (await own()).id, name: "OPENROUTER_API_KEY", value: "k", kind: "SECRET" }),
    ).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
    const set = () =>
      setAppSetting(h.deps, owner, { appId, name: "OPENROUTER_API_KEY", value: "k", secret: true, scope: "PLAN" });
    await set();
    await updatePlan(h.db, "plan-own", { ai_budget_usd: 25 }, "2026-10-02T00:00:00.000Z");
    await expect(set()).rejects.toMatchObject({ extensions: { code: "BAD_USER_INPUT" } });
  });
});

describe("planBudgetOf", () => {
  it("answers the plan's budget while the instance runs, null when stopping or without budget", async () => {
    const budget = planBudgetOf(h.db);
    const id = (await own()).id;
    expect(await budget(id)).toBeNull();
    await updatePlan(h.db, "plan-own", { ai_budget_usd: 25 }, "2026-10-02T00:00:00.000Z");
    expect(await budget(id)).toBe(25);
    await h.db.updateTable("instances").set({ stop_reason: "licence ended" }).where("id", "=", id).execute();
    expect(await budget(id)).toBeNull();
  });
});

describe("reporting token for own instances (plan 7 Task 11)", () => {
  beforeEach(() => {
    h.deps.cfg = {
      ...h.deps.cfg,
      licensingUrl: "https://sb/graphql/vetra-licensing",
    };
  });
  let seq = 0;
  const bump = async () =>
    // A settings change makes a new revision, so the instance is delivered again.
    setMyInstanceSetting(h.deps, holder, {
      instanceId: (await own()).id,
      name: `N${++seq}`,
      value: "1",
      kind: "PLAIN",
    });

  it("writes the token and the URL once, records the hash, and declares both", async () => {
    await bump();
    await reconcileInstancesOnce(h.deps);
    const secrets = h.secrets.store.get(await tenant())!;
    const token = secrets.get("VETRA_REPORTING_TOKEN")!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.get("VETRA_LICENSING_URL")).toBe(
      "https://sb/graphql/vetra-licensing",
    );
    expect(await envEntry("VETRA_REPORTING_TOKEN")).toMatchObject({
      value: null,
      isSecret: true,
    });
    expect(await envEntry("VETRA_LICENSING_URL")).toMatchObject({
      isSecret: true,
    });
    expect(
      await (h.db as unknown as Kysely<VetraLicensingDB>)
        .selectFrom("environment_reporting_tokens")
        .select("environment_id")
        .execute(),
    ).toHaveLength(1);
    await bump();
    await reconcileInstancesOnce(h.deps);
    expect(
      h.secrets.store.get(await tenant())!.get("VETRA_REPORTING_TOKEN"),
    ).toBe(token);
  });

  it("without licensing's URL no token is declared or written", async () => {
    h.deps.cfg = { ...h.deps.cfg, licensingUrl: null };
    await bump();
    await reconcileInstancesOnce(h.deps);
    expect(await envEntry("VETRA_REPORTING_TOKEN")).toBeUndefined();
  });

  it("the relay chain of an own instance: licence root, App and holder; none once removed", async () => {
    const r = await own();
    expect(await ownInstanceChain(h.db)(r.environment_id!)).toEqual({
      root_license_id: r.licence_root_id,
      app_id: appId,
      user_did: `did:pkh:eip155:1:${HOLDER}`,
    });
    expect(await ownInstanceChain(h.db)("nope")).toBeNull();
    await h.db
      .updateTable("instances")
      .set({ removed_at: "2026-10-03T00:00:00.000Z" })
      .where("id", "=", r.id)
      .execute();
    expect(await ownInstanceChain(h.db)(r.environment_id!)).toBeNull();
  });
});
