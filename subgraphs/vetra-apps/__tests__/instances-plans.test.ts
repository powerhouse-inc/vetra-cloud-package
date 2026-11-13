import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeHarness,
  OWNER,
  seedActiveApp,
  testConfig,
  type Harness,
} from "./harness.js";
import {
  digest,
  seedLicence,
  seedLicensedEnvironment,
  seedRelease,
} from "./instances-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { insertPlan, updatePlan } from "../plans/repo.js";
import {
  LICENCE_ENDED,
  LICENSED_ENVIRONMENT,
  ownInstanceName,
  PLAN_RETIRED,
  syncPlanInstances,
} from "../plans/sync.js";
import { getApp } from "../repo.js";
import {
  PLAN_NEEDS_NEW_SECRETS,
  reconcileInstancesOnce,
  STOPPED_OUTSIDE_VETRA,
} from "../instances/reconciler.js";
import type { VetraCloudEnvironmentState } from "../../../document-models/vetra-cloud-environment/index.js";
import { getHold } from "../holds/repo.js";

const HOLDER = "0x1111111111111111111111111111111111111111";
const DAY = 86_400_000;
let h: Harness;
let appId: string;

beforeEach(async () => {
  h = await makeHarness(
    testConfig({ plans: { enabled: true, stopAfterDays: 14 } }),
  );
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
});
afterEach(async () => {
  await h.close();
});

const plan = (over: Partial<Parameters<typeof insertPlan>[1]> = {}) =>
  insertPlan(h.db, {
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
    ...over,
  });
const sync = async () =>
  syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
const rows = () => listInstances(h.db, appId);

describe("syncPlanInstances", () => {
  it("gives each live chain of an own plan one row, on the plan's target and size", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await seedLicence(h, {
      appId,
      kind: "other",
      holder: HOLDER,
      licenseId: "l2",
    });
    await sync();
    await sync(); // idempotent
    expect(await rows()).toEqual([
      expect.objectContaining({
        kind: "own",
        name: ownInstanceName("l1"),
        plan_id: "plan-own",
        holder_address: HOLDER,
        licence_root_id: "l1",
        target_version: "1.4.0",
        target_digest: digest("b"),
        target_size: "VETRA_AGENT_M",
        status: "pending",
        stop_reason: null,
      }),
    ]);
  });

  it("makes no row without a target, and none for a chain with a licensed environment", async () => {
    await plan({ target_version: null });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    expect(await rows()).toEqual([]);
    await updatePlan(
      h.db,
      "plan-own",
      { target_version: "1.4.0" },
      "2026-10-02T00:00:00.000Z",
    );
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await sync();
    expect(await rows()).toEqual([]);
  });

  describe("switched-over chains (plan 9)", () => {
    const licence = () =>
      seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: "l1" });

    it("gives a chain whose licensed environment was switched over its own instance", async () => {
      await plan();
      await licence();
      await seedLicensedEnvironment(h, {
        appId,
        root: "l1",
        switchedOverAt: "2026-11-01T00:00:00.000Z",
      });
      await sync();
      expect(await rows()).toEqual([
        expect.objectContaining({ kind: "own", licence_root_id: "l1" }),
      ]);
    });

    it("leaves a row a switch-over still owns alone, even when its licence ended", async () => {
      await plan();
      await licence();
      await sync();
      const [row] = await rows();
      await h.db
        .updateTable("instances")
        .set({ switchover_id: "s1", plan_id: "stale" })
        .where("id", "=", row.id)
        .execute();
      await h.deps
        .licensingDb!.updateTable("license_lifecycle")
        .set({ status: "EXPIRED" })
        .where("license_id", "=", "l1")
        .execute();
      h.advance(30 * DAY);
      await sync();
      expect((await rows())[0]).toMatchObject({
        plan_id: "stale",
        stop_reason: null,
        licence_ended_at: null,
      });
    });

    it("stops the own instance stopAfterDays after the licence ended; the old environment is not the new one's business", async () => {
      await plan();
      await licence();
      await seedLicensedEnvironment(h, {
        appId,
        root: "l1",
        switchedOverAt: "2026-11-01T00:00:00.000Z",
      });
      await sync();
      await h.deps
        .licensingDb!.updateTable("license_lifecycle")
        .set({ status: "EXPIRED" })
        .where("license_id", "=", "l1")
        .execute();
      await sync();
      h.advance(15 * DAY);
      await sync();
      expect((await rows())[0].stop_reason).toBe(LICENCE_ENDED);
      expect((await rows())[0].stop_reason).not.toBe(LICENSED_ENVIRONMENT);
    });

    it("the reconciler skips an instance a switch-over owns", async () => {
      await plan();
      await licence();
      await sync();
      const [row] = await rows();
      await h.db
        .updateTable("instances")
        .set({ switchover_id: "s1" })
        .where("id", "=", row.id)
        .execute();
      h.envs.executed.length = 0;
      await reconcileInstancesOnce(h.deps);
      // The App's branch instance is reconciled as ever; the own row is not.
      const own = (await rows()).find((r) => r.kind === "own")!;
      expect(own.environment_id).toBeNull();
      expect(own.status).toBe("pending");
    });
  });

  it("marks an own row to stop stopAfterDays after its licence ended, and clears it when live again", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "l1")
      .execute();
    await sync();
    const ended = (await rows())[0];
    expect(ended.licence_ended_at).not.toBeNull();
    expect(ended.stop_reason).toBeNull();
    h.advance(15 * DAY);
    await sync();
    expect((await rows())[0].stop_reason).toBe(LICENCE_ENDED);
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1b",
      root: "l1",
    });
    await sync();
    expect((await rows())[0]).toMatchObject({
      stop_reason: null,
      licence_ended_at: null,
    });
  });

  it("measures the stop window from the licence's recorded end, not from when sync noticed", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
      endAt: "2026-10-03T00:00:00.000Z",
    });
    await sync();
    h.advance(15 * DAY); // first noticed now, 14.5 days after the end
    await sync();
    expect((await rows())[0]).toMatchObject({
      licence_ended_at: "2026-10-03T00:00:00.000Z",
      stop_reason: LICENCE_ENDED,
    });
  });

  it("falls back to when sync noticed for a licence that ended without a recorded end (revoked)", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "REVOKED" })
      .where("license_id", "=", "l1")
      .execute();
    h.advance(DAY);
    await sync();
    expect((await rows())[0]).toMatchObject({
      licence_ended_at: expect.stringMatching(/^2026-10-03T12:00:00/),
      stop_reason: null,
    });
  });

  it("stops an own row at once when its chain gets a licensed environment", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await sync();
    expect((await rows())[0]).toMatchObject({
      licence_root_id: "l1",
      licence_ended_at: null,
      stop_reason: LICENSED_ENVIRONMENT,
    });
  });

  it("leaves removed own rows alone", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    const before = (await rows())[0];
    await h.db
      .updateTable("instances")
      .set({ removed_at: "2026-10-02T12:00:00.000Z", removed_reason: "gone" })
      .where("id", "=", before.id)
      .execute();
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "l1")
      .execute();
    h.advance(15 * DAY);
    await sync();
    expect((await rows())[0]).toMatchObject({
      licence_ended_at: null,
      stop_reason: null,
      updated_at: before.updated_at,
    });
  });

  it("does nothing while plans are off, even when called directly", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    h.deps.cfg = {
      ...h.deps.cfg,
      plans: { enabled: false, stopAfterDays: 14 },
    };
    await sync();
    expect(await rows()).toEqual([]);
  });

  it("gives a shared plan one row while active or with live licences, else marks it to stop", async () => {
    await plan({
      id: "plan-shared",
      slug: "starter",
      kind: "starter",
      access: "shared",
    });
    await sync();
    expect(await rows()).toEqual([
      expect.objectContaining({
        kind: "shared",
        name: "starter",
        plan_id: "plan-shared",
        holder_address: null,
      }),
    ]);
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "l1",
    });
    await updatePlan(
      h.db,
      "plan-shared",
      { status: "retired" },
      "2026-10-03T00:00:00.000Z",
    );
    await sync();
    expect((await rows())[0].stop_reason).toBeNull();
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "REVOKED" })
      .where("license_id", "=", "l1")
      .execute();
    await sync();
    expect((await rows())[0].stop_reason).toBe(PLAN_RETIRED);
  });

  it("keeps an existing row's target when the plan's moves; a new chain starts on the new target (slice 3: rollouts move rows)", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    await seedRelease(h, appId, {
      version: "1.4.1",
      run: 110,
      kind: "release",
      digest: digest("c"),
    });
    await updatePlan(
      h.db,
      "plan-own",
      { target_version: "1.4.1" },
      "2026-10-04T00:00:00.000Z",
    );
    await sync();
    expect((await rows())[0]).toMatchObject({
      licence_root_id: "l1",
      target_version: "1.4.0",
      target_digest: digest("b"),
    });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: "0x3333333333333333333333333333333333333333",
      licenseId: "l3",
    });
    await sync();
    expect(
      (await rows()).find((r) => r.licence_root_id === "l3"),
    ).toMatchObject({
      target_version: "1.4.1",
      target_digest: digest("c"),
    });
  });

  it("keeps a shared row's target when the plan's moves", async () => {
    await plan({
      id: "plan-shared",
      slug: "starter",
      kind: "starter",
      access: "shared",
    });
    await sync();
    await seedRelease(h, appId, {
      version: "1.4.1",
      run: 110,
      kind: "release",
      digest: digest("c"),
    });
    await updatePlan(
      h.db,
      "plan-shared",
      { target_version: "1.4.1" },
      "2026-10-04T00:00:00.000Z",
    );
    await sync();
    expect((await rows())[0]).toMatchObject({
      kind: "shared",
      target_version: "1.4.0",
    });
  });
  // Ruling (cross-kind upgrades): once a chain held a plan kind, the plan model owns it.
  it("keeps serving a chain upgraded from an own plan's kind to a kind no plan adopted", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await sync();
    const before = (await rows())[0];
    await seedLicence(h, {
      appId,
      kind: "enterprise",
      holder: HOLDER,
      licenseId: "l2",
      root: "l1",
    });
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "l1")
      .execute();
    await sync();
    h.advance(15 * DAY);
    await sync();
    expect(await rows()).toEqual([
      expect.objectContaining({
        id: before.id,
        kind: "own",
        name: ownInstanceName("l1"),
        plan_id: "plan-own",
        holder_address: HOLDER,
        licence_root_id: "l1",
        target_size: "VETRA_AGENT_M",
        licence_ended_at: null,
        stop_reason: null,
      }),
    ]);
  });

  it("serves a non-plan head under its chain's most recent plan kind, and only an own plan's", async () => {
    await plan();
    await plan({
      id: "plan-shared",
      slug: "starter",
      kind: "starter",
      access: "shared",
    });
    // Own kind, then shared kind, then no plan's kind: the shared plan was the last; no own row.
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "a1",
    });
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "a2",
      root: "a1",
      status: "EXPIRED",
    });
    await seedLicence(h, {
      appId,
      kind: "enterprise",
      holder: HOLDER,
      licenseId: "a3",
      root: "a1",
    });
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "a1")
      .execute();
    // Never held a plan kind: no row.
    await seedLicence(h, {
      appId,
      kind: "enterprise",
      holder: HOLDER,
      licenseId: "b1",
    });
    // Untyped head after an own plan's kind: served.
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "c1",
      status: "EXPIRED",
    });
    await seedLicence(h, {
      appId,
      kind: null,
      holder: HOLDER,
      licenseId: "c2",
      root: "c1",
    });
    await sync();
    expect((await rows()).map((r) => [r.kind, r.licence_root_id])).toEqual([
      ["shared", null],
      ["own", "c1"],
    ]);
  });

  it("ignores a chain's grants newer than its live head (issued, not yet active)", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "enterprise",
      holder: HOLDER,
      licenseId: "d1",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "d2",
      root: "d1",
      status: "ISSUED",
      createdAt: "2026-10-05T00:00:00.000Z",
    });
    await sync();
    expect(await rows()).toEqual([]);
  });
});

const SERVICE = "0x9999999999999999999999999999999999999999";

describe("reconcileInstancesOnce — plan instances", () => {
  beforeEach(() => {
    h.deps.serviceOwner = SERVICE;
  });
  // main's release also makes a branch instance: plan rows only.
  const planRows = async () =>
    (await rows()).filter((r) => r.kind === "shared" || r.kind === "own");
  const env = async () =>
    (await h.envs.getState((await planRows())[0].environment_id!))!;

  it("creates an own instance as a PLAN environment owned by Vetra, sized, with the holder as admin, then ready", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    const state = await env();
    expect(state.app).toMatchObject({ appId, role: "PLAN", gitRef: null });
    expect(state.owner).toBe(SERVICE);
    expect(state.ownerOrgId ?? null).toBeNull();
    expect(state.services.find((s) => s.type === "FUSION")).toMatchObject({
      selectedRessource: "VETRA_AGENT_M",
      version: `1.4.0@${digest("b")}`,
    });
    expect(state.fusion!.env.find((e) => e.name === "ADMINS")!.value).toBe(
      HOLDER,
    );
    h.envs.setStatus((await planRows())[0].environment_id!, "READY");
    await reconcileInstancesOnce(h.deps);
    expect((await planRows())[0]).toMatchObject({
      status: "ready",
      running_version: "1.4.0",
    });
  });

  it("gives a shared instance the App owner as admin", async () => {
    await plan({
      id: "plan-shared",
      slug: "starter",
      kind: "starter",
      access: "shared",
    });
    await reconcileInstancesOnce(h.deps);
    expect(
      (await env()).fusion!.env.find((e) => e.name === "ADMINS")!.value,
    ).toBe(OWNER);
  });

  it("does nothing for plans while VETRA_APPS_PLANS is off", async () => {
    await h.close();
    h = await makeHarness(testConfig());
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
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    expect(await planRows()).toEqual([]);
  });

  it("holds an ended licence's instance after the window (never sleeps it) and releases it on renewal", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    const envId = (await planRows())[0].environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "l1")
      .execute();
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("READY");
    expect(await getHold(h.db, envId)).toBeNull();
    h.advance(15 * DAY);
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).not.toBe("STOPPED");
    expect(await getHold(h.db, envId)).toMatchObject({ reason: LICENCE_ENDED });
    // no pod recorded for the tenant: nothing runs
    expect((await planRows())[0]).toMatchObject({
      status: "stopped",
      reason: LICENCE_ENDED,
      stopped_by_vetra: true,
    });
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1b",
      root: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toBeNull();
    expect((await planRows())[0]).toMatchObject({
      status: "updating",
      stopped_by_vetra: false,
    });
  });

  it("never touches a licensed environment's chain, nor deletes a plan instance", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await reconcileInstancesOnce(h.deps);
    expect(await planRows()).toEqual([]);
    const roles = [...h.envs.docs.values()].map(
      (d) => d.state.global.app?.role ?? null,
    );
    expect(roles).not.toContain("PLAN");
    expect(h.envs.deleted).toEqual([]);
  });

  const setGlobal = (id: string, over: Partial<VetraCloudEnvironmentState>) => {
    const doc = h.envs.docs.get(id)!;
    h.envs.docs.set(id, {
      ...doc,
      state: { ...doc.state, global: { ...doc.state.global, ...over } },
    });
  };
  /** A READY own instance of l1, its licence ended past the window. */
  const readyThenDue = async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    const envId = (await planRows())[0].environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    await h.deps
      .licensingDb!.updateTable("license_lifecycle")
      .set({ status: "EXPIRED" })
      .where("license_id", "=", "l1")
      .execute();
    await syncPlanInstances(h.deps, (await getApp(h.db, appId))!); // notices the end
    h.advance(15 * DAY);
    return envId;
  };
  const renew = () =>
    seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1b",
      root: "l1",
    });

  it("never recreates a plan instance's environment for settings: it fails with a reason", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    const envId = (await planRows())[0].environment_id!;
    h.envs.setStatus(envId, "READY");
    const state = (await h.envs.getState(envId))!;
    setGlobal(envId, {
      fusion: {
        ...state.fusion!,
        env: state.fusion!.env.filter((e) => !e.isSecret),
      },
    });
    await reconcileInstancesOnce(h.deps);
    expect(h.envs.deleted).toEqual([]);
    expect(h.envs.docs.has(envId)).toBe(true);
    expect((await planRows())[0]).toMatchObject({
      environment_id: envId,
      status: "failed",
      reason: PLAN_NEEDS_NEW_SECRETS,
    });
  });

  it("releases on renewal even when a crash came between holding and its render", async () => {
    const envId = await readyThenDue();
    const real = h.deps.envs;
    h.deps.envs = Object.assign(Object.create(real) as typeof real, {
      execute: async (
        id: string,
        actions: Parameters<typeof real.execute>[1],
      ) => {
        if (actions.some((a) => a.type === "SET_LABEL"))
          throw new Error("crashed after holding");
        return real.execute(id, actions);
      },
    });
    await reconcileInstancesOnce(h.deps);
    h.deps.envs = real;
    expect(await getHold(h.db, envId)).not.toBeNull();
    await renew();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).toBeNull();
    expect((await h.envs.getState(envId))!.status).not.toBe("STOPPED");
    expect((await planRows())[0]).toMatchObject({
      status: "updating",
      stopped_by_vetra: false,
    });
  });

  it("never wakes an instance someone else slept, even after renewal (H10)", async () => {
    const envId = await readyThenDue();
    h.envs.setStatus(envId, "STOPPED");
    await reconcileInstancesOnce(h.deps);
    expect((await planRows())[0]).toMatchObject({
      status: "stopped",
      reason: LICENCE_ENDED,
    });
    expect((await planRows())[0].stopped_by_vetra).not.toBe(true);
    await renew();
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("STOPPED");
    expect((await planRows())[0]).toMatchObject({
      status: "stopped",
      reason: STOPPED_OUTSIDE_VETRA,
    });
    expect((await planRows())[0].stopped_by_vetra).not.toBe(true);
  });

  it("shows a running instance someone else slept as stopped outside Vetra, without marking or waking it", async () => {
    await plan();
    await seedLicence(h, {
      appId,
      kind: "pro",
      holder: HOLDER,
      licenseId: "l1",
    });
    await reconcileInstancesOnce(h.deps);
    const envId = (await planRows())[0].environment_id!;
    h.envs.setStatus(envId, "READY");
    await reconcileInstancesOnce(h.deps);
    h.envs.setStatus(envId, "STOPPED");
    await reconcileInstancesOnce(h.deps);
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("STOPPED");
    expect((await planRows())[0]).toMatchObject({
      status: "stopped",
      reason: STOPPED_OUTSIDE_VETRA,
    });
    expect((await planRows())[0].stopped_by_vetra).not.toBe(true);
  });

  it("approves a leftover CHANGES_PENDING before stopping", async () => {
    const envId = await readyThenDue();
    h.envs.setStatus(envId, "CHANGES_PENDING");
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("CHANGES_APPROVED");
    expect((await planRows())[0].stop_reason).toBe(LICENCE_ENDED);
  });

  it("neither holds nor releases an environment that is not a PLAN instance", async () => {
    const envId = await readyThenDue();
    const state = (await h.envs.getState(envId))!;
    setGlobal(envId, { app: { ...state.app!, role: "PRODUCTION" } });
    await reconcileInstancesOnce(h.deps);
    expect((await h.envs.getState(envId))!.status).toBe("READY");
    expect(await getHold(h.db, envId)).toBeNull();
    expect((await planRows())[0].stopped_by_vetra).not.toBe(true);
    // One Vetra held is not released either once it is no PLAN.
    setGlobal(envId, { app: state.app!, status: "READY" });
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).not.toBeNull();
    setGlobal(envId, { app: { ...state.app!, role: "PRODUCTION" }, status: "READY" });
    await renew();
    await reconcileInstancesOnce(h.deps);
    expect(await getHold(h.db, envId)).not.toBeNull();
  });
});
