import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./harness.js";
import { seedLicence, seedLicensedEnvironment } from "./instances-fixtures.js";
import { HOLDER, poolHarness, seedWarm } from "./pool-fixtures.js";
import { listInstances } from "../instances/repo.js";
import { insertPlan } from "../plans/repo.js";
import { ownInstanceName, syncPlanInstances } from "../plans/sync.js";
import { getApp } from "../repo.js";

const noDigest = vi.hoisted(() => ({ on: false }));
vi.mock("../instances/targets.js", async (orig) => {
  const m = await orig<typeof import("../instances/targets.js")>();
  return {
    ...m,
    targetOf: (r: Parameters<typeof m.targetOf>[0]) => ({
      ...m.targetOf(r),
      ...(noDigest.on ? { target_digest: null } : {}),
    }),
  };
});

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await poolHarness());
});
afterEach(async () => {
  noDigest.on = false;
  await h.close();
});

const sync = async () =>
  syncPlanInstances(h.deps, (await getApp(h.db, appId))!);
const rows = () => listInstances(h.db, appId, "own");
const licence = (id = "l1") =>
  seedLicence(h, { appId, kind: "pro", holder: HOLDER, licenseId: id });

describe("syncPlanInstances with a warm pool", () => {
  it("a new chain claims the ready warm row: same id, host and environment; no second own row", async () => {
    const warm = await seedWarm(h, appId);
    await licence();
    await sync();
    await sync();
    expect(await rows()).toEqual([
      expect.objectContaining({
        id: warm.id,
        host: warm.host,
        environment_id: warm.environment_id,
        warm: false,
        holder_address: HOLDER,
        licence_root_id: "l1",
        name: ownInstanceName("l1"),
        stop_reason: null,
      }),
    ]);
  });

  it("no ready warm row: a cold row, as before", async () => {
    await seedWarm(h, appId, { status: "updating", running_digest: null });
    await licence();
    await sync();
    const own = await rows();
    expect(own).toHaveLength(2);
    const cold = own.find((r) => r.licence_root_id === "l1")!;
    expect(cold.warm).toBeFalsy();
    expect(cold).toMatchObject({ status: "pending", environment_id: null });
    expect(own.find((r) => r.warm)?.licence_root_id).toBeNull();
  });

  it("a chain with a licensed environment never claims", async () => {
    const warm = await seedWarm(h, appId);
    await licence();
    await seedLicensedEnvironment(h, { appId, root: "l1" });
    await sync();
    expect(await rows()).toEqual([
      expect.objectContaining({
        id: warm.id,
        warm: true,
        holder_address: null,
      }),
    ]);
  });

  it("a shared plan never claims", async () => {
    await insertPlan(h.db, {
      id: "p-shared",
      app_id: appId,
      slug: "starter",
      name: "Starter",
      kind: "starter",
      access: "shared",
      size: "VETRA_AGENT_M",
      target_version: "1.4.0",
      policy: "manual",
      notice_hours: 72,
      status: "active",
      created_by: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    const warm = await seedWarm(h, appId, { plan_id: "p-shared" });
    await seedLicence(h, {
      appId,
      kind: "starter",
      holder: HOLDER,
      licenseId: "l9",
    });
    await sync();
    const shared = await listInstances(h.db, appId, "shared");
    expect(shared).toEqual([
      expect.objectContaining({ plan_id: "p-shared", holder_address: null }),
    ]);
    expect(shared[0].id).not.toBe(warm.id);
    expect(await rows()).toEqual([
      expect.objectContaining({ id: warm.id, warm: true }),
    ]);
  });

  it("pool rows are never stopped as ended licences", async () => {
    await seedWarm(h, appId);
    await sync();
    h.advance(15 * 86_400_000);
    await sync();
    await sync();
    expect(await rows()).toEqual([
      expect.objectContaining({
        warm: true,
        stop_reason: null,
        licence_ended_at: null,
      }),
    ]);
  });

  it("a target without a digest never claims (and never throws): a cold row", async () => {
    await seedWarm(h, appId);
    await licence();
    noDigest.on = true;
    await sync();
    const own = await rows();
    expect(own).toHaveLength(2);
    expect(own.filter((r) => r.warm)).toHaveLength(1);
    expect(own.find((r) => !r.warm)?.holder_address).toBe(HOLDER);
  });
});
