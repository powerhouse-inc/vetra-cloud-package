import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, stranger, type Harness } from "./harness.js";
import {
  code,
  HOLDER_A,
  HOLDER_B,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getPlan } from "../plans/repo.js";
import { setPlanTarget } from "../plans/service.js";
import { stepsOf } from "../rollouts/repo.js";
import { checkRolloutFor, startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, {
    id: "p-starter",
    slug: "starter",
    access: "shared",
    notice_hours: 72,
  });
  await seedPlan(h, appId, {
    id: "p-pro",
    slug: "pro",
    access: "own",
    notice_hours: 72,
  });
  await readyInstance(h, appId, {
    id: "s1",
    planId: "p-starter",
    kind: "shared",
  });
  await readyInstance(h, appId, {
    id: "o2",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_B,
    createdAt: "2026-10-01T00:00:02.000Z",
  });
  await readyInstance(h, appId, {
    id: "o1",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_A,
    createdAt: "2026-10-01T00:00:01.000Z",
  });
  await readyInstance(h, appId, {
    id: "o3",
    planId: "p-pro",
    kind: "own",
    createdAt: "2026-10-01T00:00:03.000Z",
  });
  await h.db
    .updateTable("instances")
    .set({ pinned_version: "1.4.0" })
    .where("id", "=", "o3")
    .execute();
});
afterEach(async () => {
  await h.close();
});

describe("starting a rollout (spec 7 steps 1 and 3)", () => {
  it("plans steps shared first, then own by age, skips pinned ones with a note, moves the plans' targets, never an instance's", async () => {
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro", "p-starter"],
      noticeHours: 2,
    });
    expect(r).toMatchObject({
      version: "1.4.1",
      status: "active",
      direction: "forward",
      source: "api",
      startedBy: owner.address,
    });
    const steps = await stepsOf(h.db, r.id);
    expect(steps.map((s) => [s.instance_id, s.status, s.note])).toEqual([
      ["s1", "pending", null],
      ["o1", "pending", null],
      ["o2", "pending", null],
      ["o3", "skipped", "pinned at 1.4.0"],
    ]);
    expect(Date.parse(steps[0].due_at) - Date.parse(r.startedAt)).toBe(
      2 * 3_600_000,
    );
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.1");
    expect((await getPlan(h.db, "p-starter"))?.target_version).toBe("1.4.1");
    expect((await instance(h, "o1")).target_version).toBe("1.4.0");
    const actions = (await listAudit(h.db, appId, { limit: 20 })).map(
      (a) => a.action,
    );
    expect(actions.filter((a) => a === "plan.target_set")).toHaveLength(2);
    expect(actions).toContain("rollout.started");
  });

  it("refuses before anything moves: builds, unknown and withdrawn releases, sizes, older versions, a plan in an open rollout, retired plans, strangers", async () => {
    const start = (version: string, planIds = ["p-pro"]) =>
      startRollout(h.deps, owner, { appId, version, planIds });
    await expect(start("9.9.9")).rejects.toThrow(/no release 9.9.9/);
    await h.db
      .updateTable("releases")
      .set({ withdrawn_at: "2026-10-02T00:00:00.000Z" })
      .where("version", "=", "2.0.0")
      .execute();
    await expect(start("2.0.0")).rejects.toThrow(/withdrawn/);
    await h.db
      .updateTable("releases")
      .set({ requires: '{"size":"XL"}' })
      .where("version", "=", "1.5.0")
      .execute();
    await expect(start("1.5.0")).rejects.toThrow(/needs size XL/);
    await h.db
      .updateTable("plans")
      .set({ target_version: "1.4.1" })
      .where("id", "=", "p-pro")
      .execute();
    await expect(start("1.4.0")).rejects.toThrow(/older than pro's target/);
    await h.db
      .updateTable("plans")
      .set({ target_version: "1.4.0" })
      .where("id", "=", "p-pro")
      .execute();
    await start("1.4.1");
    await expect(start("1.4.1")).rejects.toThrow(/in the rollout of 1.4.1/);
    await h.db
      .updateTable("plans")
      .set({ status: "retired" })
      .where("id", "=", "p-starter")
      .execute();
    await expect(start("1.4.1", ["p-starter"])).rejects.toThrow(/retired/);
    await expect(
      startRollout(h.deps, stranger, {
        appId,
        version: "1.4.1",
        planIds: ["p-pro"],
      }),
    ).rejects.toMatchObject(code("FORBIDDEN"));
    await expect(start("1.4.1", ["nope"])).rejects.toMatchObject(
      code("NOT_FOUND"),
    );
  });

  it("needs health enforce to move instances", async () => {
    h.deps.cfg.instances.health = {
      ...h.deps.cfg.instances.health!,
      mode: "report",
    };
    await expect(
      startRollout(h.deps, owner, {
        appId,
        version: "1.4.1",
        planIds: ["p-pro"],
      }),
    ).rejects.toThrow(/enforce/);
  });

  it("previews steps and problems without writing", async () => {
    const c = await checkRolloutFor(h.deps, owner, appId, "1.4.1", [
      "p-starter",
      "p-pro",
    ]);
    expect(c.ok).toBe(true);
    expect(c.steps.map((s) => [s.instanceId, s.status])).toEqual([
      ["s1", "pending"],
      ["o1", "pending"],
      ["o2", "pending"],
      ["o3", "skipped"],
    ]);
    const bad = await checkRolloutFor(h.deps, owner, appId, "9.9.9", ["p-pro"]);
    expect(bad).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/no release/)],
    });
    expect(await stepsOf(h.db, "any")).toEqual([]);
    expect((await getPlan(h.db, "p-pro"))?.target_version).toBe("1.4.0");
  });

  it("setPlanTarget starts a rollout of one plan, and does nothing when nothing is behind", async () => {
    const p = await setPlanTarget(h.deps, owner, "p-pro", "1.4.1");
    expect(p.targetVersion).toBe("1.4.1");
    const started = (await listAudit(h.db, appId, { limit: 20 })).filter(
      (a) => a.action === "rollout.started",
    );
    expect(started).toHaveLength(1);
    expect(JSON.parse(started[0].detail)).toMatchObject({
      version: "1.4.1",
      plans: ["pro"],
    });
    await h.db
      .updateTable("instances")
      .set({ target_version: "1.4.1" })
      .where("plan_id", "=", "p-pro")
      .execute();
    await h.db.updateTable("rollouts").set({ status: "complete" }).execute();
    await setPlanTarget(h.deps, owner, "p-pro", "1.4.1");
    expect(
      (await listAudit(h.db, appId, { limit: 20 })).filter(
        (a) => a.action === "rollout.started",
      ),
    ).toHaveLength(1);
  });

  it("never moves an instance that is ahead of the version back (pinned at 2.0.0, then unpinned)", async () => {
    await h.db
      .updateTable("instances")
      .set({ target_version: "2.0.0", pinned_version: "2.0.0" })
      .where("id", "=", "o1")
      .execute();
    await h.db
      .updateTable("instances")
      .set({ pinned_version: null })
      .where("id", "=", "o1")
      .execute();
    const check = await checkRolloutFor(h.deps, owner, appId, "1.5.0", [
      "p-pro",
    ]);
    expect(check.steps.map((s) => [s.instanceId, s.status, s.note])).toEqual([
      ["o1", "skipped", "ahead at 2.0.0"],
      ["o2", "pending", null],
      ["o3", "skipped", "pinned at 1.4.0"],
    ]);
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.5.0",
      planIds: ["p-pro"],
    });
    expect(
      (await stepsOf(h.db, r.id)).map((s) => [s.instance_id, s.status]),
    ).toEqual([
      ["o1", "skipped"],
      ["o2", "pending"],
      ["o3", "skipped"],
    ]);
  });
});
