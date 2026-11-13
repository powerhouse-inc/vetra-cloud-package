import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import {
  becomeReady,
  HOLDER_A,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { getApp } from "../repo.js";
import { rollBackRollout } from "../rollouts/controls.js";
import { pinInstance, unpinInstance } from "../rollouts/pins.js";
import { stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { checkRolloutFor, startRollout } from "../rollouts/service.js";

let h: Harness;
let appId: string;
beforeEach(async () => {
  ({ h, appId } = await rolloutHarness());
  await seedPlan(h, appId, { id: "p-pro", slug: "pro", access: "own" });
  await readyInstance(h, appId, {
    id: "o1",
    planId: "p-pro",
    kind: "own",
    holder: HOLDER_A,
  });
  // A warm-pool row of the same plan: no holder, no chain.
  await readyInstance(h, appId, { id: "w1", planId: "p-pro", kind: "own" });
  await h.db
    .updateTable("instances")
    .set({ warm: true, licence_root_id: null })
    .where("id", "=", "w1")
    .execute();
});
afterEach(async () => {
  await h.close();
});

const advance = async () =>
  advanceRollouts(h.deps, (await getApp(h.db, appId))!);

describe("warm rows and rollouts", () => {
  it("a rollout check and a rollout list only the holder's instance", async () => {
    const check = await checkRolloutFor(h.deps, owner, appId, "1.4.1", [
      "p-pro",
    ]);
    expect(check.steps.map((s) => s.instanceId)).toEqual(["o1"]);
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro"],
      noticeHours: 0,
    });
    expect((await stepsOf(h.db, r.id)).map((s) => s.instance_id)).toEqual([
      "o1",
    ]);
  });

  it("a rollback never steps a warm row that sits on the new release", async () => {
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro"],
      noticeHours: 0,
    });
    await advance();
    await becomeReady(h, "o1");
    await advance();
    await h.db
      .updateTable("instances")
      .set({ target_version: "1.4.1" })
      .where("id", "=", "w1")
      .execute();
    await rollBackRollout(h.deps, owner, r.id);
    expect((await stepsOf(h.db, r.id)).map((s) => s.instance_id)).toEqual([
      "o1",
    ]);
  });

  it("a warm instance is neither pinned nor unpinned", async () => {
    await expect(pinInstance(h.deps, owner, "w1", "1.4.1")).rejects.toThrow(
      "A warm instance has no holder yet; it is not pinned",
    );
    await expect(unpinInstance(h.deps, owner, "w1")).rejects.toThrow(
      "not pinned",
    );
  });
});
