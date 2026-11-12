import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import {
  becomeReady,
  failUpdate,
  HOLDER_A,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { instanceHealth } from "../config.js";
import { getPlan } from "../plans/repo.js";
import { getApp } from "../repo.js";
import { getRollout, stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import {
  rollBackRollout,
  retryRolloutStep,
  skipRolloutStep,
} from "../rollouts/controls.js";

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
  });
});
afterEach(async () => {
  await h.close();
});

const advance = async () =>
  advanceRollouts(h.deps, (await getApp(h.db, appId))!);
const statuses = async (id: string) =>
  (await stepsOf(h.db, id)).map((s) => `${s.instance_id}:${s.status}`);

async function completed() {
  const r = await startRollout(h.deps, owner, {
    appId,
    version: "1.4.1",
    planIds: ["p-starter", "p-pro"],
    noticeHours: 0,
  });
  await advance();
  await becomeReady(h, "s1");
  await advance();
  await becomeReady(h, "o1");
  await advance();
  expect((await getRollout(h.db, r.id))?.status).toBe("complete");
  return r;
}

describe("rolling back (spec section 7, image swap)", () => {
  it("sets the plans' targets back and returns instances one at a time, own first, including one that joined on the new release", async () => {
    const r = await completed();
    await readyInstance(h, appId, {
      id: "o9",
      planId: "p-pro",
      kind: "own",
      version: "1.4.1",
      createdAt: "2026-10-05T00:00:00.000Z",
    });
    await rollBackRollout(h.deps, owner, r.id);
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.0");
    expect((await getPlan(h.db, "p-starter"))?.target_version).toBe("1.4.0");
    expect(await getRollout(h.db, r.id)).toMatchObject({
      direction: "back",
      status: "active",
      rolled_back_by: owner.address,
    });
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:revert_pending",
      "o1:revert_pending",
      "o9:reverting",
    ]);
    expect((await instance(h, "o9")).target_version).toBe("1.4.0");
    await becomeReady(h, "o9");
    await advance();
    await becomeReady(h, "o1");
    await advance();
    await becomeReady(h, "s1");
    await advance();
    expect(await statuses(r.id)).toEqual([
      "s1:rolled_back",
      "o1:rolled_back",
      "o9:rolled_back",
    ]);
    expect((await getRollout(h.db, r.id))?.status).toBe("rolled_back");
  });

  it("refuses a release that migrates, a plan that moved on, and a second rollback", async () => {
    const r = await completed();
    await h.db
      .updateTable("releases")
      .set({ migrates: true })
      .where("version", "=", "1.4.1")
      .execute();
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(
      /migrates/,
    );
    await h.db
      .updateTable("releases")
      .set({ migrates: false })
      .where("version", "=", "1.4.1")
      .execute();
    await h.db
      .updateTable("plans")
      .set({ target_version: "1.5.0" })
      .where("id", "=", "p-pro")
      .execute();
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(
      /pro has moved on to 1.5.0/,
    );
    await h.db
      .updateTable("plans")
      .set({ target_version: "1.4.1" })
      .where("id", "=", "p-pro")
      .execute();
    await rollBackRollout(h.deps, owner, r.id);
    await expect(rollBackRollout(h.deps, owner, r.id)).rejects.toThrow(
      /already rolled back/,
    );
  });

  it("a failed way back pauses; retry tries it again", async () => {
    const r = await completed();
    await rollBackRollout(h.deps, owner, r.id);
    await advance();
    await failUpdate(h, "o1", "unhealthy (crash)");
    await advance();
    expect(
      (await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")?.status,
    ).toBe("revert_failed");
    expect((await getRollout(h.db, r.id))?.status).toBe("paused");
    await retryRolloutStep(
      h.deps,
      owner,
      (await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")!.id,
    );
    await advance();
    expect(
      (await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")?.status,
    ).toBe("reverting");
  });

  it("skipping a failed way back leaves the instance on the new release (and stops retrying the old one)", async () => {
    const r = await completed();
    await rollBackRollout(h.deps, owner, r.id);
    await advance();
    await failUpdate(h, "o1", "unhealthy (crash)");
    await advance();
    const o1 = (await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1")!;
    await skipRolloutStep(h.deps, owner, o1.id);
    expect(
      (await stepsOf(h.db, r.id)).find((s) => s.instance_id === "o1"),
    ).toMatchObject({
      status: "skipped",
      note: "left on 1.4.1",
    });
    expect(await instance(h, "o1")).toMatchObject({
      target_version: "1.4.1",
      failed_digest: null,
    });
    expect((await getRollout(h.db, r.id))?.status).toBe("active");
  });

  it("rolls back a paused rollout: the failed step and a retried one go back, the rest never moves", async () => {
    await readyInstance(h, appId, {
      id: "o2",
      planId: "p-pro",
      kind: "own",
      createdAt: "2026-10-01T00:00:05.000Z",
    });
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro"],
      noticeHours: 0,
    });
    await advance();
    await failUpdate(h, "o1");
    await advance();
    expect((await getRollout(h.db, r.id))?.status).toBe("paused");
    await rollBackRollout(h.deps, owner, r.id);
    expect(await statuses(r.id)).toEqual(["o1:revert_pending", "o2:skipped"]);
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:reverting", "o2:skipped"]);
    expect(await instance(h, "o1")).toMatchObject({
      target_version: "1.4.0",
      failed_digest: null,
    });
    await becomeReady(h, "o1");
    await advance();
    expect(await statuses(r.id)).toEqual(["o1:rolled_back", "o2:skipped"]);
    expect((await getRollout(h.db, r.id))?.status).toBe("rolled_back");
  });

  it("a stopped instance gets its old target back without moving; a rollback runs in any health mode", async () => {
    const r = await completed();
    h.deps.cfg.instances = {
      ...h.deps.cfg.instances,
      health: { ...instanceHealth(h.deps.cfg), mode: "report" },
    };
    await h.db
      .updateTable("instances")
      .set({ stop_reason: "the licence ended", status: "stopped" })
      .where("id", "=", "o1")
      .execute();
    await rollBackRollout(h.deps, owner, r.id);
    await advance();
    expect(
      (await stepsOf(h.db, r.id)).map((s) => [s.instance_id, s.status, s.note]),
    ).toEqual([
      ["s1", "reverting", null],
      ["o1", "rolled_back", "stopped: back on 1.4.0 when it wakes"],
    ]);
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
  });
});
