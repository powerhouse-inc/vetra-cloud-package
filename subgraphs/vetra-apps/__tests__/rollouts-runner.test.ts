import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import { digest } from "./instances-fixtures.js";
import {
  becomeReady,
  failUpdate,
  HOLDER_A,
  HOLDER_B,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { instanceHealth } from "../config.js";
import { reconcileInstancesOnce } from "../instances/reconciler.js";
import { getApp } from "../repo.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, {
    id: "p-starter",
    slug: "starter",
    access: "shared",
  });
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, {
    id: "s1",
    planId: "p-starter",
    kind: "shared",
  });
  await readyInstance(h, appId, {
    id: "o1",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_A,
    createdAt: "2026-10-01T00:00:01.000Z",
  });
  await readyInstance(h, appId, {
    id: "o2",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_B,
    createdAt: "2026-10-01T00:00:02.000Z",
  });
});
afterEach(async () => {
  await h.close();
});

const advance = async () =>
  advanceRollouts(h.deps, (await getApp(h.db, appId))!);
const start = (
  planIds = ["p-starter", "p-pro"],
  noticeHours = 0,
  version = "1.4.1",
) => startRollout(h.deps, owner, { appId, version, planIds, noticeHours });
const statuses = async (id: string) =>
  (await stepsOf(h.db, id)).map((s) => `${s.instance_id}:${s.status}`);

describe("the rollout runner (spec 7 step 4)", () => {
  it("waits for the notice, then moves one instance at a time, shared first; a step succeeds only when ready on the target", async () => {
    const r = await start(undefined, 1);
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:pending",
      "o1:pending",
      "o2:pending",
    ]);
    h.advance(3_600_000);
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:applying",
      "o1:pending",
      "o2:pending",
    ]);
    expect(await instance(h, "s1")).toMatchObject({
      target_version: "1.4.1",
      target_digest: digest("c"),
    });
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:applying",
      "o1:pending",
      "o2:pending",
    ]);
    await becomeReady(h, "s1");
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:succeeded",
      "o1:applying",
      "o2:pending",
    ]);
    await becomeReady(h, "o1");
    await advance();
    await becomeReady(h, "o2");
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:succeeded",
      "o1:succeeded",
      "o2:succeeded",
    ]);
    expect((await getRollout(h.db, r.id))?.status).toBe("complete");
    expect(
      (await listAudit(h.db, appId, { limit: 50 })).map((a) => a.action),
    ).toContain("rollout.completed");
  });

  it("pauses on a failed update (the reconciler reverted it) with an alert row; nothing else starts", async () => {
    const r = await start();
    await advance();
    await becomeReady(h, "s1");
    await advance();
    await failUpdate(h, "o1");
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:succeeded",
      "o1:failed",
      "o2:pending",
    ]);
    expect(await getRollout(h.db, r.id)).toMatchObject({
      status: "paused",
      paused_reason: expect.stringMatching(/own-o1: unhealthy/),
    });
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:succeeded",
      "o1:failed",
      "o2:pending",
    ]);
    const alert = (await listAudit(h.db, appId, { limit: 50 })).find(
      (a) => a.action === "rollout.paused",
    )!;
    expect(JSON.parse(alert.detail)).toMatchObject({
      alert: true,
      instance: "own-o1",
    });
  });

  it("sends a step that times out back to its release and pauses", async () => {
    const r = await start(["p-pro"]);
    await advance();
    h.advance(31 * 60_000);
    await advance();
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/after 30 minutes/),
      target_moved: false,
    });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    expect((await getRollout(h.db, r.id))?.status).toBe("paused");
  });

  it("skips stopped instances (their target still moves) and instances pinned since the start", async () => {
    await h.db
      .updateTable("instances")
      .set({ stop_reason: "the licence ended", status: "stopped" })
      .where("id", "=", "o1")
      .execute();
    const r = await start(["p-pro"]);
    await h.db
      .updateTable("instances")
      .set({ pinned_version: "1.4.0" })
      .where("id", "=", "o2")
      .execute();
    await advance();
    expect(
      (await stepsOf(h.db, r.id)).map((s) => [s.instance_id, s.status, s.note]),
    ).toEqual([
      ["o1", "skipped", "stopped: updated when it wakes"],
      ["o2", "skipped", "pinned at 1.4.0"],
    ]);
    expect((await instance(h, "o1")).target_version).toBe("1.4.1");
    expect((await instance(h, "o2")).target_version).toBe("1.4.0");
    expect((await getRollout(h.db, r.id))?.status).toBe("complete");
  });

  it("holds steps outside the plan's update window", async () => {
    await h.db
      .updateTable("plans")
      .set({
        update_window: JSON.stringify({
          days: [6, 7],
          start: "00:00",
          end: "00:00",
          timeZone: "UTC",
        }),
      })
      .where("id", "=", "p-pro")
      .execute();
    const r = await start(["p-pro"]);
    await advance(); // Friday 2026-10-02
    expect(await statuses(r.id)).toEqual(["o1:pending", "o2:pending"]);
    h.clock.now = new Date("2026-10-03T00:00:01.000Z");
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:applying", "o2:pending"]);
  });

  it("starts nothing while held, but settles what moves", async () => {
    const r = await start(["p-pro"]);
    await advance();
    h.deps.cfg.plans = { enabled: true, stopAfterDays: 14, rolloutsHold: true };
    await becomeReady(h, "o1");
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:succeeded", "o2:pending"]);
  });

  it("runs inside the reconciler's pass", async () => {
    const r = await start(["p-starter"]);
    await reconcileInstancesOnce(h.deps);
    expect((await stepsOf(h.db, r.id))[0].status).toBe("applying");
    expect((await instance(h, "s1")).target_version).toBe("1.4.1");
  });

  it("starts no forward step unless instance health is enforced (decision R2), but settles what moves", async () => {
    const r = await start(["p-pro"]);
    await advance();
    h.deps.cfg.instances = {
      ...h.deps.cfg.instances,
      health: { ...instanceHealth(h.deps.cfg), mode: "report" },
    };
    await becomeReady(h, "o1");
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:succeeded", "o2:pending"]);
  });

  it("moves one instance per App across rollouts, oldest rollout first", async () => {
    const a = await start(["p-pro"]);
    const b = await start(["p-starter"]);
    await advance();
    await advance();
    expect([...(await statuses(a.id)), ...(await statuses(b.id))]).toEqual([
      "o1:applying",
      "o2:pending",
      "s1:pending",
    ]);
  });

  it("is idempotent: passes without a change in between change nothing", async () => {
    const r = await start(["p-pro"]);
    await advance();
    const before = await stepsOf(h.db, r.id);
    const audits = (await listAudit(h.db, appId, { limit: 100 })).length;
    await advance();
    await advance();
    expect(await stepsOf(h.db, r.id)).toEqual(before);
    expect((await listAudit(h.db, appId, { limit: 100 })).length).toBe(audits);
  });

  it("times out (fails closed) a moving step whose start does not parse", async () => {
    const r = await start(["p-pro"]);
    await advance();
    await h.db
      .updateTable("rollout_steps")
      .set({ started_at: "garbage" })
      .where("instance_id", "=", "o1")
      .execute();
    await advance();
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "failed",
      target_moved: false,
    });
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
  });

  it("a moving step of a cancelled rollout that fails goes back and is skipped; nothing pauses", async () => {
    const r = await start(["p-pro"]);
    await advance();
    await h.db
      .updateTable("rollouts")
      .set({ status: "cancelled" })
      .where("id", "=", r.id)
      .execute();
    await failUpdate(h, "o1");
    await advance();
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "skipped",
      target_moved: false,
      error: expect.stringMatching(/unhealthy/),
    });
    expect(await instance(h, "o1")).toMatchObject({
      target_version: "1.4.0",
      failed_digest: null,
    });
    expect((await getRollout(h.db, r.id))?.status).toBe("cancelled");
    expect(
      (await listAudit(h.db, appId, { limit: 50 })).map((a) => a.action),
    ).not.toContain("rollout.paused");
  });
});
