import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER, STRANGER, type Harness } from "./harness.js";
import { poolHarness, seedWarm } from "./pool-fixtures.js";
import { insertPlan } from "../plans/repo.js";
import { createResolvers } from "../resolvers.js";
import { listAudit } from "../audit/repo.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await poolHarness());
});
afterEach(async () => {
  await h.close();
});

const ctx = (address: string) => ({
  user: { address, chainId: 1, networkId: "eip155" },
  headers: {},
});
const update = (warmPoolSize: number, planId = "p-pro", who = OWNER) =>
  createResolvers(h.deps).Mutation.updatePlan(
    null,
    { input: { planId, warmPoolSize } },
    ctx(who),
  );

describe("warm pool over GraphQL", () => {
  it("sets the pool size (audited) and reports the effective size, cost and ready count", async () => {
    await seedWarm(h, appId);
    const p = await update(2);
    expect(p).toMatchObject({
      warmPoolSize: 2,
      warmPoolEffective: 2,
      warmReady: 1,
    });
    expect(p.warmPoolEurPerMonth).toBeGreaterThan(0);
    const a = (await listAudit(h.db, appId, { limit: 5 })).find(
      (r) => r.action === "plan.updated",
    );
    const detail = JSON.parse(String(a?.detail));
    expect(detail.changes.warmPoolSize).toEqual({ from: 1, to: 2 });
    const plans = await createResolvers(h.deps).Query.appPlans(
      null,
      { appId },
      ctx(OWNER),
    );
    expect(plans[0]).toMatchObject({ warmPoolSize: 2, warmReady: 1 });
  });

  it("caps the effective size at VETRA_APPS_PLAN_POOL_MAX", async () => {
    const p = await update(5);
    expect(p).toMatchObject({ warmPoolSize: 5, warmPoolEffective: 2 });
  });

  it("refuses more than 10, a shared plan, and a stranger", async () => {
    await expect(update(11)).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
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
      created_by: OWNER,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    });
    await expect(update(1, "p-shared")).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT" },
    });
    await expect(update(1, "p-pro", STRANGER)).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });

  it("shows a warm instance with no holder", async () => {
    const warm = await seedWarm(h, appId);
    const list = await createResolvers(h.deps).Query.appInstances(
      null,
      { appId },
      ctx(OWNER),
    );
    expect(list.find((i: { id: string }) => i.id === warm.id)).toMatchObject({
      warm: true,
      holder: null,
      claimedAt: null,
    });
  });
});
