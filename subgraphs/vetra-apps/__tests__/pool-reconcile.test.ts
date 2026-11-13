import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { digest, seedLicence, seedRelease } from "./instances-fixtures.js";
import { HOLDER, poolHarness } from "./pool-fixtures.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { listInstances, updateInstance } from "../instances/repo.js";
import { updatePlan } from "../plans/repo.js";
import { WARM_LABEL } from "../plans/pool.js";

const SERVICE = "0x9999999999999999999999999999999999999999";
let h: Harness;
let appId: string;

const setup = async (over?: Parameters<typeof poolHarness>[0]) => {
  ({ h, appId } = await poolHarness(over));
  h.deps.serviceOwner = SERVICE;
};
beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await h.close();
});

const own = () => listInstances(h.db, appId, "own");
const admins = async (envId: string) =>
  (await h.envs.getState(envId))!.fusion!.env.find((e) => e.name === "ADMINS")!
    .value;
const pass = () => reconcileInstancesOnce(h.deps);
/** One pass, then every environment the pass made is READY. */
const settle = async () => {
  await pass();
  for (const r of await own())
    if (r.environment_id && !r.removed_at)
      h.envs.setStatus(r.environment_id, "READY");
  await pass();
};

describe("warm pool: reconciler", () => {
  it("fills the pool: one warm row, closed to holders (ADMINS empty, warm label), role PLAN, size M; it becomes ready", async () => {
    await pass();
    const [warm] = await own();
    expect(warm).toMatchObject({ warm: true, holder_address: null });
    const state = (await h.envs.getState(warm.environment_id!))!;
    expect(state.app).toMatchObject({ appId, role: "PLAN" });
    expect(state.owner).toBe(SERVICE);
    expect(state.label).toBe(`Shop · ${WARM_LABEL}`);
    expect(await admins(warm.environment_id!)).toBe("");
    expect(state.services.find((s) => s.type === "FUSION")).toMatchObject({
      selectedRessource: "VETRA_AGENT_M",
    });
    await settle();
    expect((await own())[0]).toMatchObject({ status: "ready", warm: true });
    // the pool is full: no second row
    expect(await own()).toHaveLength(1);
  });

  it("a new holder claims it; that pass writes ADMINS and the new label; the pool refills", async () => {
    await settle();
    const [warm] = await own();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await pass();
    const rows = await own();
    const claimed = rows.find((r) => r.id === warm.id)!;
    expect(claimed).toMatchObject({
      warm: false,
      holder_address: HOLDER,
      environment_id: warm.environment_id,
      host: warm.host,
    });
    const state = (await h.envs.getState(claimed.environment_id!))!;
    expect(await admins(claimed.environment_id!)).toBe(HOLDER);
    expect(state.label).toBe(`Shop · ${claimed.name}`);
    expect(claimed.name).not.toMatch(/warm/);
    expect(rows.filter((r) => r.warm)).toHaveLength(1);
  });

  it("a target move replaces warm rows, rolling: fresh row first, then the stale one and its environment go", async () => {
    await settle();
    const [stale] = await own();
    await seedRelease(h, appId, {
      version: "1.5.0",
      run: 101,
      kind: "release",
      digest: digest("c"),
    });
    await updatePlan(
      h.db,
      "p-pro",
      { target_version: "1.5.0" },
      "2026-11-13T00:00:00.000Z",
    );
    await pass();
    const rows = await own();
    const fresh = rows.find((r) => r.id !== stale.id)!;
    expect(fresh).toMatchObject({ warm: true, target_version: "1.5.0" });
    // over size once the fresh row exists: the stale one leaves in the next pass
    await pass();
    expect((await own()).map((r) => r.id)).toEqual([fresh.id]);
    expect(h.envs.deleted).toContain(stale.environment_id);
    expect(h.envs.docs.has(stale.environment_id!)).toBe(false);
  });

  it("pool size 0 drains unclaimed rows and never touches claimed ones", async () => {
    await setup({ warmPoolSize: 2 });
    await settle();
    await settle();
    expect((await own()).filter((r) => r.warm)).toHaveLength(2);
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await pass();
    const claimedId = (await own()).find((r) => !r.warm)!.id;
    await updatePlan(
      h.db,
      "p-pro",
      { warm_pool_size: 0 },
      "2026-11-13T00:00:00.000Z",
    );
    await pass();
    await pass();
    const rows = await own();
    expect(rows.map((r) => r.id)).toEqual([claimedId]);
    expect(rows[0].removed_at).toBeNull();
  });

  it("VETRA_APPS_PLAN_POOL_MAX 0 creates nothing", async () => {
    await h.close();
    await setup({ poolMax: 0 });
    await pass();
    await pass();
    expect(await own()).toEqual([]);
  });

  it("a removed claimed row is never deleted (removeInstance refuses a row with a holder)", async () => {
    await settle();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await pass();
    const claimed = (await own()).find((r) => !r.warm)!;
    await updateInstance(
      h.db,
      claimed.id,
      { removed_at: "2026-11-13T00:00:00.000Z", removed_reason: "x" },
      "2026-11-13T00:00:00.000Z",
    );
    await pass();
    expect(h.envs.docs.has(claimed.environment_id!)).toBe(true);
    expect(h.envs.deleted).not.toContain(claimed.environment_id);
    expect((await own()).some((r) => r.id === claimed.id)).toBe(true);
  });

  it("a claim re-read protects a row claimed after the pass read it as warm", async () => {
    await settle();
    const [warm] = await own();
    // the keeper marked it removed, then a holder claimed it (racing pass)
    await updateInstance(
      h.db,
      warm.id,
      {
        removed_at: "2026-11-13T00:00:00.000Z",
        removed_reason: "warm pool: over the pool size",
      },
      "2026-11-13T00:00:00.000Z",
    );
    await h.db
      .updateTable("instances")
      .set({ warm: false, holder_address: HOLDER })
      .where("id", "=", warm.id)
      .execute();
    await pass();
    expect(h.envs.docs.has(warm.environment_id!)).toBe(true);
  });
});
