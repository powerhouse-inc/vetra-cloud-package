import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import { HOLDER, poolHarness, seedWarm } from "./pool-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { claimWarmInstance, removeUnclaimedWarm } from "../plans/pool-repo.js";
import { ownInstanceName } from "../plans/sync.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await poolHarness());
});
afterEach(async () => {
  await h.close();
});

describe("claimWarmInstance", () => {
  const q = () => ({
    appId,
    planId: "p-pro",
    digest: digest("b"),
    targetSize: "VETRA_AGENT_M",
    holder: HOLDER,
    root: "l1",
    name: ownInstanceName("l1"),
    nowIso: h.deps.now().toISOString(),
  });

  it("claims the oldest ready warm row on the plan's digest and size, keeping id, host and environment; audited", async () => {
    const old = await seedWarm(h, appId, {
      created_at: "2026-11-11T00:00:00.000Z",
    });
    await seedWarm(h, appId);
    const got = await claimWarmInstance(h.db, q());
    expect(got).toMatchObject({
      id: old.id,
      host: old.host,
      environment_id: old.environment_id,
      warm: false,
      holder_address: HOLDER,
      licence_root_id: "l1",
      name: ownInstanceName("l1"),
    });
    expect(got?.claimed_at).toBeTruthy();
    const a = (await listAudit(h.db, appId, { limit: 5 })).find(
      (r) => r.action === "instance.claimed",
    );
    expect(a).toMatchObject({
      subject: `instance:${old.id}`,
      actor: "vetra",
      source: "system",
    });
  });

  it("never claims a row that is not ready, stale, resized, stopping, removed or another plan's", async () => {
    await seedWarm(h, appId, { status: "updating", running_digest: null });
    await seedWarm(h, appId, {
      target_digest: digest("a"),
      running_digest: digest("a"),
    });
    await seedWarm(h, appId, { target_size: "VETRA_AGENT_S" });
    await seedWarm(h, appId, { stop_reason: "x" });
    await seedWarm(h, appId, {
      removed_at: "2026-11-12T00:00:00.000Z",
      removed_reason: "warm pool: over the pool size",
    });
    await seedWarm(h, appId, { plan_id: "p-other" });
    await seedWarm(h, appId, { warm: false });
    expect(await claimWarmInstance(h.db, q())).toBeNull();
  });

  it("never claims an unhealthy row, and prefers a healthy one over an unchecked one", async () => {
    await seedWarm(h, appId, {
      health: "unhealthy",
      created_at: "2026-11-10T00:00:00.000Z",
    });
    expect(await claimWarmInstance(h.db, q())).toBeNull();
    const unchecked = await seedWarm(h, appId, {
      created_at: "2026-11-11T00:00:00.000Z",
    });
    const healthy = await seedWarm(h, appId, { health: "healthy" });
    expect((await claimWarmInstance(h.db, q()))?.id).toBe(healthy.id);
    expect(
      (
        await claimWarmInstance(h.db, {
          ...q(),
          holder: "0x2222222222222222222222222222222222222222",
          root: "l2",
          name: ownInstanceName("l2"),
        })
      )?.id,
    ).toBe(unchecked.id);
  });

  it("two concurrent claims never take the same row", async () => {
    await seedWarm(h, appId);
    const [a, b] = await Promise.all([
      claimWarmInstance(h.db, q()),
      claimWarmInstance(h.db, {
        ...q(),
        holder: "0x2222222222222222222222222222222222222222",
        root: "l2",
        name: ownInstanceName("l2"),
      }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("removeUnclaimedWarm", () => {
  const NOW = "2026-11-13T00:00:00.000Z";
  it("marks an unclaimed warm row removed", async () => {
    const w = await seedWarm(h, appId);
    expect(await removeUnclaimedWarm(h.db, w.id, "why", NOW)).toBe(true);
    const row = await h.db
      .selectFrom("instances")
      .selectAll()
      .where("id", "=", w.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ removed_at: NOW, removed_reason: "why" });
  });

  it("never touches a row claimed after it was read as warm", async () => {
    const w = await seedWarm(h, appId, {
      warm: false,
      holder_address: HOLDER,
    });
    expect(await removeUnclaimedWarm(h.db, w.id, "why", NOW)).toBe(false);
    const row = await h.db
      .selectFrom("instances")
      .selectAll()
      .where("id", "=", w.id)
      .executeTakeFirstOrThrow();
    expect(row.removed_at).toBeNull();
  });
});
