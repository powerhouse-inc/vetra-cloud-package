import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner, type Harness } from "./harness.js";
import {
  code,
  HOLDER_A,
  instance,
  readyInstance,
  rolloutHarness,
  seedPlan,
} from "./rollouts-fixtures.js";
import { listAudit } from "../audit/repo.js";
import { getApp } from "../repo.js";
import { stepsOf } from "../rollouts/repo.js";
import { advanceRollouts } from "../rollouts/runner.js";
import { startRollout } from "../rollouts/service.js";
import { pinInstance, unpinInstance } from "../rollouts/pins.js";

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

describe("pinning (spec section 7)", () => {
  it("pins an own instance: its waiting step is skipped; the next rollout skips it; unpinning moves nothing", async () => {
    const r = await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro"],
      noticeHours: 5,
    });
    const pinned = await pinInstance(h.deps, owner, "o1", "1.4.0");
    expect(pinned).toMatchObject({
      pinnedVersion: "1.4.0",
      targetVersion: "1.4.0",
    });
    expect((await stepsOf(h.db, r.id))[0]).toMatchObject({
      status: "skipped",
      note: "pinned at 1.4.0",
    });
    const unpinned = await unpinInstance(h.deps, owner, "o1");
    expect(unpinned).toMatchObject({
      pinnedVersion: null,
      targetVersion: "1.4.0",
    });
    const actions = (await listAudit(h.db, appId, { limit: 50 })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(["instance.pinned", "instance.unpinned"]),
    );
  });

  it("pinning to another release moves the instance at once", async () => {
    expect(await pinInstance(h.deps, owner, "o1", "1.5.0")).toMatchObject({
      pinnedVersion: "1.5.0",
      targetVersion: "1.5.0",
    });
  });

  it("refuses shared instances, builds and withdrawn releases, and an instance whose update is moving", async () => {
    await expect(pinInstance(h.deps, owner, "s1", "1.4.0")).rejects.toThrow(
      /Only own instances/,
    );
    await h.db
      .updateTable("releases")
      .set({ withdrawn_at: "2026-10-02T00:00:00.000Z" })
      .where("version", "=", "2.0.0")
      .execute();
    await expect(pinInstance(h.deps, owner, "o1", "2.0.0")).rejects.toThrow(
      /withdrawn/,
    );
    await expect(
      pinInstance(h.deps, owner, "nope", "1.4.0"),
    ).rejects.toMatchObject(code("NOT_FOUND"));
    await startRollout(h.deps, owner, {
      appId,
      version: "1.4.1",
      planIds: ["p-pro"],
      noticeHours: 0,
    });
    await advanceRollouts(h.deps, (await getApp(h.db, appId))!);
    await expect(pinInstance(h.deps, owner, "o1", "1.4.0")).rejects.toThrow(
      /in progress/,
    );
    expect((await instance(h, "o1")).pinned_version ?? null).toBeNull();
  });
});
